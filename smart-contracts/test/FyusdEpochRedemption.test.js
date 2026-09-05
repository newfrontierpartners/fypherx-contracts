/**
 * FyusdEpochRedemption tests — symmetric mirror of FyusdEpochSettlement.test.js.
 *
 * Covers ADR-011:
 *   - Epoch lifecycle: openEpoch -> requestRedeem -> lockEpoch (time-gated)
 *     -> settleEpoch (executor pre-funds collateral) -> claim (pro-rata
 *     collateral payout in chosen asset).
 *   - cancelEpoch refund path: escrowed FYUSD returned, NOT collateral.
 *   - Per-asset request pause + settlement pause (mirrors ADR-008).
 *   - Backend-signed redeem quote: replay protection, expiry, signer
 *     rotation invalidates old quotes.
 *   - Pro-rata math under perfect + shortfall settlement.
 */
const assert = require("node:assert/strict");
const { ethers, upgrades, network } = require("hardhat");

const ONE = 10n ** 18n;
const TWELVE_HOURS = 12n * 60n * 60n;
const TEN_HOURS = 10n * 60n * 60n;

async function increaseTime(seconds) {
  await network.provider.send("evm_increaseTime", [Number(seconds)]);
  await network.provider.send("evm_mine", []);
}

async function nowPlus(seconds) {
  const blk = await ethers.provider.getBlock("latest");
  return BigInt(blk.timestamp + seconds);
}

/**
 * Sign a RedeemQuote using the EIP-712 envelope post-FYP-07.
 */
async function signRedeemQuote(signer, quote, redemption) {
  const verifyingContract =
    typeof redemption === "string" ? redemption : await redemption.getAddress();
  const { chainId } = await ethers.provider.getNetwork();
  const domain = {
    name: "FyusdEpochRedemption",
    version: "1",
    chainId,
    verifyingContract,
  };
  const types = {
    RedeemQuote: [
      { name: "user", type: "address" },
      { name: "epochId", type: "uint256" },
      { name: "fyusdAmount", type: "uint256" },
      { name: "targetAsset", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "expiry", type: "uint256" },
    ],
  };
  return signer.signTypedData(domain, types, quote);
}

async function deployFixture() {
  const [deployer, alice, bob, carol, backend, executor, pauser, nonAdmin] =
    await ethers.getSigners();

  const SettingManagement = await ethers.getContractFactory("SettingManagement");
  const setting = await upgrades.deployProxy(SettingManagement, [deployer.address], {
    initializer: "initialize", kind: "transparent",
  });

  const FYUSD = await ethers.getContractFactory("FYUSD");
  const fyusd = await upgrades.deployProxy(FYUSD, [deployer.address], {
    initializer: "initialize", kind: "transparent",
  });

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const usdt = await MockERC20.deploy("Mock USDT", "mUSDT", 18);
  const usdc = await MockERC20.deploy("Mock USDC", "mUSDC", 18);

  const Redemption = await ethers.getContractFactory("FyusdEpochRedemption");
  const redemption = await upgrades.deployProxy(Redemption, [
    await setting.getAddress(),
    await fyusd.getAddress(),
    backend.address,
    executor.address,
  ], { initializer: "initialize", kind: "transparent" });

  // Whitelist USDT + USDC + pauser role.
  await (await redemption.setSupportedAsset(await usdt.getAddress(), true)).wait();
  await (await redemption.setSupportedAsset(await usdc.getAddress(), true)).wait();
  await (await redemption.setPauserRole(pauser.address)).wait();

  // Mint FYUSD to users + executor (executor pre-funds collateral on settle).
  await (await fyusd.setMinter(deployer.address)).wait();
  for (const u of [alice, bob, carol]) {
    await (await fyusd.mint(u.address, 10_000n * ONE)).wait();
    await (await fyusd.connect(u).approve(await redemption.getAddress(), ethers.MaxUint256)).wait();
  }
  // Executor needs USDT/USDC to pre-fund settle calls.
  await (await usdt.mint(executor.address, 1_000_000n * ONE)).wait();
  await (await usdc.mint(executor.address, 1_000_000n * ONE)).wait();
  await (await usdt.connect(executor).approve(await redemption.getAddress(), ethers.MaxUint256)).wait();
  await (await usdc.connect(executor).approve(await redemption.getAddress(), ethers.MaxUint256)).wait();

  return { deployer, alice, bob, carol, backend, executor, pauser, nonAdmin,
           setting, fyusd, usdt, usdc, redemption };
}

