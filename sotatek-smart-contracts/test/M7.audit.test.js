/**
 * M7 audit verification — residual ("pending") CertiK findings.
 *
 *   FYP-34: ERC4626 max* must reflect vault restrictions. M4 covered
 *           maxWithdraw/maxRedeem; M7 extends to maxDeposit/maxMint so
 *           they return 0 when the entry would revert (paused vault and,
 *           on the staked vaults, a restricted receiver).
 *
 *   FYP-41: yield-vault / adapter share accounting can diverge. M3 made
 *           the WITHDRAW path asset-based; M7 closes the residual
 *           migration cases by keying {setAdapter} off the vault's own
 *           ERC-4626 supply + an asset-denominated residual check, and
 *           adding a ledger-independent {closeAdapterPosition} that drains
 *           residual shares AND residual assets before rotation.
 *
 *   FYP-73: StakedFYP cooldown-silo withdrawals now use a high-level
 *           typed call, so a mis-configured EOA silo reverts instead of
 *           silently deleting the user's cooldown.
 *
 *   FYP-75: ConcreteAdapterV1 exposes an admin-gated rescueToken() that
 *           recovers stray ERC-20s while reverting on the tracked Concrete
 *           vault share token.
 *
 *   FYP-77: StakedFYP / StakedAUSD aligned with StakedRUSD — they now
 *           expose releaseToken(), rescueTokens() and an explicit
 *           _decimalsOffset() override.
 */
const assert = require("node:assert/strict");
const { ethers, upgrades, network } = require("hardhat");

const ONE = 10n ** 18n;
const SEVEN_DAYS = 7n * 24n * 60n * 60n;
const DEAD_EOA = "0x000000000000000000000000000000000000dEaD"; // no code
const FULL_RESTRICTED = ethers.keccak256(ethers.toUtf8Bytes("FULL_RESTRICTED_STAKER_ROLE"));
const SOFT_RESTRICTED = ethers.keccak256(ethers.toUtf8Bytes("SOFT_RESTRICTED_STAKER_ROLE"));
const RELEASE_TOKEN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("RELEASE_TOKEN_ROLE"));

async function increaseTime(seconds) {
  await network.provider.send("evm_increaseTime", [Number(seconds)]);
  await network.provider.send("evm_mine", []);
}

// ── vFYUSD vault fixture (MockConcreteAdapter) ────────────────────────
async function deployVaultFixture(apyBps = 400n) {
  const [deployer, alice, bob, pauser, treasury] = await ethers.getSigners();

  const SettingManagement = await ethers.getContractFactory("SettingManagement");
  const setting = await upgrades.deployProxy(SettingManagement, [deployer.address], {
    initializer: "initialize", kind: "transparent",
  });
  await (await setting.setPoolConfigs("vFyusdCooldown", SEVEN_DAYS)).wait();

  const FYUSD = await ethers.getContractFactory("FYUSD");
  const fyusd = await upgrades.deployProxy(FYUSD, [deployer.address], {
    initializer: "initialize", kind: "transparent",
  });
  await (await fyusd.setMinter(deployer.address)).wait();

  const MockAdapter = await ethers.getContractFactory("MockConcreteAdapter");
  const adapter = await MockAdapter.deploy(await fyusd.getAddress(), apyBps, ethers.ZeroAddress);

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
  // Pre-fund the adapter so it can pay simulated yield on withdrawal.
  await (await fyusd.mint(deployer.address, 1_000_000n * ONE)).wait();
  await (await fyusd.approve(await adapter.getAddress(), ethers.MaxUint256)).wait();
  await (await adapter.fundYield(1_000_000n * ONE)).wait();

  return { deployer, alice, bob, pauser, treasury, setting, fyusd, adapter, vault };
}

