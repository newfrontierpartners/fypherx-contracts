/**
 * Phase 1 invariant suite — per briefing §"테스트 필수":
 *
 *   - "RUSD 발행량 ≤ collateral value 항상 성립"
 *   - "sRUSD 발행량 == underlying RUSD 항상 성립"
 *   - "Epoch 마감 후 미배포 잔량 == 0"
 *
 * Plus two enforcement invariants we want a separate red-line test for:
 *
 *   - FPY emission conservation (sum of paid + pending == accrued)
 *   - Burn 7-day gate is never bypassed (no early claim ever passes)
 *
 * These are cross-contract integration-style tests that exercise full
 * user flows and assert the invariant after each material state
 * transition. They complement the per-contract suites (which already
 * validate happy paths and per-call reverts).
 */
const assert = require("node:assert/strict");
const { ethers, upgrades, network } = require("hardhat");

const ONE = 10n ** 18n;
const SEVEN_DAYS = 7n * 24n * 60n * 60n;
const TEN_HOURS = 10n * 60n * 60n;
const TWELVE_HOURS = 12n * 60n * 60n;

async function increaseTime(seconds) {
  await network.provider.send("evm_increaseTime", [Number(seconds)]);
  await network.provider.send("evm_mine", []);
}

async function mineBlocks(n) {
  for (let i = 0; i < n; ++i) await network.provider.send("evm_mine", []);
}

async function nowPlus(seconds) {
  const blk = await ethers.provider.getBlock("latest");
  return BigInt(blk.timestamp + seconds);
}

// EIP-712 helpers for FypherMinting (matches main's audit-patched ABI).
const ORDER_TYPES = {
  Order: [
    { name: "orderType",         type: "uint8"   },
    { name: "benefactor",        type: "address" },
    { name: "beneficiary",       type: "address" },
    { name: "collateral_asset",  type: "address" },
    { name: "collateral_amount", type: "uint256" },
    { name: "rusd_amount",       type: "uint256" },
    { name: "nonce",             type: "uint256" },
    { name: "expiry",            type: "uint256" },
  ],
};
const ORDER_TYPE = { MINT: 0, REDEEM: 1 };

async function signMintOrder(signer, mintingAddress, order) {
  const network = await ethers.provider.getNetwork();
  const domain = {
    name: "FypherMinting",
    version: "1",
    chainId: Number(network.chainId),
    verifyingContract: mintingAddress,
  };
  return signer.signTypedData(domain, ORDER_TYPES, { ...order, orderType: ORDER_TYPE.MINT });
}

// EIP-712 signing helpers post-FYP-07. Both helpers now require the
// verifying contract address so the domain separator binds correctly.
async function signBurnQuote(signer, quote, queueAddress) {
  const { chainId } = await ethers.provider.getNetwork();
  return signer.signTypedData(
    {
      name: "FypherBurnQueue",
      version: "1",
      chainId,
      verifyingContract: queueAddress,
    },
    {
      BurnQuote: [
        { name: "user", type: "address" },
        { name: "collateralAsset", type: "address" },
        { name: "rusdAmount", type: "uint256" },
        { name: "collateralAmount", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "expiry", type: "uint256" },
      ],
    },
    quote,
  );
}

async function signDepositQuote(signer, quote, epochAddress) {
  const { chainId } = await ethers.provider.getNetwork();
  return signer.signTypedData(
    {
      name: "FyusdEpochSettlement",
      version: "1",
      chainId,
      verifyingContract: epochAddress,
    },
    {
      DepositQuote: [
        { name: "user", type: "address" },
        { name: "epochId", type: "uint256" },
        { name: "collateralAsset", type: "address" },
        { name: "collateralAmount", type: "uint256" },
        { name: "fyusdAmount", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "expiry", type: "uint256" },
      ],
    },
    quote,
  );
}

// ── Fixture helpers ──