describe("FyusdEpochRedemption (ADR-011)", () => {
  describe("openEpoch + state machine", () => {
    it("opens an epoch with the requested duration / lockOffset", async () => {
      const { redemption } = await deployFixture();
      await (await redemption.openEpoch(Number(TWELVE_HOURS), Number(TEN_HOURS))).wait();
      assert.equal(await redemption.nextEpochId(), 1n);
      const e = await redemption.epochs(1n);
      assert.equal(e.state, 1n); // OPEN
      assert.equal(BigInt(e.lockAt) - BigInt(e.openAt), TEN_HOURS);
      assert.equal(BigInt(e.endAt) - BigInt(e.openAt), TWELVE_HOURS);
    });

    it("rejects lockOffset >= duration", async () => {
      const { redemption } = await deployFixture();
      await assert.rejects(
        redemption.openEpoch(Number(TEN_HOURS), Number(TWELVE_HOURS)),
        (err) => err.message.includes("InvalidLockOffset"),
      );
    });

    it("openEpoch is admin-only", async () => {
      const { redemption, nonAdmin } = await deployFixture();
      await assert.rejects(
        redemption.connect(nonAdmin).openEpoch(Number(TWELVE_HOURS), Number(TEN_HOURS)),
        (err) => err.message.includes("NotAdmin"),
      );
    });

    it("lockEpoch transitions OPEN -> LOCKED only after lockAt", async () => {
      const { redemption } = await deployFixture();
      await (await redemption.openEpoch(Number(TWELVE_HOURS), Number(TEN_HOURS))).wait();
      await assert.rejects(
        redemption.lockEpoch(1n),
        (err) => err.message.includes("EpochStillOpen"),
      );
      await increaseTime(TEN_HOURS + 1n);
      await (await redemption.lockEpoch(1n)).wait();
      const e = await redemption.epochs(1n);
      assert.equal(e.state, 2n); // LOCKED
    });
  });

  describe("requestRedeem + escrow", () => {
    it("escrows FYUSD on the contract + records per-user request", async () => {
      const { alice, backend, fyusd, usdt, redemption } = await deployFixture();
      await (await redemption.openEpoch(Number(TWELVE_HOURS), Number(TEN_HOURS))).wait();

      const aliceBal0 = await fyusd.balanceOf(alice.address);
      const quote = {
        user: alice.address, epochId: 1n,
        fyusdAmount: 200n * ONE, targetAsset: await usdt.getAddress(),
        nonce: 1n, expiry: await nowPlus(3600),
      };
      const sig = await signRedeemQuote(backend, quote, redemption);
      await (await redemption.connect(alice).requestRedeem(quote, sig)).wait();

      assert.equal(await fyusd.balanceOf(alice.address), aliceBal0 - 200n * ONE);
      assert.equal(await fyusd.balanceOf(await redemption.getAddress()), 200n * ONE);
      assert.equal(await redemption.fyusdRequested(1n, alice.address), 200n * ONE);
      assert.equal(await redemption.targetAsset(1n, alice.address), await usdt.getAddress());
      const e = await redemption.epochs(1n);
      assert.equal(e.totalFyusdRequested, 200n * ONE);
    });

    it("rejects requests on locked epochs", async () => {
      const { alice, backend, usdt, redemption } = await deployFixture();
      await (await redemption.openEpoch(Number(TWELVE_HOURS), Number(TEN_HOURS))).wait();
      await increaseTime(TEN_HOURS + 1n);
      await (await redemption.lockEpoch(1n)).wait();

      const quote = {
        user: alice.address, epochId: 1n,
        fyusdAmount: 100n * ONE, targetAsset: await usdt.getAddress(),
        nonce: 1n, expiry: await nowPlus(3600),
      };
      const sig = await signRedeemQuote(backend, quote, redemption);
      await assert.rejects(
        redemption.connect(alice).requestRedeem(quote, sig),
        (err) => err.message.includes("InvalidState") || err.message.includes("EpochAlreadyLocked"),
      );
    });

    it("rejects unsupported asset, expired quote, replayed nonce", async () => {
      const { alice, backend, redemption, usdt } = await deployFixture();
      await (await redemption.openEpoch(Number(TWELVE_HOURS), Number(TEN_HOURS))).wait();

      // unsupported asset
      const bad = {
        user: alice.address, epochId: 1n, fyusdAmount: 1n * ONE,
        targetAsset: alice.address /* not whitelisted */,
        nonce: 1n, expiry: await nowPlus(3600),
      };
      await assert.rejects(
        redemption.connect(alice).requestRedeem(bad, await signRedeemQuote(backend, bad, redemption)),
        (err) => err.message.includes("UnsupportedAsset"),
      );

      // expired
      const stale = {
        user: alice.address, epochId: 1n, fyusdAmount: 1n * ONE,
        targetAsset: await usdt.getAddress(),
        nonce: 2n, expiry: 1n,
      };
      await assert.rejects(
        redemption.connect(alice).requestRedeem(stale, await signRedeemQuote(backend, stale, redemption)),
        (err) => err.message.includes("ExpiredQuote"),
      );

      // replay
      const ok = {
        user: alice.address, epochId: 1n, fyusdAmount: 5n * ONE,
        targetAsset: await usdt.getAddress(),
        nonce: 3n, expiry: await nowPlus(3600),
      };
      const sig = await signRedeemQuote(backend, ok, redemption);
      await (await redemption.connect(alice).requestRedeem(ok, sig)).wait();
      await assert.rejects(
        redemption.connect(alice).requestRedeem(ok, sig),
        (err) => err.message.includes("NonceAlreadyUsed"),
      );
    });

    it("rejects requests with the wrong signer", async () => {
      const { alice, nonAdmin, redemption, usdt } = await deployFixture();
      await (await redemption.openEpoch(Number(TWELVE_HOURS), Number(TEN_HOURS))).wait();
      const quote = {
        user: alice.address, epochId: 1n, fyusdAmount: 1n * ONE,
        targetAsset: await usdt.getAddress(),
        nonce: 1n, expiry: await nowPlus(3600),
      };
      const wrongSig = await signRedeemQuote(nonAdmin, quote, redemption);
      await assert.rejects(
        redemption.connect(alice).requestRedeem(quote, wrongSig),
        (err) => err.message.includes("InvalidSignature"),
      );
    });
  });

  describe("settleEpoch + claim (pro-rata)", () => {
    async function setupAtSettle({ alice, bob, backend, redemption, usdt }) {
      await (await redemption.openEpoch(Number(TWELVE_HOURS), Number(TEN_HOURS))).wait();
      // alice requests 100, bob 300 → totalRequested = 400
      for (const [u, amt, n] of [[alice, 100n, 1n], [bob, 300n, 2n]]) {
        const q = {
          user: u.address, epochId: 1n, fyusdAmount: amt * ONE,
          targetAsset: await usdt.getAddress(), nonce: n, expiry: await nowPlus(3600),
        };
        await (await redemption.connect(u).requestRedeem(q, await signRedeemQuote(backend, q, redemption))).wait();
      }
      await increaseTime(TEN_HOURS + 1n);
      await (await redemption.lockEpoch(1n)).wait();
    }

    it("perfect settlement pays each user pro-rata; FYUSD is burned", async () => {
      const { alice, bob, backend, executor, fyusd, usdt, redemption } = await deployFixture();
      await setupAtSettle({ alice, bob, backend, redemption, usdt });

      const fyusdSupplyBefore = await fyusd.totalSupply();
      // 1:1 par settlement → wire 400 USDT
      await (await redemption.connect(executor).settleEpoch(
        1n, 400n * ONE, await usdt.getAddress(),
      )).wait();
      // 400 FYUSD burned from contract
      assert.equal(await fyusd.balanceOf(await redemption.getAddress()), 0n);
      assert.equal(await fyusd.totalSupply(), fyusdSupplyBefore - 400n * ONE);

      const aBefore = await usdt.balanceOf(alice.address);
      const bBefore = await usdt.balanceOf(bob.address);
      await (await redemption.claim(1n, alice.address)).wait();
      await (await redemption.claim(1n, bob.address)).wait();
      // alice = 100/400 * 400 = 100; bob = 300/400 * 400 = 300
      assert.equal((await usdt.balanceOf(alice.address)) - aBefore, 100n * ONE);
      assert.equal((await usdt.balanceOf(bob.address)) - bBefore, 300n * ONE);

      const e = await redemption.epochs(1n);
      assert.equal(e.state, 4n); // DISTRIBUTED after last claim
    });

    it("under-settlement (Bitgo paid less) preserves pro-rata invariant", async () => {
      const { alice, bob, backend, executor, usdt, redemption } = await deployFixture();
      await setupAtSettle({ alice, bob, backend, redemption, usdt });

      // Bitgo paid 380 instead of 400 (5% shortfall)
      await (await redemption.connect(executor).settleEpoch(
        1n, 380n * ONE, await usdt.getAddress(),
      )).wait();
      const aBefore = await usdt.balanceOf(alice.address);
      const bBefore = await usdt.balanceOf(bob.address);
      await (await redemption.claim(1n, alice.address)).wait();
      await (await redemption.claim(1n, bob.address)).wait();
      // alice = 100/400 * 380 = 95; bob = 300/400 * 380 = 285
      assert.equal((await usdt.balanceOf(alice.address)) - aBefore, 95n * ONE);
      assert.equal((await usdt.balanceOf(bob.address)) - bBefore, 285n * ONE);
    });

    it("settles in admin-chosen asset even if user requested the other", async () => {
      const { alice, backend, executor, fyusd, usdt, usdc, redemption } = await deployFixture();
      await (await redemption.openEpoch(Number(TWELVE_HOURS), Number(TEN_HOURS))).wait();
      // alice requests USDT, but admin settles in USDC
      const q = {
        user: alice.address, epochId: 1n, fyusdAmount: 100n * ONE,
        targetAsset: await usdt.getAddress(), nonce: 1n, expiry: await nowPlus(3600),
      };
      await (await redemption.connect(alice).requestRedeem(q, await signRedeemQuote(backend, q, redemption))).wait();
      await increaseTime(TEN_HOURS + 1n);
      await (await redemption.lockEpoch(1n)).wait();

      await (await redemption.connect(executor).settleEpoch(
        1n, 100n * ONE, await usdc.getAddress(),
      )).wait();
      const usdcBefore = await usdc.balanceOf(alice.address);
      await (await redemption.claim(1n, alice.address)).wait();
      assert.equal((await usdc.balanceOf(alice.address)) - usdcBefore, 100n * ONE);
      // alice still has 0 USDT — admin chose USDC, hint was just metadata
      assert.equal(await usdt.balanceOf(alice.address), 0n);
    });

    it("settle is executor-only + reverts on non-LOCKED state", async () => {
      const { alice, executor, nonAdmin, redemption, usdt } = await deployFixture();
      await (await redemption.openEpoch(Number(TWELVE_HOURS), Number(TEN_HOURS))).wait();
      await assert.rejects(
        redemption.connect(nonAdmin).settleEpoch(1n, 1n * ONE, await usdt.getAddress()),
        (err) => err.message.includes("NotExecutor"),
      );
      await assert.rejects(
        redemption.connect(executor).settleEpoch(1n, 1n * ONE, await usdt.getAddress()),
        (err) => err.message.includes("InvalidState"),
      );
    });

    it("double-claim reverts", async () => {
      const { alice, bob, backend, executor, redemption, usdt } = await deployFixture();
      await setupAtSettle({ alice, bob, backend, redemption, usdt });
      await (await redemption.connect(executor).settleEpoch(1n, 400n * ONE, await usdt.getAddress())).wait();
      await (await redemption.claim(1n, alice.address)).wait();
      await assert.rejects(
        redemption.claim(1n, alice.address),
        (err) => err.message.includes("AlreadyClaimed"),
      );
    });
  });

  describe("cancelEpoch refund path", () => {
    it("CANCELLED state pays back the user's escrowed FYUSD, not collateral", async () => {
      const { alice, backend, fyusd, usdt, redemption } = await deployFixture();
      await (await redemption.openEpoch(Number(TWELVE_HOURS), Number(TEN_HOURS))).wait();
      const q = {
        user: alice.address, epochId: 1n, fyusdAmount: 250n * ONE,
        targetAsset: await usdt.getAddress(), nonce: 1n, expiry: await nowPlus(3600),
      };
      await (await redemption.connect(alice).requestRedeem(q, await signRedeemQuote(backend, q, redemption))).wait();

      const aliceBalAfterRequest = await fyusd.balanceOf(alice.address);
      await (await redemption.cancelEpoch(1n, ethers.id("Bitgo SLA breach"))).wait();
      await (await redemption.claim(1n, alice.address)).wait();
      // FYUSD returned in full; no USDT moved
      assert.equal((await fyusd.balanceOf(alice.address)) - aliceBalAfterRequest, 250n * ONE);
      assert.equal(await usdt.balanceOf(alice.address), 0n);
    });

    it("cancel is admin-only and rejects non-OPEN/LOCKED states", async () => {
      const { alice, bob, backend, executor, redemption, usdt, nonAdmin } = await deployFixture();
      await (await redemption.openEpoch(Number(TWELVE_HOURS), Number(TEN_HOURS))).wait();
      // alice + bob request so totalRequested > 0
      for (const [u, amt, n] of [[alice, 50n, 1n], [bob, 50n, 2n]]) {
        const q = {
          user: u.address, epochId: 1n, fyusdAmount: amt * ONE,
          targetAsset: await usdt.getAddress(), nonce: n, expiry: await nowPlus(3600),
        };
        await (await redemption.connect(u).requestRedeem(q, await signRedeemQuote(backend, q, redemption))).wait();
      }

      await assert.rejects(
        redemption.connect(nonAdmin).cancelEpoch(1n, ethers.ZeroHash),
        (err) => err.message.includes("NotAdmin"),
      );
      await increaseTime(TEN_HOURS + 1n);
      await (await redemption.lockEpoch(1n)).wait();
      await (await redemption.connect(executor).settleEpoch(1n, 100n * ONE, await usdt.getAddress())).wait();
      // SETTLED → can't cancel
      await assert.rejects(
        redemption.cancelEpoch(1n, ethers.ZeroHash),
        (err) => err.message.includes("InvalidState"),
      );
    });
  });

  describe("pause posture (ADR-008)", () => {
    it("requestPaused[asset] blocks requests against that asset only", async () => {
      const { alice, backend, pauser, redemption, usdt, usdc } = await deployFixture();
      await (await redemption.openEpoch(Number(TWELVE_HOURS), Number(TEN_HOURS))).wait();
      await (await redemption.connect(pauser).setRequestPaused(await usdt.getAddress(), true)).wait();

      const q = {
        user: alice.address, epochId: 1n, fyusdAmount: 1n * ONE,
        targetAsset: await usdt.getAddress(), nonce: 1n, expiry: await nowPlus(3600),
      };
      await assert.rejects(
        redemption.connect(alice).requestRedeem(q, await signRedeemQuote(backend, q, redemption)),
        (err) => err.message.includes("RequestPausedForAsset"),
      );

      // USDC still works
      const q2 = { ...q, targetAsset: await usdc.getAddress(), nonce: 2n };
      await (await redemption.connect(alice).requestRedeem(q2, await signRedeemQuote(backend, q2, redemption))).wait();
    });

    it("pauser cannot un-pause; only admin can", async () => {
      const { pauser, deployer, redemption, usdt } = await deployFixture();
      await (await redemption.connect(pauser).setRequestPaused(await usdt.getAddress(), true)).wait();
      await assert.rejects(
        redemption.connect(pauser).setRequestPaused(await usdt.getAddress(), false),
        (err) => err.message.includes("NotAdmin"),
      );
      await (await redemption.connect(deployer).setRequestPaused(await usdt.getAddress(), false)).wait();
    });

    it("settlementPaused blocks settle but not request", async () => {
      const { alice, backend, pauser, executor, redemption, usdt } = await deployFixture();
      await (await redemption.openEpoch(Number(TWELVE_HOURS), Number(TEN_HOURS))).wait();
      const q = {
        user: alice.address, epochId: 1n, fyusdAmount: 100n * ONE,
        targetAsset: await usdt.getAddress(), nonce: 1n, expiry: await nowPlus(3600),
      };
      await (await redemption.connect(alice).requestRedeem(q, await signRedeemQuote(backend, q, redemption))).wait();
      await increaseTime(TEN_HOURS + 1n);
      await (await redemption.lockEpoch(1n)).wait();
      await (await redemption.connect(pauser).setSettlementPaused(true)).wait();
      await assert.rejects(
        redemption.connect(executor).settleEpoch(1n, 100n * ONE, await usdt.getAddress()),
        (err) => err.message.includes("SettlementPausedErr"),
      );
    });
  });

  describe("backend signer rotation", () => {
    it("rotating signer invalidates old quotes", async () => {
      const { alice, backend, redemption, usdt, deployer, nonAdmin } = await deployFixture();
      await (await redemption.openEpoch(Number(TWELVE_HOURS), Number(TEN_HOURS))).wait();
      const q = {
        user: alice.address, epochId: 1n, fyusdAmount: 1n * ONE,
        targetAsset: await usdt.getAddress(), nonce: 1n, expiry: await nowPlus(3600),
      };
      const oldSig = await signRedeemQuote(backend, q, redemption);
      await (await redemption.connect(deployer).setBackendSigner(nonAdmin.address)).wait();
      await assert.rejects(
        redemption.connect(alice).requestRedeem(q, oldSig),
        (err) => err.message.includes("InvalidSignature"),
      );
    });
  });
});