// ── StakedFYP fixture (EOA silo by default — FYP-73 scenario) ─────────
async function deployStakedFYP(siloAddr = DEAD_EOA) {
  const [deployer, alice, bob] = await ethers.getSigners();
  const SettingManagement = await ethers.getContractFactory("SettingManagement");
  const setting = await upgrades.deployProxy(SettingManagement, [deployer.address], {
    initializer: "initialize", kind: "transparent",
  });
  await (await setting.setPoolConfigs("cooldownDuration", Number(SEVEN_DAYS))).wait();

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const fyp = await MockERC20.deploy("Mock FYP", "mFYP", 18);

  const StakedFYP = await ethers.getContractFactory("StakedFYP");
  const sFYP = await upgrades.deployProxy(
    StakedFYP,
    [await fyp.getAddress(), await setting.getAddress(), siloAddr],
    { initializer: "initialize", kind: "transparent" },
  );

  for (const u of [alice, bob]) {
    await (await fyp.mint(u.address, 10_000n * ONE)).wait();
    await (await fyp.connect(u).approve(await sFYP.getAddress(), ethers.MaxUint256)).wait();
  }
  return { deployer, alice, bob, setting, fyp, sFYP };
}

// ── StakedAUSD fixture (EOA silo) ─────────────────────────────────────
async function deployStakedAUSD(siloAddr = DEAD_EOA) {
  const [deployer, alice] = await ethers.getSigners();
  const SettingManagement = await ethers.getContractFactory("SettingManagement");
  const setting = await upgrades.deployProxy(SettingManagement, [deployer.address], {
    initializer: "initialize", kind: "transparent",
  });
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const fyusd = await MockERC20.deploy("Mock FYUSD", "mFYUSD", 18);
  const StakedAUSD = await ethers.getContractFactory("StakedAUSD");
  const stAUSD = await upgrades.deployProxy(
    StakedAUSD,
    [await fyusd.getAddress(), await setting.getAddress(), siloAddr],
    { initializer: "initialize", kind: "transparent" },
  );
  await (await fyusd.mint(alice.address, 10_000n * ONE)).wait();
  await (await fyusd.connect(alice).approve(await stAUSD.getAddress(), ethers.MaxUint256)).wait();
  return { deployer, alice, setting, fyusd, stAUSD };
}

// ── ConcreteAdapterV1 fixture (real adapter + mock Concrete vault) ────
async function deployAdapterFixture() {
  const [deployer, vault, otherCaller, treasury] = await ethers.getSigners();
  const Mock = await ethers.getContractFactory("MockERC20");
  const fyusd = await Mock.deploy("Mock FYUSD", "FYUSD", 18);
  const Vault = await ethers.getContractFactory("MockERC4626Vault");
  const concreteVault = await Vault.deploy(await fyusd.getAddress(), "Concrete Mock", "ccFYUSD");
  const Adapter = await ethers.getContractFactory("ConcreteAdapterV1");
  const adapter = await Adapter.deploy(
    await fyusd.getAddress(),
    await concreteVault.getAddress(),
    vault.address, // bound vault == `vault` signer, so it can call onlyVault fns
  );
  async function fundAndApprove(signer, amount) {
    await (await fyusd.mint(signer.address, amount)).wait();
    await (await fyusd.connect(signer).approve(await adapter.getAddress(), amount)).wait();
  }
  return { deployer, vault, otherCaller, treasury, fyusd, concreteVault, adapter, fundAndApprove };
}

// ─────────────────────────────────────────────────────────────────────
// FYP-34 — maxDeposit / maxMint reflect pause + receiver restrictions
// ─────────────────────────────────────────────────────────────────────
describe("FYP-34 — maxDeposit/maxMint reflect restrictions", () => {
  it("vFYUSD: maxDeposit/maxMint are unlimited when live, 0 when paused", async () => {
    const { alice, pauser, vault } = await deployVaultFixture();
    assert.equal(await vault.maxDeposit(alice.address), ethers.MaxUint256);
    assert.equal(await vault.maxMint(alice.address), ethers.MaxUint256);

    await (await vault.connect(pauser).pause()).wait();
    assert.equal(await vault.maxDeposit(alice.address), 0n);
    assert.equal(await vault.maxMint(alice.address), 0n);

    await (await vault.unpause()).wait();
    assert.equal(await vault.maxDeposit(alice.address), ethers.MaxUint256);
    assert.equal(await vault.maxMint(alice.address), ethers.MaxUint256);
  });

  it("StakedFYP: maxDeposit/maxMint are 0 for a restricted receiver and when paused", async () => {
    const { deployer, alice, bob, setting, sFYP } = await deployStakedFYP();

    // Unrestricted, live → unlimited.
    assert.equal(await sFYP.maxDeposit(alice.address), ethers.MaxUint256);
    assert.equal(await sFYP.maxMint(alice.address), ethers.MaxUint256);

    // Restricted receiver → 0 (deposit/mint would revert RestrictedStaker).
    await (await setting.grantRole(SOFT_RESTRICTED, bob.address)).wait();
    assert.equal(await sFYP.maxDeposit(bob.address), 0n);
    assert.equal(await sFYP.maxMint(bob.address), 0n);
    // Sanity: the actual deposit really does revert for the restricted user.
    await assert.rejects(
      sFYP.connect(bob).deposit(1n * ONE, bob.address),
      (e) => e.message.includes("RestrictedStaker"),
    );

    // Paused → 0 even for an unrestricted receiver.
    await (await sFYP.connect(deployer).pause()).wait();
    assert.equal(await sFYP.maxDeposit(alice.address), 0n);
    assert.equal(await sFYP.maxMint(alice.address), 0n);
  });
});

