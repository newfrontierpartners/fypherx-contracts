/**
 * FyusdYieldVault + adapter tests.
 *
 * Verifies (per ADR-006 + PHASE1_SPEC §3.4):
 *   - MockConcreteAdapter accrues simulated yield over time;
 *     totalAssets grows past principal as time elapses.
 *   - Vault deposit pulls FYUSD, forwards to adapter, mints user
 *     shares 1:1 with adapter shares.
 *   - Vault withdraw burns shares, pulls FYUSD back from adapter,
 *     pays user principal + their pro-rata yield.
 *   - vaultPaused (ADR-008) blocks both deposit and withdraw;
 *     pauser cannot unpause.
 *   - setAdapter is admin-only and rejects mismatched-asset adapters.
 *   - ConcreteAdapterV1 stub reverts NotImplemented for any state-changing
 *     call (fail-loud guard against accidental BSC deploy).
 */
const assert = require("node:assert/strict");
const { ethers, upgrades, network } = require("hardhat");

const ONE = 10n ** 18n;
const ONE_YEAR = 365n * 24n * 60n * 60n;

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

  const FYUSD = await ethers.getContractFactory("FYUSD");
  const fyusd = await upgrades.deployProxy(FYUSD, [deployer.address], {
    initializer: "initialize", kind: "transparent",
  });
  // Deployer is the minter for tests so we can seed users.
  await (await fyusd.setMinter(deployer.address)).wait();

  const MockAdapter = await ethers.getContractFactory("MockConcreteAdapter");
  const adapter = await MockAdapter.deploy(await fyusd.getAddress(), apyBps);

  const Vault = await ethers.getContractFactory("FyusdYieldVault");
  const vault = await upgrades.deployProxy(Vault, [
    await setting.getAddress(),
    await fyusd.getAddress(),
    await adapter.getAddress(),
  ], { initializer: "initialize", kind: "transparent" });

  await (await vault.setPauserRole(pauser.address)).wait();

  // Seed alice + bob with FYUSD + approve the vault.
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
    const { alice, fyusd, adapter } = await deployFixture(400n); // 4% APY
    // Bypass the vault for a direct adapter test.
    await (await fyusd.connect(alice).approve(await adapter.getAddress(), ethers.MaxUint256)).wait();
    await (await adapter.connect(alice).deposit(1_000n * ONE)).wait();

    const before = await adapter.totalAssets();
    await increaseTime(ONE_YEAR / 2n); // 6 months
    const after = await adapter.totalAssets();
    // 4% APY for 0.5y on 1000 FYUSD ≈ 20 FYUSD yield.
    const delta = after - before;
    assert.ok(delta > 19n * ONE && delta < 21n * ONE, `unexpected accrual delta: ${delta}`);
  });
});

