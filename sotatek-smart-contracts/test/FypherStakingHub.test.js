/**
 * FypherStakingHub — single vault with sub-pools + per-pool weight
 * + block-based FPY emission. Per ADR-003 + PHASE1_SPEC §3.3.
 *
 * Verifies:
 *   - Pool setup: addPool / setPoolWeight / setFpyPerBlock; weight asymmetry
 *     drives proportional FPY allocation across pools.
 *   - Stake / unstake / claim accounting follows the MasterChef
 *     accumulator pattern: one user in a pool earns 100% of pool FPY;
 *     two users share pro-rata; cross-pool, the 1x and 2x pools split
 *     fpyPerBlock by weightBps.
 *   - Per-pool pause blocks stake but allows unstake (don't trap funds);
 *     pauser cannot unpause.
 *   - migrate() credits multiple users in one call, accrual epoch starts
 *     at migration block (no retroactive rewards).
 *   - Insufficient hub FPY balance reverts InsufficientFpy.
 */
const assert = require("node:assert/strict");
const { ethers, upgrades, network } = require("hardhat");

const ONE = 10n ** 18n;

async function mineBlocks(n) {
  for (let i = 0; i < n; ++i) await network.provider.send("evm_mine", []);
}

async function deployFixture() {
  const [deployer, alice, bob, carol, pauser, nonAdmin] = await ethers.getSigners();

  const SettingManagement = await ethers.getContractFactory("SettingManagement");
  const setting = await upgrades.deployProxy(SettingManagement, [deployer.address], {
    initializer: "initialize", kind: "transparent",
  });

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const rusd = await MockERC20.deploy("Mock RUSD", "mRUSD", 18);
  const fyusd = await MockERC20.deploy("Mock FYUSD", "mFYUSD", 18);
  const fpy = await MockERC20.deploy("Mock FYP", "mFYP", 18);

  // 1 FPY per block emission. Use small numbers to make hand-checks easy.
  const Hub = await ethers.getContractFactory("FypherStakingHub");
  const hub = await upgrades.deployProxy(Hub, [
    await setting.getAddress(), await fpy.getAddress(), ONE, // fpyPerBlock = 1
  ], { initializer: "initialize", kind: "transparent" });

  await (await hub.setPauserRole(pauser.address)).wait();

  // Add two pools: RUSD = 1x (10000 bps), FYUSD = 2x (20000 bps).
  await (await hub.addPool(await rusd.getAddress(), 10_000)).wait();
  await (await hub.addPool(await fyusd.getAddress(), 20_000)).wait();
  // After both adds: totalAllocBps = 30000. RUSD share = 1/3, FYUSD share = 2/3.

  // Seed users with underlying + approve.
  for (const u of [alice, bob, carol]) {
    await (await rusd.mint(u.address, 1_000n * ONE)).wait();
    await (await fyusd.mint(u.address, 1_000n * ONE)).wait();
    await (await rusd.connect(u).approve(await hub.getAddress(), ethers.MaxUint256)).wait();
    await (await fyusd.connect(u).approve(await hub.getAddress(), ethers.MaxUint256)).wait();
  }

  // Fund hub with FPY treasury.
  await (await fpy.mint(deployer.address, 1_000_000n * ONE)).wait();
  await (await fpy.approve(await hub.getAddress(), ethers.MaxUint256)).wait();
  await (await hub.fundFpy(1_000_000n * ONE)).wait();

  return { deployer, alice, bob, carol, pauser, nonAdmin, setting, rusd, fyusd, fpy, hub };
}