// ─────────────────────────────────────────────────────────────────────
// FYP-73 — StakedFYP typed silo call reverts on an EOA silo
// ─────────────────────────────────────────────────────────────────────
describe("FYP-73 — StakedFYP high-level typed silo call", () => {
  it("unstake reverts (and preserves the cooldown) when silo is an EOA", async () => {
    const { alice, sFYP } = await deployStakedFYP(DEAD_EOA);

    await (await sFYP.connect(alice).deposit(1_000n * ONE, alice.address)).wait();
    await (await sFYP.connect(alice).cooldownShares(1_000n * ONE)).wait();
    await increaseTime(SEVEN_DAYS + 1n);

    // Old low-level `silo.call` returned success==true against a code-less
    // account and deleted the cooldown. The typed call reverts instead.
    await assert.rejects(sFYP.connect(alice).unstake(alice.address));

    // Cooldown record is intact (tx reverted), so the user can retry once
    // the silo is fixed — funds/state are not silently lost.
    const cd = await sFYP.cooldowns(alice.address);
    assert.ok(cd.underlyingAmount > 0n, "cooldown must survive the failed unstake");
  });

  it("earlyUnstake also reverts when silo is an EOA", async () => {
    const { alice, sFYP } = await deployStakedFYP(DEAD_EOA);
    await (await sFYP.connect(alice).deposit(1_000n * ONE, alice.address)).wait();
    await (await sFYP.connect(alice).cooldownShares(1_000n * ONE)).wait();
    // still inside the cooldown window → earlyUnstake path
    await assert.rejects(sFYP.connect(alice).earlyUnstake(alice.address));
  });
});

// ─────────────────────────────────────────────────────────────────────
// FYP-75 — ConcreteAdapterV1.rescueToken
// ─────────────────────────────────────────────────────────────────────
describe("FYP-75 — adapter ERC-20 rescue", () => {
  it("recovers a stray ERC-20 but reverts on the tracked Concrete share token", async () => {
    const { vault, otherCaller, treasury, concreteVault, adapter } = await deployAdapterFixture();

    // A random token gets mistakenly sent to the adapter.
    const Mock = await ethers.getContractFactory("MockERC20");
    const stray = await Mock.deploy("Stray", "STRAY", 18);
    await (await stray.mint(await adapter.getAddress(), 777n * ONE)).wait();

    // Non-vault caller cannot rescue.
    await assert.rejects(
      adapter.connect(otherCaller).rescueToken(await stray.getAddress(), treasury.address, 777n * ONE),
      (e) => e.message.includes("NotVault"),
    );

    // The tracked Concrete vault share token can never be rescued here.
    await assert.rejects(
      adapter.connect(vault).rescueToken(await concreteVault.getAddress(), treasury.address, 1n),
      (e) => e.message.includes("CannotRescueConcreteShares"),
    );

    // The stray token is recoverable by the bound vault.
    await (await adapter.connect(vault).rescueToken(await stray.getAddress(), treasury.address, 777n * ONE)).wait();
    assert.equal(await stray.balanceOf(treasury.address), 777n * ONE);
    assert.equal(await stray.balanceOf(await adapter.getAddress()), 0n);
  });

  it("is reachable through the vault's admin-gated rescueAdapterToken wrapper", async () => {
    const { deployer, alice, treasury, vault, adapter } = await deployVaultFixture();
    // Send a stray token to the (mock) adapter, recover via the vault.
    const Mock = await ethers.getContractFactory("MockERC20");
    const stray = await Mock.deploy("Stray", "STRAY", 18);
    await (await stray.mint(await adapter.getAddress(), 5n * ONE)).wait();

    // Non-admin blocked.
    await assert.rejects(
      vault.connect(alice).rescueAdapterToken(await stray.getAddress(), treasury.address, 5n * ONE),
      (e) => e.message.includes("NotAdmin"),
    );
    await (await vault.connect(deployer).rescueAdapterToken(await stray.getAddress(), treasury.address, 5n * ONE)).wait();
    assert.equal(await stray.balanceOf(treasury.address), 5n * ONE);
  });
});

