/**
 * M8 audit verification — FYP-78 (Jul 1 preliminary revision).
 *
 *   FYP-78: cooldownShares() lets the LAST holder burn every outstanding
 *           share while a reward stream is mid-release. The burn is priced
 *           on totalAssets() — which excludes _unvestedAmount() — so the
 *           unreleased remainder stays in the vault with totalSupply()==0,
 *           accrues to the ERC-4626 virtual share and, because
 *           rescueTokens()/releaseToken() deliberately refuse asset(),
 *           was unrecoverable without a contract upgrade.
 *
 *           M8 adds recoverResidualRewards(to) to all three staked vaults:
 *           admin-gated, callable ONLY while totalSupply()==0, sweeps the
 *           residual asset() balance (balance-based, so it also covers the
 *           fully-released case where _unvestedAmount() is already 0) and
 *           resets the stream state.
 */
const assert = require("node:assert/strict");
const { ethers, upgrades, network } = require("hardhat");

const ONE = 10n ** 18n;
const REWARDER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("REWARDER_ROLE"));
const DEAD_EOA = "0x000000000000000000000000000000000000dEaD"; // no code

async function increaseTime(seconds) {
  await network.provider.send("evm_increaseTime", [Number(seconds)]);
  await network.provider.send("evm_mine", []);
}

// Deploy one of the three staked vaults with a mock underlying and the
// deployer wired as admin + rewarder. StakedRUSD builds its own silo;
// StakedFYP / StakedAUSD take a silo address (EOA is fine here — the
// FYP-78 scenario never withdraws from the silo).
async function deployStaked(name) {
  const [deployer, alice, bob, treasury, outsider] = await ethers.getSigners();

  const SettingManagement = await ethers.getContractFactory("SettingManagement");
  const setting = await upgrades.deployProxy(SettingManagement, [deployer.address], {
    initializer: "initialize", kind: "transparent",
  });
  await (await setting.grantRole(REWARDER_ROLE, deployer.address)).wait();

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const token = await MockERC20.deploy("Mock Underlying", "mUND", 18);

  const Factory = await ethers.getContractFactory(name);
  const initArgs = name === "StakedRUSD"
    ? [await token.getAddress(), await setting.getAddress(), deployer.address]
    : [await token.getAddress(), await setting.getAddress(), DEAD_EOA];
  const vault = await upgrades.deployProxy(Factory, initArgs, {
    initializer: "initialize", kind: "transparent",
  });

  for (const u of [deployer, alice, bob]) {
    await (await token.mint(u.address, 100_000n * ONE)).wait();
    await (await token.connect(u).approve(await vault.getAddress(), ethers.MaxUint256)).wait();
  }
  return { deployer, alice, bob, treasury, outsider, setting, token, vault };
}

for (const name of ["StakedRUSD", "StakedFYP", "StakedAUSD"]) {
  describe(`FYP-78 — ${name}: zero supply during active reward stream`, () => {
    it("reproduces the stranded stream, then recovers it via recoverResidualRewards", async () => {
      const { alice, bob, treasury, token, vault } = await deployStaked(name);
      const vaultAddr = await vault.getAddress();

      // 1. Rewards stream in on top of a live deposit (CertiK scenario 1).
      await (await vault.connect(alice).deposit(1_000n * ONE, alice.address)).wait();
      await (await vault.transferInRewards(800n * ONE)).wait();

      // 2. Mid-stream (4h into the 8h window) the LAST holder cooldowns
      //    out every share (scenario 2–3).
      await increaseTime(4n * 60n * 60n);
      await (await vault.connect(alice)
        .cooldownShares(await vault.balanceOf(alice.address))).wait();

      // 3. Stranded state (scenario 4): no shares, but the unreleased
      //    remainder is still sitting in the vault ...
      assert.equal(await vault.totalSupply(), 0n);
      const stranded = await token.balanceOf(vaultAddr);
      assert.ok(stranded > 0n, "unreleased remainder should be stranded in the vault");
      // ... and the pre-M8 recovery paths refuse the staked asset.
      await assert.rejects(
        vault.rescueTokens(await token.getAddress(), treasury.address, stranded),
        (e) => e.message.includes("Cannot rescue staked asset"),
      );

      // 4. Let the remainder finish releasing to the virtual share
      //    (scenario 5 — _unvestedAmount() is now 0), then sweep. The
      //    balance-based sweep must still recover the full residue.
      await increaseTime(8n * 60n * 60n);
      const before = await token.balanceOf(treasury.address);
      await (await vault.recoverResidualRewards(treasury.address)).wait();
      assert.equal(await token.balanceOf(treasury.address) - before, stranded);
      assert.equal(await token.balanceOf(vaultAddr), 0n);
      assert.equal(await vault.vestingAmount(), 0n);

      // 5. A fresh depositor afterwards enters at clean 1:1 pricing —
      //    no residue is silently gifted or withheld.
      assert.equal(await vault.previewDeposit(100n * ONE), 100n * ONE);
      await (await vault.connect(bob).deposit(100n * ONE, bob.address)).wait();
      assert.equal(await vault.balanceOf(bob.address), 100n * ONE);
    });

    it("also recovers when swept mid-stream (before the window elapses)", async () => {
      const { alice, treasury, token, vault } = await deployStaked(name);
      await (await vault.connect(alice).deposit(1_000n * ONE, alice.address)).wait();
      await (await vault.transferInRewards(800n * ONE)).wait();
      await increaseTime(4n * 60n * 60n);
      await (await vault.connect(alice)
        .cooldownShares(await vault.balanceOf(alice.address))).wait();

      const stranded = await token.balanceOf(await vault.getAddress());
      const before = await token.balanceOf(treasury.address);
      await (await vault.recoverResidualRewards(treasury.address)).wait();
      assert.equal(await token.balanceOf(treasury.address) - before, stranded);
      assert.equal(await vault.vestingAmount(), 0n);
    });

    it("refuses non-admins, outstanding shares, zero recipient and an empty vault", async () => {
      const { alice, treasury, outsider, vault } = await deployStaked(name);

      // Nothing stranded yet → ZeroAmount.
      await assert.rejects(
        vault.recoverResidualRewards(treasury.address),
        (e) => e.message.includes("ZeroAmount"),
      );
      // Zero recipient → ZeroAddress.
      await assert.rejects(
        vault.recoverResidualRewards(ethers.ZeroAddress),
        (e) => e.message.includes("ZeroAddress"),
      );

      // Live shares → SharesOutstanding, even for the admin: depositor
      // backing can never be swept through this path.
      await (await vault.connect(alice).deposit(10n * ONE, alice.address)).wait();
      await assert.rejects(
        vault.recoverResidualRewards(treasury.address),
        (e) => e.message.includes("SharesOutstanding"),
      );

      // Non-admin → NotAdmin.
      await assert.rejects(
        vault.connect(outsider).recoverResidualRewards(treasury.address),
        (e) => e.message.includes("NotAdmin"),
      );
    });
  });
}