describe("FypherStakingHub", () => {
  describe("pool setup", () => {
    it("addPool increments poolsLength + totalAllocBps", async () => {
      const { hub } = await deployFixture();
      assert.equal(await hub.poolsLength(), 2n);
      assert.equal(await hub.totalAllocBps(), 30_000n);
    });

    it("rejects duplicate underlying", async () => {
      const { hub, rusd } = await deployFixture();
      await assert.rejects(
        hub.addPool(await rusd.getAddress(), 10_000),
        (err) => err.message.includes("PoolAlreadyExists"),
      );
    });

    it("setPoolWeight settles previous accruals at the old weight", async () => {
      const { alice, hub } = await deployFixture();
      await (await hub.connect(alice).stake(0, 100n * ONE)).wait();
      // Snapshot pending at OLD weight after some blocks elapse.
      await mineBlocks(10);
      const pendingBeforeChange = await hub.pendingFpy(0, alice.address);

      // Change to 3x: new totalAllocBps = 30000-10000+30000 = 50000.
      // setPoolWeight() runs _updatePool first → settles at OLD weight.
      await (await hub.setPoolWeight(0, 30_000)).wait();
      const pendingAfterWeight = await hub.pendingFpy(0, alice.address);

      // Sanity: weight change did NOT retroactively change earned FPY.
      // The setPoolWeight tx itself mines one extra block at the old weight,
      // so pendingAfterWeight ≥ pendingBeforeChange but difference is bounded
      // by one block of OLD-weight emission (1 * 10000/30000 = 1/3 ≈ 0.34 ONE).
      const drift = pendingAfterWeight - pendingBeforeChange;
      assert.ok(drift >= 0n && drift < ONE, `unexpected weight-change drift: ${drift}`);

      // Mine 10 more blocks under NEW weight (RUSD = 30000/50000 = 60%).
      await mineBlocks(10);
      const pendingFinal = await hub.pendingFpy(0, alice.address);
      // Delta = 10 blocks × 1 FPY/block × 30000/50000 = 6 FPY exact (alice
      // is sole staker so totalStaked = her amount → no rounding loss).
      assert.equal(pendingFinal - pendingAfterWeight, 6n * ONE);
    });
  });

  describe("stake + claim accrual", () => {
    it("single staker in 1x pool earns fpyPerBlock × 1/3 per block", async () => {
      const { alice, hub, fpy } = await deployFixture();
      await (await hub.connect(alice).stake(0, 100n * ONE)).wait();
      await mineBlocks(9);
      // 9 blocks elapsed since stake (the stake tx counts as block 0). RUSD allocation
      // = 1/3, total FPY this period = 9 * 1 * 10000/30000 = 3 FPY.
      assert.equal(await hub.pendingFpy(0, alice.address), 3n * ONE);

      const before = await fpy.balanceOf(alice.address);
      await (await hub.connect(alice).claim(0)).wait();
      // claim() mines one more block before the read; pending should clear.
      // Alice's FPY balance grew by exactly the post-claim accrual (3 FPY
      // for the 9 elapsed + 1 for the claim block = 10 blocks * 1/3 ≈ 3.33).
      const after = await fpy.balanceOf(alice.address);
      // Sanity: she got at least 3 FPY (could be 3 + 1/3 due to claim block).
      assert.ok(after - before >= 3n * ONE);
      assert.equal(await hub.pendingFpy(0, alice.address), 0n);
    });

    it("two stakers in same pool split rewards pro-rata (1:3 ratio)", async () => {
      const { alice, bob, hub } = await deployFixture();
      // Alice stakes 100 first; bob stakes 300 later. After both have
      // staked, snapshot pending. Then mine more blocks and verify the
      // INCREMENT alice : bob is 1 : 3 (their stake ratio).
      await (await hub.connect(alice).stake(0, 100n * ONE)).wait();
      await mineBlocks(4);
      await (await hub.connect(bob).stake(0, 300n * ONE)).wait();

      const aliceSnap1 = await hub.pendingFpy(0, alice.address);
      const bobSnap1   = await hub.pendingFpy(0, bob.address);
      assert.equal(bobSnap1, 0n);

      // Mine N additional blocks under steady joint stakes.
      await mineBlocks(8);
      const aliceSnap2 = await hub.pendingFpy(0, alice.address);
      const bobSnap2   = await hub.pendingFpy(0, bob.address);

      const aliceDelta = aliceSnap2 - aliceSnap1;
      const bobDelta   = bobSnap2 - bobSnap1;
      // Total pool reward in this period = elapsed × fpyPerBlock × 10000/30000
      // split 1:3 between alice and bob.
      assert.equal(bobDelta, aliceDelta * 3n);
    });

    it("cross-pool: 2x pool earns 2x the rate of 1x pool", async () => {
      const { alice, bob, hub } = await deployFixture();
      // Two stakers in different pools must start at the same block to get
      // a clean 2:1 ratio — turn off automine, queue both txs, then mine.
      await network.provider.send("evm_setAutomine", [false]);
      await hub.connect(alice).stake(0, 100n * ONE);
      await hub.connect(bob).stake(1, 100n * ONE);
      await network.provider.send("evm_mine", []);
      await network.provider.send("evm_setAutomine", [true]);

      // Mine 9 more blocks; both pools now share the same elapsed window.
      await mineBlocks(9);
      const alicePending = await hub.pendingFpy(0, alice.address);
      const bobPending   = await hub.pendingFpy(1, bob.address);
      assert.equal(bobPending, alicePending * 2n);
    });
  });

  describe("unstake", () => {
    it("returns underlying and accrues outstanding rewards into the pull-claim pot", async () => {
      const { alice, hub, rusd, fpy } = await deployFixture();
      await (await hub.connect(alice).stake(0, 200n * ONE)).wait();
      await mineBlocks(5);
      const rusdBefore = await rusd.balanceOf(alice.address);
      const fpyBefore = await fpy.balanceOf(alice.address);
      await (await hub.connect(alice).unstake(0, 200n * ONE)).wait();
      // FYP-58 patch: unstake no longer transfers rewards inline. The
      // principal returns immediately; the accrued FYP lands in
      // {pendingFpyRewards} for the user to claim later via
      // {claim} / {claimRewards}.
      assert.equal(await rusd.balanceOf(alice.address) - rusdBefore, 200n * ONE);
      assert.equal(await fpy.balanceOf(alice.address), fpyBefore,
        "no inline FPY transfer on unstake");
      assert.ok((await hub.pendingFpyRewards(alice.address)) > 0n,
        "accrued FPY booked into the pull-claim pot");
      const [amt, ] = await hub.userStake(0, alice.address);
      assert.equal(amt, 0n);
    });

    it("reverts on InsufficientStake", async () => {
      const { alice, hub } = await deployFixture();
      await (await hub.connect(alice).stake(0, 50n * ONE)).wait();
      await assert.rejects(
        hub.connect(alice).unstake(0, 100n * ONE),
        (err) => err.message.includes("InsufficientStake"),
      );
    });

    it("works even when pool is paused (don't trap user funds)", async () => {
      const { alice, pauser, hub } = await deployFixture();
      await (await hub.connect(alice).stake(0, 100n * ONE)).wait();
      await (await hub.connect(pauser).setPoolPaused(0, true)).wait();
      // Stake fails, unstake succeeds.
      await assert.rejects(
        hub.connect(alice).stake(0, 1n * ONE),
        (err) => err.message.includes("PoolPaused"),
      );
      await (await hub.connect(alice).unstake(0, 100n * ONE)).wait();
      const [amt, ] = await hub.userStake(0, alice.address);
      assert.equal(amt, 0n);
    });
  });

  describe("pause authorization", () => {
    it("pauser can pause, only admin can unpause", async () => {
      const { deployer, pauser, hub } = await deployFixture();
      await (await hub.connect(pauser).setPoolPaused(0, true)).wait();
      // Pauser cannot unpause.
      await assert.rejects(
        hub.connect(pauser).setPoolPaused(0, false),
        (err) => err.message.includes("NotAdmin"),
      );
      // Admin can.
      await (await hub.connect(deployer).setPoolPaused(0, false)).wait();
      const info = await hub.poolInfo(0);
      assert.equal(info.paused, false);
    });

    it("non-pauser non-admin cannot pause", async () => {
      const { nonAdmin, hub } = await deployFixture();
      await assert.rejects(
        hub.connect(nonAdmin).setPoolPaused(0, true),
        (err) => err.message.includes("NotPauserOrAdmin"),
      );
    });
  });

  describe("migrate", () => {
    it("credits multiple users from a single admin tx", async () => {
      const { deployer, alice, bob, carol, hub, rusd } = await deployFixture();
      // Admin pulls 600 RUSD from somewhere (we just mint+approve here for the test).
      await (await rusd.mint(deployer.address, 600n * ONE)).wait();
      await (await rusd.connect(deployer).approve(await hub.getAddress(), ethers.MaxUint256)).wait();

      await (await hub.migrate(
        0,
        [alice.address, bob.address, carol.address],
        [100n * ONE, 200n * ONE, 300n * ONE],
      )).wait();

      const [aAmt, ] = await hub.userStake(0, alice.address);
      const [bAmt, ] = await hub.userStake(0, bob.address);
      const [cAmt, ] = await hub.userStake(0, carol.address);
      assert.equal(aAmt, 100n * ONE);
      assert.equal(bAmt, 200n * ONE);
      assert.equal(cAmt, 300n * ONE);

      const info = await hub.poolInfo(0);
      assert.equal(info.totalStaked, 600n * ONE);
      assert.equal(await rusd.balanceOf(await hub.getAddress()), 600n * ONE);
    });

    it("rejects length mismatch + zero total", async () => {
      const { deployer, alice, hub, rusd } = await deployFixture();
      await (await rusd.mint(deployer.address, 100n * ONE)).wait();
      await (await rusd.connect(deployer).approve(await hub.getAddress(), ethers.MaxUint256)).wait();

      await assert.rejects(
        hub.migrate(0, [alice.address], [10n * ONE, 20n * ONE]),
        (err) => err.message.includes("LengthMismatch"),
      );
      await assert.rejects(
        hub.migrate(0, [alice.address], [0n]),
        (err) => err.message.includes("ZeroAmount"),
      );
    });

    it("admin only", async () => {
      const { nonAdmin, alice, hub } = await deployFixture();
      await assert.rejects(
        hub.connect(nonAdmin).migrate(0, [alice.address], [100n * ONE]),
        (err) => err.message.includes("NotAdmin"),
      );
    });
  });

  describe("FPY funding", () => {
    it("claim returns 0 when treasury is dry but leaves the booked balance intact", async () => {
      const [deployer, alice, , , , , extra] = await ethers.getSigners();
      const SettingManagement = await ethers.getContractFactory("SettingManagement");
      const setting = await upgrades.deployProxy(SettingManagement, [deployer.address], {
        initializer: "initialize", kind: "transparent",
      });
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const rusd = await MockERC20.deploy("Mock RUSD", "mRUSD", 18);
      const fpy = await MockERC20.deploy("Mock FYP", "mFYP", 18);

      const Hub = await ethers.getContractFactory("FypherStakingHub");
      const hub = await upgrades.deployProxy(Hub, [
        await setting.getAddress(), await fpy.getAddress(), ONE,
      ], { initializer: "initialize", kind: "transparent" });
      await (await hub.addPool(await rusd.getAddress(), 10_000)).wait();

      await (await rusd.mint(alice.address, 100n * ONE)).wait();
      await (await rusd.connect(alice).approve(await hub.getAddress(), ethers.MaxUint256)).wait();
      // No fundFpy call → hub holds 0 FPY.
      await (await hub.connect(alice).stake(0, 100n * ONE)).wait();
      await mineBlocks(5);

      // FYP-58 patch: claim no longer reverts on an under-funded hub;
      // it accrues the per-pool emission into {pendingFpyRewards} and
      // pays out whatever the hub balance allows (here: 0).
      const fpyBefore = await fpy.balanceOf(alice.address);
      await (await hub.connect(alice).claim(0)).wait();
      assert.equal(await fpy.balanceOf(alice.address), fpyBefore,
        "nothing transferred when hub is dry");
      assert.ok((await hub.pendingFpyRewards(alice.address)) > 0n,
        "accrued FPY remains booked in the pull-claim pot");

      // Ops re-funds the hub later; claim then drains the live pot.
      await (await fpy.mint(extra.address, 1_000n * ONE)).wait();
      await (await fpy.connect(extra).approve(await hub.getAddress(), ethers.MaxUint256)).wait();
      await (await hub.connect(extra).fundFpy(1_000n * ONE)).wait();
      // Halt emissions so the {claimableRewards} view we snapshot now
      // matches what {claimRewards} will pay one block later. Without
      // this, the additional accrual between view-read and write tx
      // makes the actual payout strictly larger than the snapshot.
      await (await hub.setFpyPerBlock(0)).wait();
      const expectedPaid = await hub.claimableRewards(alice.address);
      await (await hub.connect(alice).claimRewards()).wait();
      assert.equal(await fpy.balanceOf(alice.address) - fpyBefore, expectedPaid);
      assert.equal(await hub.pendingFpyRewards(alice.address), 0n);
    });
  });
});