// ─────────────────────────────────────────────────────────────────────
// FYP-41 residual — ledger-independent close-out + asset-based rotation
// ─────────────────────────────────────────────────────────────────────
describe("FYP-41 residual — adapter close-out & rotation", () => {
  it("recoverAll redeems the whole accounted position and zeroes accounting", async () => {
    const { vault, otherCaller, treasury, fyusd, concreteVault, adapter, fundAndApprove } =
      await deployAdapterFixture();

    await fundAndApprove(vault, 1_000n * ONE);
    await (await adapter.connect(vault).deposit(1_000n * ONE)).wait();

    // Concrete accrues yield → totalAssets grows past principal.
    await (await fyusd.mint(treasury.address, 200n * ONE)).wait();
    await (await fyusd.connect(treasury).approve(await concreteVault.getAddress(), 200n * ONE)).wait();
    await (await concreteVault.connect(treasury).simulateYield(200n * ONE)).wait();
    assert.ok((await adapter.totalAssets()) > 1_000n * ONE, "yield should have accrued");

    // onlyVault gate.
    await assert.rejects(
      adapter.connect(otherCaller).recoverAll(treasury.address),
      (e) => e.message.includes("NotVault"),
    );

    const balBefore = await fyusd.balanceOf(treasury.address);
    await (await adapter.connect(vault).recoverAll(treasury.address)).wait();
    const delivered = (await fyusd.balanceOf(treasury.address)) - balBefore;

    assert.ok(delivered >= 1_200n * ONE - 2n, `delivered ~all assets, got ${delivered}`);
    assert.equal(await adapter.totalAssets(), 0n);
    assert.equal(await adapter.totalShares(), 0n);
    assert.equal(await adapter.accountedConcreteShares(), 0n);
  });

  it("setAdapter / closeAdapterPosition refuse to run while shares are outstanding", async () => {
    const { deployer, alice, treasury, adapter, vault } = await deployVaultFixture();
    await (await vault.connect(alice).deposit(500n * ONE, alice.address)).wait();

    // A fresh, asset-compatible adapter to (try to) rotate into.
    const MockAdapter = await ethers.getContractFactory("MockConcreteAdapter");
    const newAdapter = await MockAdapter.deploy(await vault.asset(), 400n, await vault.getAddress());

    await assert.rejects(
      vault.connect(deployer).setAdapter(await newAdapter.getAddress()),
      (e) => e.message.includes("VaultNotEmpty"),
    );
    await assert.rejects(
      vault.connect(deployer).closeAdapterPosition(treasury.address),
      (e) => e.message.includes("VaultNotEmpty"),
    );
  });

  it("residual assets after a full wind-down block rotation, then closeAdapterPosition clears them", async () => {
    const { deployer, alice, treasury, fyusd, adapter, vault } = await deployVaultFixture();

    // Alice deposits, yield accrues, then she exits her entire balance. The
    // OZ virtual-offset (vault) vs raw (adapter) rounding leaves a wei of
    // residual ASSETS in the adapter while the vault supply hits 0 — exactly
    // CertiK's residual case.
    await (await vault.connect(alice).deposit(1_000n * ONE, alice.address)).wait();
    await increaseTime(180n * 24n * 60n * 60n); // 6 months of mock yield
    const shares = await vault.balanceOf(alice.address);
    await (await vault.connect(alice).cooldownShares(shares)).wait();

    assert.equal(await vault.totalSupply(), 0n, "vault fully wound down");
    const residual = await vault.totalAssets(); // == adapter.totalAssets()
    assert.ok(residual > 0n, "rounding should leave residual assets in the adapter");

    // Rotation is blocked because the OLD adapter still holds assets.
    const MockAdapter = await ethers.getContractFactory("MockConcreteAdapter");
    const newAdapter = await MockAdapter.deploy(await vault.asset(), 400n, await vault.getAddress());
    await assert.rejects(
      vault.connect(deployer).setAdapter(await newAdapter.getAddress()),
      (e) => e.message.includes("AdapterStillHoldsAssets"),
    );

    // closeAdapterPosition drains the residual to the treasury, ledger-free.
    const tBefore = await fyusd.balanceOf(treasury.address);
    await (await vault.connect(deployer).closeAdapterPosition(treasury.address)).wait();
    assert.equal(await fyusd.balanceOf(treasury.address) - tBefore, residual);
    assert.equal(await vault.totalAssets(), 0n);

    // Now rotation succeeds and the vault is usable on the new adapter.
    await (await vault.connect(deployer).setAdapter(await newAdapter.getAddress())).wait();
    assert.equal(await vault.adapter(), await newAdapter.getAddress());
    await (await vault.connect(alice).deposit(100n * ONE, alice.address)).wait();
    assert.equal(await vault.totalSupply(), 100n * ONE);
  });
});