async function deployFullStack() {
  const [deployer, alice, bob, carol, backend, executor, custodian, pauser] =
    await ethers.getSigners();

  const SettingManagement = await ethers.getContractFactory("SettingManagement");
  const setting = await upgrades.deployProxy(SettingManagement, [deployer.address], {
    initializer: "initialize", kind: "transparent",
  });

  const RUSD = await ethers.getContractFactory("RUSD");
  const rusd = await upgrades.deployProxy(RUSD, [deployer.address], {
    initializer: "initialize", kind: "transparent",
  });

  const FYUSD = await ethers.getContractFactory("FYUSD");
  const fyusd = await upgrades.deployProxy(FYUSD, [deployer.address], {
    initializer: "initialize", kind: "transparent",
  });

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const usdt = await MockERC20.deploy("Mock USDT", "mUSDT", 18);
  const fpy  = await MockERC20.deploy("Mock FYP",  "mFYP",  18);

  // FypherMinting (the upstream RUSD mint authority).
  const Minting = await ethers.getContractFactory("FypherMinting");
  const minting = await upgrades.deployProxy(Minting, [
    await setting.getAddress(), await rusd.getAddress(),
    backend.address, executor.address,
  ], { initializer: "initialize", kind: "transparent" });
  await (await rusd.setMinter(await minting.getAddress())).wait();
  await (await minting.addSupportedAsset(await usdt.getAddress())).wait();
  await (await minting.addCustodianAddress(custodian.address)).wait();

  // FypherBurnQueue.
  const BurnQueue = await ethers.getContractFactory("FypherBurnQueue");
  const burnQueue = await upgrades.deployProxy(BurnQueue, [
    await setting.getAddress(), await rusd.getAddress(), backend.address,
  ], { initializer: "initialize", kind: "transparent" });
  await (await burnQueue.setSupportedAsset(await usdt.getAddress(), true)).wait();

  // FypherStakingHub with one pool (RUSD, weight 1x).
  const Hub = await ethers.getContractFactory("FypherStakingHub");
  const hub = await upgrades.deployProxy(Hub, [
    await setting.getAddress(), await fpy.getAddress(), ONE, // 1 FPY/block
  ], { initializer: "initialize", kind: "transparent" });
  await (await hub.addPool(await rusd.getAddress(), 10_000)).wait();
  // Fund FPY treasury inside hub.
  await (await fpy.mint(deployer.address, 1_000_000n * ONE)).wait();
  await (await fpy.approve(await hub.getAddress(), ethers.MaxUint256)).wait();
  await (await hub.fundFpy(1_000_000n * ONE)).wait();

  // FyusdEpochSettlement.
  const EpochSettlement = await ethers.getContractFactory("FyusdEpochSettlement");
  const epoch = await upgrades.deployProxy(EpochSettlement, [
    await setting.getAddress(), await fyusd.getAddress(),
    backend.address, executor.address,
  ], { initializer: "initialize", kind: "transparent" });
  await (await fyusd.setMinter(await epoch.getAddress())).wait();
  await (await epoch.setSupportedAsset(await usdt.getAddress(), true)).wait();

  // Seed users with USDT + approvals.
  for (const u of [alice, bob, carol]) {
    await (await usdt.mint(u.address, 100_000n * ONE)).wait();
    await (await usdt.connect(u).approve(await minting.getAddress(), ethers.MaxUint256)).wait();
    await (await usdt.connect(u).approve(await epoch.getAddress(),   ethers.MaxUint256)).wait();
  }

  return {
    deployer, alice, bob, carol, backend, executor, custodian, pauser,
    setting, rusd, fyusd, usdt, fpy, minting, burnQueue, hub, epoch,
  };
}

async function doMint(ctx, user, amount, nonce) {
  const order = {
    benefactor: user.address,
    beneficiary: user.address,
    collateral_asset: await ctx.usdt.getAddress(),
    collateral_amount: amount,
    rusd_amount: amount,
    nonce: BigInt(nonce),
    expiry: await nowPlus(600),
  };
  const sig = await signMintOrder(ctx.backend, await ctx.minting.getAddress(), order);
  await (await ctx.minting.connect(user).mint(order, { addresses: [ctx.custodian.address], ratios: [10000] }, sig)).wait();
}

