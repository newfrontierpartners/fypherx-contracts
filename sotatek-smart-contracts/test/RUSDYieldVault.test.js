/**
 * RUSDYieldVault (vRUSD) + adapter tests.
 *
 * Mirror of FyusdYieldVault.test.js — same flows, RUSD asset, 14-day default
 * cooldown read from `vRusdCooldown` pool config. Verifies the Concrete-
 * adapter pattern is asset-agnostic in practice.
 */
const assert = require("node:assert/strict");
const { ethers, upgrades, network } = require("hardhat");

const ONE = 10n ** 18n;
const ONE_YEAR = 365n * 24n * 60n * 60n;
const FOURTEEN_DAYS = 14n * 24n * 60n * 60n;

async function increaseTime(seconds) {
  await network.provider.send("evm_increaseTime", [Number(seconds)]);
  await network.provider.send("evm_mine", []);
}

async function deployFixture(apyBps = 600n) {
  const [deployer, alice, bob, pauser, nonAdmin] = await ethers.getSigners();

  const SettingManagement = await ethers.getContractFactory("SettingManagement");
  const setting = await upgrades.deployProxy(SettingManagement, [deployer.address], {
    initializer: "initialize", kind: "transparent",
  });
  await (await setting.setPoolConfigs("vRusdCooldown", FOURTEEN_DAYS)).wait();

  const RUSD = await ethers.getContractFactory("RUSD");
  const rusd = await upgrades.deployProxy(RUSD, [deployer.address], {
    initializer: "initialize", kind: "transparent",
  });
  await (await rusd.setMinter(deployer.address)).wait();

  const MockAdapter = await ethers.getContractFactory("MockConcreteAdapter");
  // vault=0 keeps the mock in legacy free-for-all mode (see
  // FyusdYieldVault.test.js for rationale).
  const adapter = await MockAdapter.deploy(await rusd.getAddress(), apyBps, ethers.ZeroAddress);

  const Vault = await ethers.getContractFactory("RUSDYieldVault");
  const vault = await upgrades.deployProxy(Vault, [
    await setting.getAddress(),
    await rusd.getAddress(),
    await adapter.getAddress(),
    deployer.address,
  ], { initializer: "initialize", kind: "transparent" });

  await (await vault.setPauserRole(pauser.address)).wait();

  for (const u of [alice, bob]) {
    await (await rusd.mint(u.address, 10_000n * ONE)).wait();
    await (await rusd.connect(u).approve(await vault.getAddress(), ethers.MaxUint256)).wait();
  }

  await (await rusd.mint(deployer.address, 1_000_000n * ONE)).wait();
  await (await rusd.approve(await adapter.getAddress(), ethers.MaxUint256)).wait();
  await (await adapter.fundYield(1_000_000n * ONE)).wait();

  return { deployer, alice, bob, pauser, nonAdmin, setting, rusd, adapter, vault };
}

describe("RUSDYieldVault (vRUSD ERC4626)", () => {
  it("deposit pulls RUSD, forwards to adapter, mints vRUSD 1:1", async () => {
    const { alice, rusd, adapter, vault } = await deployFixture();
    await (await vault.connect(alice).deposit(500n * ONE, alice.address)).wait();
    assert.equal(await vault.balanceOf(alice.address), 500n * ONE);
    assert.equal(await vault.totalSupply(), 500n * ONE);
    assert.equal(await rusd.balanceOf(await vault.getAddress()), 0n);
    assert.equal(await adapter.shareOf(await vault.getAddress()), 500n * ONE);
  });

  it("vRUSD has correct ERC20 metadata", async () => {
    const { vault } = await deployFixture();
    assert.equal(await vault.name(), "Vault RUSD");
    assert.equal(await vault.symbol(), "vRUSD");
    assert.equal(await vault.decimals(), 18n);
  });

  it("per-share NAV grows with adapter yield", async () => {
    const { alice, vault } = await deployFixture(600n);
    await (await vault.connect(alice).deposit(1_000n * ONE, alice.address)).wait();
    const navBefore = await vault.convertToAssets(ONE);
    await increaseTime(ONE_YEAR / 2n);
    const navAfter = await vault.convertToAssets(ONE);
    assert.ok(navAfter > navBefore, "vRUSD NAV should grow with yield");
  });

  it("default cooldown is 14 days; admin can change it live", async () => {
    const { setting, alice, vault } = await deployFixture();
    assert.equal(await vault.currentCooldownDuration(), FOURTEEN_DAYS);

    await (await vault.connect(alice).deposit(500n * ONE, alice.address)).wait();
    await (await vault.connect(alice).cooldownAssets(100n * ONE)).wait();
    let cd = await vault.cooldowns(alice.address);
    const firstEnd = cd.cooldownEnd;

    // Cut to 7 days.
    const SEVEN = 7n * 24n * 60n * 60n;
    await (await setting.setPoolConfigs("vRusdCooldown", SEVEN)).wait();
    assert.equal(await vault.currentCooldownDuration(), SEVEN);

    // The CHANGE doesn't retro-shorten — `_accrueCooldown` only extends
    // forward. Confirm by reading the existing entry.
    cd = await vault.cooldowns(alice.address);
    assert.equal(cd.cooldownEnd, firstEnd);
  });

  it("unstake works after cooldownEnd, fails before", async () => {
    const { alice, rusd, vault } = await deployFixture();
    await (await vault.connect(alice).deposit(500n * ONE, alice.address)).wait();
    await (await vault.connect(alice).cooldownAssets(200n * ONE)).wait();

    await assert.rejects(
      vault.connect(alice).unstake(alice.address),
      (err) => err.message.includes("CooldownNotFinished"),
    );

    await increaseTime(FOURTEEN_DAYS + 1n);
    const aBefore = await rusd.balanceOf(alice.address);
    await (await vault.connect(alice).unstake(alice.address)).wait();
    assert.equal(await rusd.balanceOf(alice.address), aBefore + 200n * ONE);
  });

  it("setAdapter rejects asset mismatch", async () => {
    const { vault } = await deployFixture();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const otherToken = await MockERC20.deploy("Other", "OTH", 18);
    const MockAdapter = await ethers.getContractFactory("MockConcreteAdapter");
    const wrongAdapter = await MockAdapter.deploy(await otherToken.getAddress(), 100n, ethers.ZeroAddress);
    await assert.rejects(
      vault.setAdapter(await wrongAdapter.getAddress()),
      (err) => err.message.includes("AdapterAssetMismatch"),
    );
  });

  it("pause blocks deposit and cooldown; only admin unpauses", async () => {
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
});