describe("FyusdYieldVault", () => {
  describe("deposit + withdraw", () => {
    it("deposit pulls FYUSD, mints shares 1:1 with adapter shares", async () => {
      const { alice, fyusd, adapter, vault } = await deployFixture();
      const aliceBefore = await fyusd.balanceOf(alice.address);
      await (await vault.connect(alice).deposit(500n * ONE)).wait();
      assert.equal(await fyusd.balanceOf(alice.address), aliceBefore - 500n * ONE);
      assert.equal(await vault.sharesOf(alice.address), 500n * ONE);
      assert.equal(await vault.totalShares(), 500n * ONE);
      // Vault holds 0 FYUSD — it's all forwarded to the adapter.
      assert.equal(await fyusd.balanceOf(await vault.getAddress()), 0n);
      // Adapter recorded the vault's share position.
      assert.equal(await adapter.shareOf(await vault.getAddress()), 500n * ONE);
    });

    it("withdraw returns principal + pro-rata yield", async () => {
      const { alice, fyusd, vault } = await deployFixture(400n); // 4% APY
      await (await vault.connect(alice).deposit(1_000n * ONE)).wait();
      const balAfterDeposit = await fyusd.balanceOf(alice.address);

      // 6 months elapse — should accrue ~2% on principal = ~20 FYUSD.
      await increaseTime(ONE_YEAR / 2n);

      await (await vault.connect(alice).withdraw(1_000n * ONE)).wait();
      const balFinal = await fyusd.balanceOf(alice.address);
      const payout = balFinal - balAfterDeposit;
      assert.ok(
        payout > 1019n * ONE && payout < 1021n * ONE,
        `expected payout ≈ 1020 FYUSD, got ${payout}`,
      );
      assert.equal(await vault.sharesOf(alice.address), 0n);
    });

    it("two depositors share yield pro-rata", async () => {
      const { alice, bob, fyusd, vault } = await deployFixture(400n);
      // Alice and Bob deposit 200 and 800 respectively in the same block.
      await network.provider.send("evm_setAutomine", [false]);
      await vault.connect(alice).deposit(200n * ONE);
      await vault.connect(bob).deposit(800n * ONE);
      await network.provider.send("evm_mine", []);
      await network.provider.send("evm_setAutomine", [true]);

      await increaseTime(ONE_YEAR);

      const aBefore = await fyusd.balanceOf(alice.address);
      const bBefore = await fyusd.balanceOf(bob.address);
      await (await vault.connect(alice).withdraw(200n * ONE)).wait();
      await (await vault.connect(bob).withdraw(800n * ONE)).wait();
      const aPayout = (await fyusd.balanceOf(alice.address)) - aBefore;
      const bPayout = (await fyusd.balanceOf(bob.address)) - bBefore;
      // Bob staked 4x as much → should receive 4x the yield over the year.
      // Yields scale with principal, so the 1:4 ratio is exact in pure math
      // but rounding via integer division can drift by O(1) wei. Assert
      // ratio with a tight tolerance.
      const aYield = aPayout - 200n * ONE;
      const bYield = bPayout - 800n * ONE;
      // bYield / aYield ≈ 4. Use a *1000 scaled comparison for tolerance.
      const ratioScaled = (bYield * 1000n) / aYield;
      assert.ok(
        ratioScaled >= 3990n && ratioScaled <= 4010n,
        `expected ~4x yield ratio, got ${Number(ratioScaled) / 1000}`,
      );
    });
  });

  describe("vaultPaused (ADR-008)", () => {
    it("blocks deposit and withdraw when paused; only admin can unpause", async () => {
      const { deployer, alice, pauser, vault } = await deployFixture();
      await (await vault.connect(alice).deposit(100n * ONE)).wait();
      await (await vault.connect(pauser).setVaultPaused(true)).wait();
      await assert.rejects(
        vault.connect(alice).deposit(50n * ONE),
        (err) => err.message.includes("VaultPausedErr"),
      );
      await assert.rejects(
        vault.connect(alice).withdraw(50n * ONE),
        (err) => err.message.includes("VaultPausedErr"),
      );
      // Pauser cannot unpause.
      await assert.rejects(
        vault.connect(pauser).setVaultPaused(false),
        (err) => err.message.includes("NotAdmin"),
      );
      await (await vault.connect(deployer).setVaultPaused(false)).wait();
      // Withdraw works again post-unpause.
      await (await vault.connect(alice).withdraw(50n * ONE)).wait();
    });

    it("non-pauser non-admin cannot pause", async () => {
      const { nonAdmin, vault } = await deployFixture();
      await assert.rejects(
        vault.connect(nonAdmin).setVaultPaused(true),
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

describe("ConcreteAdapterV1 (mainnet stub)", () => {
  it("reverts NotImplemented on every state-changing call", async () => {
    const [deployer] = await ethers.getSigners();
    const FYUSD = await ethers.getContractFactory("FYUSD");
    const fyusd = await upgrades.deployProxy(FYUSD, [deployer.address], {
      initializer: "initialize", kind: "transparent",
    });
    const Stub = await ethers.getContractFactory("ConcreteAdapterV1");
    const stub = await Stub.deploy(await fyusd.getAddress(), deployer.address);

    assert.equal(await stub.asset(), await fyusd.getAddress());
    await assert.rejects(stub.deposit(1n), (err) => err.message.includes("NotImplemented"));
    await assert.rejects(stub.withdraw(1n), (err) => err.message.includes("NotImplemented"));
    await assert.rejects(stub.totalAssets(), (err) => err.message.includes("NotImplemented"));
    await assert.rejects(stub.shareOf(deployer.address), (err) => err.message.includes("NotImplemented"));
    await assert.rejects(stub.realizedYield7d(), (err) => err.message.includes("NotImplemented"));
  });
});