// ─────────────────────────────────────────────────────────────────────
// FYP-77 — StakedFYP / StakedAUSD aligned with StakedRUSD
// ─────────────────────────────────────────────────────────────────────
describe("FYP-77 — staked-contract surface alignment", () => {
  for (const which of ["StakedFYP", "StakedAUSD"]) {
    it(`${which} exposes rescueTokens + releaseToken with the asset() guard`, async () => {
      const f = which === "StakedFYP" ? await deployStakedFYP() : await deployStakedAUSD();
      const { deployer, setting } = f;
      const vault = which === "StakedFYP" ? f.sFYP : f.stAUSD;
      const asset = which === "StakedFYP" ? f.fyp : f.fyusd;
      const [, , , carol] = await ethers.getSigners();

      // A stray token mistakenly lands on the vault.
      const Mock = await ethers.getContractFactory("MockERC20");
      const stray = await Mock.deploy("Stray", "STRAY", 18);
      await (await stray.mint(await vault.getAddress(), 100n * ONE)).wait();

      // rescueTokens: admin-only, cannot rescue the staked asset.
      await assert.rejects(
        vault.connect(carol).rescueTokens(await stray.getAddress(), carol.address, 1n * ONE),
        (e) => e.message.includes("NotAdmin"),
      );
      await assert.rejects(
        vault.connect(deployer).rescueTokens(await asset.getAddress(), carol.address, 1n),
        (e) => e.message.includes("Cannot rescue staked asset"),
      );
      await (await vault.connect(deployer).rescueTokens(await stray.getAddress(), carol.address, 40n * ONE)).wait();
      assert.equal(await stray.balanceOf(carol.address), 40n * ONE);

      // releaseToken: RELEASE_TOKEN_ROLE-gated, cannot release the staked asset.
      await assert.rejects(
        vault.connect(carol).releaseToken(await stray.getAddress(), carol.address, 1n * ONE),
        (e) => e.message.includes("Not release role"),
      );
      await (await setting.grantRole(RELEASE_TOKEN_ROLE, deployer.address)).wait();
      await assert.rejects(
        vault.connect(deployer).releaseToken(await asset.getAddress(), carol.address, 1n),
        (e) => e.message.includes("Cannot release staked asset"),
      );
      await (await vault.connect(deployer).releaseToken(await stray.getAddress(), carol.address, 60n * ONE)).wait();
      assert.equal(await stray.balanceOf(carol.address), 100n * ONE);
    });

    it(`${which} reports 18 decimals (explicit _decimalsOffset() == 0, aligned)`, async () => {
      const f = which === "StakedFYP" ? await deployStakedFYP() : await deployStakedAUSD();
      const vault = which === "StakedFYP" ? f.sFYP : f.stAUSD;
      assert.equal(await vault.decimals(), 18n);
    });
  }
});
