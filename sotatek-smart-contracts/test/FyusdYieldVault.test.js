/**
 * FyusdYieldVault (vFYUSD) + adapter tests.
 *
 * Verifies (per ADR-006 + PHASE1_SPEC §3.4):
 *   - MockConcreteAdapter accrues simulated yield over time;
 *     totalAssets grows past principal as time elapses.
 *   - ERC4626 deposit pulls FYUSD, forwards to adapter, mints user vFYUSD
 *     1:1 with adapter shares; per-share NAV grows with adapter yield.
 *   - cooldownAssets/cooldownShares burn vFYUSD, withdraw FYUSD from
 *     adapter, escrow in silo, queue cooldown.
 *   - unstake releases the escrowed FYUSD only after cooldownEnd;
 *     duration is read live from SettingManagement so admin can tune it.
 *   - Direct withdraw / redeem revert (cooldown is the only exit).
 *   - pause() blocks deposit / cooldown / unstake; only admin unpauses.
 *   - setAdapter is admin-only and rejects mismatched-asset adapters.
 *   - ConcreteAdapterV1 stub reverts NotImplemented for any state-changing
 *     call (fail-loud guard against accidental BSC deploy).
 */
const assert = require("node:assert/strict");
const { ethers, upgrades, network } = require("hardhat");

const ONE = 10n ** 18n;
const ONE_YEAR = 365n * 24n * 60n * 60n;
const SEVEN_DAYS = 7n * 24n * 60n * 60n;

async function increaseTime(seconds) {
  await network.provider.send("evm_increaseTime", [Number(seconds)]);
  await network.provider.send("evm_mine", []);
}

async function deployFixture(apyBps = 400n) {
  const [deployer, alice, bob, pauser, nonAdmin] = await ethers.getSigners();

  const SettingManagement = await ethers.getContractFactory("SettingManagement");
  const setting = await upgrades.deployProxy(SettingManagement, [deployer.address], {
    initializer: "initialize", kind: "transparent",
  });
  // Default cooldown = 7 days. Stored in pool config so admin can tune it later.
  await (await setting.setPoolConfigs("vFyusdCooldown", SEVEN_DAYS)).wait();

  const FYUSD = await ethers.getContractFactory("FYUSD");
  const fyusd = await upgrades.deployProxy(FYUSD, [deployer.address], {
    initializer: "initialize", kind: "transparent",
  });
  await (await fyusd.setMinter(deployer.address)).wait();

  const MockAdapter = await ethers.getContractFactory("MockConcreteAdapter");
  const adapter = await MockAdapter.deploy(await fyusd.getAddress(), apyBps);

  const Vault = await ethers.getContractFactory("FyusdYieldVault");
  const vault = await upgrades.deployProxy(Vault, [
    await setting.getAddress(),
    await fyusd.getAddress(),
    await adapter.getAddress(),
    deployer.address,
  ], { initializer: "initialize", kind: "transparent" });

  await (await vault.setPauserRole(pauser.address)).wait();

  for (const u of [alice, bob]) {
    await (await fyusd.mint(u.address, 10_000n * ONE)).wait();
    await (await fyusd.connect(u).approve(await vault.getAddress(), ethers.MaxUint256)).wait();
  }

  // Pre-fund the adapter with FYUSD to cover simulated yield withdrawals.
  await (await fyusd.mint(deployer.address, 1_000_000n * ONE)).wait();
  await (await fyusd.approve(await adapter.getAddress(), ethers.MaxUint256)).wait();
  await (await adapter.fundYield(1_000_000n * ONE)).wait();

  return { deployer, alice, bob, pauser, nonAdmin, setting, fyusd, adapter, vault };
}

describe("MockConcreteAdapter", () => {
  it("accrues simulated yield over time (totalAssets > principal)", async () => {
    const { alice, fyusd, adapter } = await deployFixture(400n);
    await (await fyusd.connect(alice).approve(await adapter.getAddress(), ethers.MaxUint256)).wait();
    await (await adapter.connect(alice).deposit(1_000n * ONE)).wait();

    const before = await adapter.totalAssets();
    await increaseTime(ONE_YEAR / 2n);
    const after = await adapter.totalAssets();
    const delta = after - before;
    assert.ok(delta > 19n * ONE && delta < 21n * ONE, `unexpected accrual delta: ${delta}`);
  });
});