// ─────────────────────────────────────────────────────────────────────
// Invariant 1: RUSD supply ≤ collateral held by the protocol.
//
// In the test we use a 1:1 USDT⇔RUSD pricing assumption (the contract
// makes no oracle assumption — the backend's signed order pins the
// rate). So at any point:
//
//   rusd.totalSupply() == sum of all `collateral_amount` values that
//                         have been transferred to custodians via mint(),
//                         minus any collateral that has been claimed
//                         back from FypherBurnQueue.
//
// We verify the conservation across a mint → request-burn → claim
// sequence and at every state checkpoint.
// ─────────────────────────────────────────────────────────────────────

describe("Invariant 1: RUSD totalSupply ≤ collateral backing", () => {
  it("conservation across mint → request-burn → claim", async () => {
    const ctx = await deployFullStack();

    // Approve burn queue to burnFrom RUSD on alice's behalf.
    await (await ctx.rusd.connect(ctx.alice).approve(await ctx.burnQueue.getAddress(), ethers.MaxUint256)).wait();

    // 1) Alice mints 200 RUSD against 200 USDT.
    await doMint(ctx, ctx.alice, 200n * ONE, 1);
    // After mint: 200 RUSD outstanding, 200 USDT held by custodian.
    let rusdSupply = await ctx.rusd.totalSupply();
    let collateral = await ctx.usdt.balanceOf(ctx.custodian.address);
    assert.equal(rusdSupply, 200n * ONE, "RUSD supply after mint");
    assert.equal(collateral, 200n * ONE, "Custodian collateral after mint");
    assert.ok(rusdSupply <= collateral, "Invariant: RUSD <= collateral after mint");

    // 2) Bob mints 300 RUSD.
    await doMint(ctx, ctx.bob, 300n * ONE, 2);
    rusdSupply = await ctx.rusd.totalSupply();
    collateral = await ctx.usdt.balanceOf(ctx.custodian.address);
    assert.equal(rusdSupply, 500n * ONE);
    assert.equal(collateral, 500n * ONE);
    assert.ok(rusdSupply <= collateral, "Invariant: RUSD <= collateral after second mint");

    // 3) Top up burn queue with USDT (custodian moves liquidity).
    await (await ctx.usdt.connect(ctx.custodian).approve(await ctx.burnQueue.getAddress(), ethers.MaxUint256)).wait();
    await (await ctx.burnQueue.connect(ctx.custodian).topUp(await ctx.usdt.getAddress(), 200n * ONE)).wait();
    // Conservation: collateral pool = 500 USDT (300 in custodian + 200 in burn queue).
    const pool = (await ctx.usdt.balanceOf(ctx.custodian.address)) + (await ctx.usdt.balanceOf(await ctx.burnQueue.getAddress()));
    assert.equal(pool, 500n * ONE, "Total collateral pool unchanged after topUp");
    assert.ok(rusdSupply <= pool, "Invariant: RUSD <= total collateral");

    // 4) Alice requests a burn of 200 RUSD (immediate burn).
    const quote = {
      user: ctx.alice.address,
      collateralAsset: await ctx.usdt.getAddress(),
      rusdAmount: 200n * ONE,
      collateralAmount: 200n * ONE,
      nonce: 100n,
      expiry: await nowPlus(600),
    };
    const sig = await signBurnQuote(ctx.backend, quote, await ctx.burnQueue.getAddress());
    await (await ctx.burnQueue.connect(ctx.alice).requestBurn(quote, sig)).wait();
    // After burn: RUSD supply = 300 (200 burned), total collateral pool still 500
    // but 200 of that is committed liability inside the burn queue (Alice's ticket).
    rusdSupply = await ctx.rusd.totalSupply();
    const burnQueuePool = await ctx.usdt.balanceOf(await ctx.burnQueue.getAddress());
    const custodianPool = await ctx.usdt.balanceOf(ctx.custodian.address);
    const liability = await ctx.burnQueue.outstandingLiability(await ctx.usdt.getAddress());
    assert.equal(rusdSupply, 300n * ONE, "RUSD supply after burn");
    assert.equal(liability, 200n * ONE, "outstandingLiability after burn");
    // Free collateral = (custodian pool) + (burn queue pool - liability) = 300 + (200 - 200) = 300
    const free = custodianPool + (burnQueuePool - liability);
    assert.ok(rusdSupply <= free + liability, "Invariant: RUSD supply <= free + reserved");

    // 5) After 7 days alice claims; collateral leaves the queue, liability cleared.
    await increaseTime(SEVEN_DAYS + 1n);
    await (await ctx.burnQueue.claim(1n)).wait();
    const liabilityAfter = await ctx.burnQueue.outstandingLiability(await ctx.usdt.getAddress());
    assert.equal(liabilityAfter, 0n);
    // Final state: 300 RUSD outstanding, 300 USDT in custodian (alice took 200 out).
    rusdSupply = await ctx.rusd.totalSupply();
    const finalCollateral = await ctx.usdt.balanceOf(ctx.custodian.address)
                          + await ctx.usdt.balanceOf(await ctx.burnQueue.getAddress());
    assert.equal(rusdSupply, 300n * ONE);
    assert.equal(finalCollateral, 300n * ONE);
    assert.ok(rusdSupply <= finalCollateral, "Invariant: RUSD <= collateral after claim");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Invariant 2: stake amount accounting in FypherStakingHub.
//
// pool.totalStaked == sum of stakes[user].amount across all users in
// that pool, AND pool.totalStaked == underlying.balanceOf(hub) for
// that asset (modulo any FPY treasury balance, since the hub also
// holds the FPY token).
//
// This is the post-StakingHub spec equivalent of "sRUSD == underlying":
// the hub doesn't issue an ERC4626 share token but the position-amount
// IS the user's redeemable underlying.
// ─────────────────────────────────────────────────────────────────────

describe("Invariant 2: pool.totalStaked == sum(user stakes) == underlying balance", () => {
  it("holds across stake / unstake / multi-user mixed sequence", async () => {
    const ctx = await deployFullStack();

    // Mint RUSD to alice + bob + carol so they can stake.
    await doMint(ctx, ctx.alice, 1000n * ONE, 1);
    await doMint(ctx, ctx.bob,   1000n * ONE, 2);
    await doMint(ctx, ctx.carol, 1000n * ONE, 3);
    for (const u of [ctx.alice, ctx.bob, ctx.carol]) {
      await (await ctx.rusd.connect(u).approve(await ctx.hub.getAddress(), ethers.MaxUint256)).wait();
    }

    async function checkInvariant() {
      const info = await ctx.hub.poolInfo(0);
      const a = (await ctx.hub.userStake(0, ctx.alice.address))[0];
      const b = (await ctx.hub.userStake(0, ctx.bob.address))[0];
      const c = (await ctx.hub.userStake(0, ctx.carol.address))[0];
      const sumUsers = a + b + c;
      assert.equal(info.totalStaked, sumUsers, "Invariant: totalStaked == sum(user stakes)");
      const hubBalance = await ctx.rusd.balanceOf(await ctx.hub.getAddress());
      assert.equal(info.totalStaked, hubBalance, "Invariant: totalStaked == hub RUSD balance");
    }

    await (await ctx.hub.connect(ctx.alice).stake(0, 200n * ONE)).wait();
    await checkInvariant();
    await (await ctx.hub.connect(ctx.bob).stake(0, 500n * ONE)).wait();
    await checkInvariant();
    await (await ctx.hub.connect(ctx.alice).unstake(0, 50n * ONE)).wait();
    await checkInvariant();
    await (await ctx.hub.connect(ctx.carol).stake(0, 700n * ONE)).wait();
    await checkInvariant();
    await (await ctx.hub.connect(ctx.bob).unstake(0, 500n * ONE)).wait();
    await checkInvariant();
    await (await ctx.hub.connect(ctx.alice).unstake(0, 150n * ONE)).wait();
    await checkInvariant();
    await (await ctx.hub.connect(ctx.carol).unstake(0, 700n * ONE)).wait();
    await checkInvariant();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Invariant 3: epoch leftover after distribution == 0 (with rounding).
//
// After all depositors in an epoch have claimed, epoch.fyusdMinted -
// epoch.fyusdDistributed should be exactly 0 if fyusdMinted equals
// totalFyusdEntitled, and bounded by O(N) wei when there's a mismatch
// due to integer division per user.
// ─────────────────────────────────────────────────────────────────────

describe("Invariant 3: epoch leftover == 0 after all claims", () => {
  it("perfect-settlement epoch distributes exactly fyusdMinted", async () => {
    const ctx = await deployFullStack();

    await (await ctx.epoch.openEpoch(Number(TWELVE_HOURS), Number(TEN_HOURS))).wait();

    // Alice 100, Bob 200, Carol 300 (all USDT, all entitled to same FYUSD).
    for (const [user, amt, nonce] of [
      [ctx.alice, 100n * ONE, 1n],
      [ctx.bob,   200n * ONE, 2n],
      [ctx.carol, 300n * ONE, 3n],
    ]) {
      const q = {
        user: user.address,
        epochId: 1n,
        collateralAsset: await ctx.usdt.getAddress(),
        collateralAmount: amt,
        fyusdAmount: amt,
        nonce,
        expiry: await nowPlus(600),
      };
      const sig = await signDepositQuote(ctx.backend, q, await ctx.epoch.getAddress());
      await (await ctx.epoch.connect(user).deposit(q, sig)).wait();
    }

    await increaseTime(TEN_HOURS + 1n);
    await (await ctx.epoch.lockEpoch(1n)).wait();
    await (await ctx.epoch.connect(ctx.executor).settleEpoch(1n, 600n * ONE)).wait();

    await (await ctx.epoch.claim(1n, ctx.alice.address)).wait();
    await (await ctx.epoch.claim(1n, ctx.bob.address)).wait();
    await (await ctx.epoch.claim(1n, ctx.carol.address)).wait();

    const e = await ctx.epoch.epochs(1n);
    assert.equal(e.fyusdDistributed, e.fyusdMinted, "Invariant: leftover == 0");
    assert.equal(await ctx.fyusd.balanceOf(await ctx.epoch.getAddress()), 0n, "no FYUSD stranded");
  });

  it("shortfall settlement leaves at most O(users) wei dust", async () => {
    const ctx = await deployFullStack();
    await (await ctx.epoch.openEpoch(Number(TWELVE_HOURS), Number(TEN_HOURS))).wait();

    // Three deposits totalling 7 (forces non-integer pro-rata: 2/7, 2/7, 3/7).
    for (const [user, amt, nonce] of [
      [ctx.alice, 2n * ONE, 1n],
      [ctx.bob,   2n * ONE, 2n],
      [ctx.carol, 3n * ONE, 3n],
    ]) {
      const q = {
        user: user.address,
        epochId: 1n,
        collateralAsset: await ctx.usdt.getAddress(),
        collateralAmount: amt,
        fyusdAmount: amt,
        nonce,
        expiry: await nowPlus(600),
      };
      await (await ctx.epoch.connect(user).deposit(q, await signDepositQuote(ctx.backend, q, await ctx.epoch.getAddress()))).wait();
    }
    await increaseTime(TEN_HOURS + 1n);
    await (await ctx.epoch.lockEpoch(1n)).wait();

    // Bitgo paid 5 of 7 entitled — 5/7 ratio per user.
    await (await ctx.epoch.connect(ctx.executor).settleEpoch(1n, 5n * ONE)).wait();

    await (await ctx.epoch.claim(1n, ctx.alice.address)).wait();
    await (await ctx.epoch.claim(1n, ctx.bob.address)).wait();
    await (await ctx.epoch.claim(1n, ctx.carol.address)).wait();

    const e = await ctx.epoch.epochs(1n);
    const dust = e.fyusdMinted - e.fyusdDistributed;
    assert.ok(dust < 10n, `dust must be < 10 wei, got ${dust}`);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Invariant 4: FPY emission conservation.
//
// fpyClaimed(user) + fpyPending(user) ≈ accruedFpy(user)
// where accruedFpy = fpyPerBlock × elapsedBlocks × poolWeightShare ×
//                    user_share_of_pool
// over the user's holding period.
//
// We verify by:
//   - tracking totalFpyPaid via Transfer events from hub's FPY balance
//   - comparing to (fpyPerBlock × elapsedBlocks × 1.0) since there's
//     only one pool with weightBps=10000 == totalAllocBps
// ─────────────────────────────────────────────────────────────────────

describe("Invariant 4: FPY emission conservation", () => {
  it("total FPY paid + pending == fpyPerBlock × elapsed (sole-pool, sole-staker)", async () => {
    const ctx = await deployFullStack();

    await doMint(ctx, ctx.alice, 1000n * ONE, 1);
    await (await ctx.rusd.connect(ctx.alice).approve(await ctx.hub.getAddress(), ethers.MaxUint256)).wait();

    const stakeTx = await ctx.hub.connect(ctx.alice).stake(0, 1000n * ONE);
    const stakeReceipt = await stakeTx.wait();
    const stakeBlock = stakeReceipt.blockNumber;

    await mineBlocks(20);
    const claimTx = await ctx.hub.connect(ctx.alice).claim(0);
    const claimReceipt = await claimTx.wait();
    const claimBlock = claimReceipt.blockNumber;

    const elapsed = BigInt(claimBlock - stakeBlock);
    const expected = elapsed * ONE; // fpyPerBlock × elapsed × 1.0
    const fpyPaid = await ctx.fpy.balanceOf(ctx.alice.address);

    // Allow ±1 wei drift for the integer-math accumulator update on claim.
    const drift = fpyPaid > expected ? fpyPaid - expected : expected - fpyPaid;
    assert.ok(drift <= 1n, `expected ≈ ${expected}, got ${fpyPaid} (drift ${drift})`);

    // Pending should be ≤ 1 wei (any unclaimed dust).
    const pending = await ctx.hub.pendingFpy(0, ctx.alice.address);
    assert.ok(pending <= 1n, `pending must be ~0, got ${pending}`);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Invariant 5: 7-day burn delay is never bypassed.
//
// Property: every successful BurnClaimed event has block.timestamp >=
// requestedAt + 7 days. We exercise the time boundary at:
//   - exactly requestedAt + 7d - 1s   (must revert)
//   - exactly requestedAt + 7d        (must succeed)
// Note: Hardhat's evm_increaseTime is approximate, so we use the
// contract's own EarlyClaim revert as the binding red line.
// ─────────────────────────────────────────────────────────────────────

describe("Invariant 5: 7-day burn delay is never bypassed", () => {
  it("EarlyClaim at exactly 7d - 2s; success right after the boundary", async () => {
    const ctx = await deployFullStack();
    await doMint(ctx, ctx.alice, 100n * ONE, 1);
    await (await ctx.rusd.connect(ctx.alice).approve(await ctx.burnQueue.getAddress(), ethers.MaxUint256)).wait();
    await (await ctx.usdt.connect(ctx.custodian).approve(await ctx.burnQueue.getAddress(), ethers.MaxUint256)).wait();
    await (await ctx.burnQueue.connect(ctx.custodian).topUp(await ctx.usdt.getAddress(), 100n * ONE)).wait();

    const quote = {
      user: ctx.alice.address,
      collateralAsset: await ctx.usdt.getAddress(),
      rusdAmount: 100n * ONE,
      collateralAmount: 100n * ONE,
      nonce: 1n,
      expiry: await nowPlus(600),
    };
    await (await ctx.burnQueue.connect(ctx.alice).requestBurn(quote, await signBurnQuote(ctx.backend, quote, await ctx.burnQueue.getAddress()))).wait();

    // Move to (requestedAt + 7d - 2s). claim should still revert.
    await increaseTime(SEVEN_DAYS - 2n);
    await assert.rejects(
      ctx.burnQueue.claim(1n),
      (err) => err.message.includes("EarlyClaim"),
    );

    // Cross the boundary: 3 more seconds (covers any auto-mine drift).
    await increaseTime(3n);
    const tx = await ctx.burnQueue.claim(1n);
    const receipt = await tx.wait();
    const blk = await ethers.provider.getBlock(receipt.blockNumber);
    const t = await ctx.burnQueue.tickets(1n);
    const claimableAt = BigInt(t.requestedAt) + SEVEN_DAYS;
    assert.ok(BigInt(blk.timestamp) >= claimableAt,
      `block.timestamp(${blk.timestamp}) >= claimableAt(${claimableAt})`);
  });
});