describe("FyusdYieldVault (vFYUSD ERC4626)", () => {
  describe("deposit", () => {
    it("deposit pulls FYUSD, forwards to adapter, mints vFYUSD 1:1 initially", async () => {
      const { alice, fyusd, adapter, vault } = await deployFixture();
      const aliceBefore = await fyusd.balanceOf(alice.address);
      await (await vault.connect(alice).deposit(500n * ONE, alice.address)).wait();
      assert.equal(await fyusd.balanceOf(alice.address), aliceBefore - 500n * ONE);
      assert.equal(await vault.balanceOf(alice.address), 500n * ONE);
      assert.equal(await vault.totalSupply(), 500n * ONE);
      // Vault holds 0 active FYUSD — it's all in the adapter.
      assert.equal(await fyusd.balanceOf(await vault.getAddress()), 0n);
      assert.equal(await adapter.shareOf(await vault.getAddress()), 500n * ONE);
    });

    it("vFYUSD has correct ERC20 metadata", async () => {
      const { vault } = await deployFixture();
      assert.equal(await vault.name(), "Vault FYUSD");
      assert.equal(await vault.symbol(), "vFYUSD");
      assert.equal(await vault.decimals(), 18n);
    });

    it("per-share NAV grows with adapter yield (totalAssets reflects adapter)", async () => {
      const { alice, vault } = await deployFixture(400n);
      await (await vault.connect(alice).deposit(1_000n * ONE, alice.address)).wait();
      const navBefore = await vault.convertToAssets(ONE);
      await increaseTime(ONE_YEAR / 2n);
      const navAfter = await vault.convertToAssets(ONE);
      assert.ok(navAfter > navBefore, "vFYUSD NAV should grow with adapter yield");
    });
  });

  describe("cooldown / unstake", () => {
    it("cooldownAssets burns shares, escrows in silo, queues cooldown", async () => {
      const { alice, fyusd, vault } = await deployFixture();
      await (await vault.connect(alice).deposit(500n * ONE, alice.address)).wait();
      const siloAddr = await vault.silo();

      await (await vault.connect(alice).cooldownAssets(200n * ONE)).wait();
      // vFYUSD shares burned proportionally.
      assert.ok((await vault.balanceOf(alice.address)) < 500n * ONE);
      // FYUSD now held in the silo, not the vault.
      assert.equal(await fyusd.balanceOf(siloAddr), 200n * ONE);
      const cd = await vault.cooldowns(alice.address);
      assert.equal(cd.underlyingAmount, 200n * ONE);
      assert.ok(cd.cooldownEnd > 0n);
    });

    it("unstake fails before cooldownEnd, succeeds after", async () => {
      const { alice, fyusd, vault } = await deployFixture();
      await (await vault.connect(alice).deposit(500n * ONE, alice.address)).wait();
      await (await vault.connect(alice).cooldownAssets(200n * ONE)).wait();

      await assert.rejects(
        vault.connect(alice).unstake(alice.address),
        (err) => err.message.includes("CooldownNotFinished"),
      );

      await increaseTime(SEVEN_DAYS + 1n);
      const aBefore = await fyusd.balanceOf(alice.address);
      await (await vault.connect(alice).unstake(alice.address)).wait();
      assert.equal(await fyusd.balanceOf(alice.address), aBefore + 200n * ONE);
      // Cooldown bucket cleared.
      const cd = await vault.cooldowns(alice.address);
      assert.equal(cd.underlyingAmount, 0n);
    });

    it("admin-tunable cooldown duration takes effect on next cooldown call", async () => {
      const { setting, alice, vault } = await deployFixture();
      await (await vault.connect(alice).deposit(500n * ONE, alice.address)).wait();

      // Halve the cooldown to 3.5 days via admin pool config.
      const halfWindow = SEVEN_DAYS / 2n;
      await (await setting.setPoolConfigs("vFyusdCooldown", halfWindow)).wait();
      assert.equal(await vault.currentCooldownDuration(), halfWindow);

      await (await vault.connect(alice).cooldownAssets(100n * ONE)).wait();
      const cd = await vault.cooldowns(alice.address);
      const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      // Cooldown end ≈ now + halfWindow; allow 5s clock drift.
      const expectedEnd = now + halfWindow;
      assert.ok(
        cd.cooldownEnd >= expectedEnd - 5n && cd.cooldownEnd <= expectedEnd + 5n,
        `cooldown end ${cd.cooldownEnd} != expected ~${expectedEnd}`,
      );
    });

    it("multiple cooldowns accumulate and EXTEND the end timer", async () => {
      const { alice, vault } = await deployFixture();
      await (await vault.connect(alice).deposit(500n * ONE, alice.address)).wait();
      await (await vault.connect(alice).cooldownAssets(100n * ONE)).wait();
      const firstEnd = (await vault.cooldowns(alice.address)).cooldownEnd;

      await increaseTime(60n);
      await (await vault.connect(alice).cooldownAssets(100n * ONE)).wait();
      const cd = await vault.cooldowns(alice.address);
      assert.equal(cd.underlyingAmount, 200n * ONE);
      assert.ok(cd.cooldownEnd > firstEnd, "second cooldown call should push end forward");
    });

    it("direct withdraw and redeem revert (cooldown-only exit)", async () => {
      const { alice, vault } = await deployFixture();
      await (await vault.connect(alice).deposit(500n * ONE, alice.address)).wait();
      await assert.rejects(
        vault.connect(alice).withdraw(100n * ONE, alice.address, alice.address),
        (err) => err.message.includes("use cooldown flow"),
      );
      await assert.rejects(
        vault.connect(alice).redeem(100n * ONE, alice.address, alice.address),
        (err) => err.message.includes("use cooldown flow"),
      );
    });
  });

  describe("pause", () => {
    it("blocks deposit and cooldown when paused; only admin can unpause", async () => {
      const { deployer, alice, pauser, vault } = await deployFixture();
      await (await vault.connect(alice).deposit(100n * ONE, alice.address)).wait();
      await (await vault.connect(pauser).pause()).wait();

      await assert.rejects(vault.connect(alice).deposit(50n * ONE, alice.address));
      await assert.rejects(vault.connect(alice).cooldownAssets(50n * ONE));

      await assert.rejects(
        vault.connect(pauser).unpause(),
        (err) => err.message.includes("NotAdmin"),
      );
      await (await vault.connect(deployer).unpause()).wait();
      await (await vault.connect(alice).cooldownAssets(50n * ONE)).wait();
    });

    it("non-pauser non-admin cannot pause", async () => {
      const { nonAdmin, vault } = await deployFixture();
      await assert.rejects(
        vault.connect(nonAdmin).pause(),
        (err) => err.message.includes("NotPauserOrAdmin"),
      );
    });
  });

  describe("setAdapter", () => {
    it("rejects adapter whose .asset() doesn't equal the vault's FYUSD", async () => {
      const { vault } = await deployFixture();
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const otherToken = await MockERC20.deploy("Other", "OTH", 18);
      const MockAdapter = await ethers.getContractFactory("MockConcreteAdapter");
      const wrongAdapter = await MockAdapter.deploy(await otherToken.getAddress(), 100n);
      await assert.rejects(
        vault.setAdapter(await wrongAdapter.getAddress()),
        (err) => err.message.includes("AdapterAssetMismatch"),
      );
    });

    it("admin-only", async () => {
      const { nonAdmin, adapter, vault } = await deployFixture();
      await assert.rejects(
        vault.connect(nonAdmin).setAdapter(await adapter.getAddress()),
        (err) => err.message.includes("NotAdmin"),
      );
    });
  });
});

// ConcreteAdapterV1 used to be a stub that reverted NotImplemented on
// every state-changing call. As of feat/concrete-adapter-v1-impl, it's
// a live binding against a Concrete Earn V2 ERC-4626 vault. Real-
// implementation coverage (deposit / withdraw / yield accrual / share
// isolation) lives in test/ConcreteAdapterV1.test.js.
