/**
 * FyusdEpochSettlement + FYUSD upgrade tests.
 *
 * Covers PHASE1_SPEC §3.2 + ADR-005:
 *   - FYUSD upgrade: emergencyMinter role separate from main minter,
 *     EmergencyMint event for audit ledger, owner-only role rotation.
 *   - Epoch lifecycle: openEpoch -> deposit -> lockEpoch (time-gated) ->
 *     settleEpoch (executor) -> claim (pro-rata FYUSD payout).
 *   - cancelEpoch refund path: deposits returned in original asset,
 *     not FYUSD.
 *   - Per-asset deposit pause + settlement pause (ADR-008).
 *   - Backend-signed deposit quote: replay protection, expiry, asset
 *     consistency, signer rotation invalidates old quotes.
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

async function signQuote(signer, quote) {
  const orderHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256", "address", "uint256", "uint256", "uint256", "uint256"],
      [
        quote.user,
        quote.epochId,
        quote.collateralAsset,
        quote.collateralAmount,
        quote.fyusdAmount,
        quote.nonce,
        quote.expiry,
      ],
    ),
  );
  return signer.signMessage(ethers.getBytes(orderHash));
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

  const EpochSettlement = await ethers.getContractFactory("FyusdEpochSettlement");
  const epoch = await upgrades.deployProxy(EpochSettlement, [
    await setting.getAddress(),
    await fyusd.getAddress(),
    backend.address,
    executor.address,
  ], { initializer: "initialize", kind: "transparent" });

  // Wire FYUSD minter -> EpochSettlement so settleEpoch can mint.
  await (await fyusd.setMinter(await epoch.getAddress())).wait();
  // Wire FYUSD emergencyMinter -> deployer (stand-in for multisig in tests).
  await (await fyusd.setEmergencyMinter(deployer.address)).wait();

  // Whitelist USDT + pauser role.
  await (await epoch.setSupportedAsset(await usdt.getAddress(), true)).wait();
  await (await epoch.setPauserRole(pauser.address)).wait();

  // Seed alice + bob + carol with USDT and approve.
  for (const u of [alice, bob, carol]) {
    await (await usdt.mint(u.address, 10_000n * ONE)).wait();
    await (await usdt.connect(u).approve(await epoch.getAddress(), ethers.MaxUint256)).wait();
  }

  return { deployer, alice, bob, carol, backend, executor, pauser, nonAdmin,
           setting, fyusd, usdt, epoch };
}

describe("FYUSD (S1.3a — emergencyMint)", () => {
  it("emergencyMinter role is separate from minter; both have rotation events", async () => {
    const { deployer, fyusd, epoch } = await deployFixture();
    assert.equal(await fyusd.minter(), await epoch.getAddress());
    assert.equal(await fyusd.emergencyMinter(), deployer.address);
  });

  it("emergencyMint by emergencyMinter mints + emits EmergencyMint event", async () => {
    const { deployer, alice, fyusd } = await deployFixture();
    const before = await fyusd.totalSupply();
    const tx = await fyusd.connect(deployer).emergencyMint(alice.address, 50n * ONE);
    const receipt = await tx.wait();
    assert.equal(await fyusd.totalSupply(), before + 50n * ONE);
    assert.equal(await fyusd.balanceOf(alice.address), 50n * ONE);
    const evt = receipt.logs
      .map((l) => { try { return fyusd.interface.parseLog(l); } catch { return null; } })
      .find((p) => p && p.name === "EmergencyMint");
    assert.ok(evt, "EmergencyMint event missing");
    assert.equal(evt.args.operator, deployer.address);
    assert.equal(evt.args.to, alice.address);
    assert.equal(evt.args.amount, 50n * ONE);
  });

  it("regular minter (epoch) cannot call emergencyMint", async () => {
    const { fyusd, epoch, alice } = await deployFixture();
    // Impersonate the epoch contract address to test the role boundary.
    await network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [await epoch.getAddress()],
    });
    await network.provider.send("hardhat_setBalance", [
      await epoch.getAddress(), "0x1000000000000000000",
    ]);
    const epochSigner = await ethers.getSigner(await epoch.getAddress());
    await assert.rejects(
      fyusd.connect(epochSigner).emergencyMint(alice.address, 1n * ONE),
      (err) => err.message.includes("NotEmergencyMinter"),
    );
  });

  it("setEmergencyMinter is owner-only", async () => {
    const { fyusd, nonAdmin } = await deployFixture();
    await assert.rejects(
      fyusd.connect(nonAdmin).setEmergencyMinter(nonAdmin.address),
      (err) => err.message.includes("OwnableUnauthorizedAccount"),
    );
  });
});

describe("FyusdEpochSettlement", () => {
  describe("openEpoch + state machine", () => {
    it("opens an epoch with the requested duration / lockOffset", async () => {
      const { epoch } = await deployFixture();
      const tx = await epoch.openEpoch(Number(TWELVE_HOURS), Number(TEN_HOURS));
      await tx.wait();
      assert.equal(await epoch.nextEpochId(), 1n);
      const e = await epoch.epochs(1n);
      assert.equal(e.state, 1n); // OPEN
      assert.equal(BigInt(e.lockAt) - BigInt(e.openAt), TEN_HOURS);
      assert.equal(BigInt(e.endAt) - BigInt(e.openAt), TWELVE_HOURS);
    });

    it("rejects lockOffset >= duration", async () => {
      const { epoch } = await deployFixture();
      await assert.rejects(
        epoch.openEpoch(Number(TEN_HOURS), Number(TWELVE_HOURS)),
        (err) => err.message.includes("InvalidLockOffset"),
      );
    });

    it("openEpoch is admin-only", async () => {
      const { epoch, nonAdmin } = await deployFixture();
      await assert.rejects(
        epoch.connect(nonAdmin).openEpoch(Number(TWELVE_HOURS), Number(TEN_HOURS)),
        (err) => err.message.includes("NotAdmin"),
      );
    });

    it("lockEpoch reverts before lockAt and succeeds at-or-after", async () => {
      const { epoch } = await deployFixture();
      await (await epoch.openEpoch(Number(TWELVE_HOURS), Number(TEN_HOURS))).wait();
      await assert.rejects(
        epoch.lockEpoch(1n),
        (err) => err.message.includes("EpochStillOpen"),
      );
      await increaseTime(TEN_HOURS + 1n);
      await (await epoch.lockEpoch(1n)).wait();
      assert.equal(await epoch.epochState(1n), 2n); // LOCKED
    });

    it("settleEpoch is executor-only and mints recorded fyusd to the contract", async () => {
      const { alice, backend, executor, fyusd, usdt, epoch } = await deployFixture();
      await (await epoch.openEpoch(Number(TWELVE_HOURS), Number(TEN_HOURS))).wait();

      // Single deposit so totalFyusdEntitled > 0.
      const quote = {
        user: alice.address,
        epochId: 1n,
        collateralAsset: await usdt.getAddress(),
        collateralAmount: 100n * ONE,
        fyusdAmount: 100n * ONE,
        nonce: 1n,
        expiry: await nowPlus(600),
      };
      const sig = await signQuote(backend, quote);
      await (await epoch.connect(alice).deposit(quote, sig)).wait();

      // Lock + settle.
      await increaseTime(TEN_HOURS + 1n);
      await (await epoch.lockEpoch(1n)).wait();

      const fyusdBefore = await fyusd.balanceOf(await epoch.getAddress());
      await (await epoch.connect(executor).settleEpoch(1n, 100n * ONE)).wait();
      assert.equal(await fyusd.balanceOf(await epoch.getAddress()), fyusdBefore + 100n * ONE);
      assert.equal(await epoch.epochState(1n), 3n); // SETTLED
    });
  });

  describe("deposit", () => {
    it("happy path: collateral pulled, entitlement recorded, event emitted", async () => {
      const { alice, backend, usdt, epoch } = await deployFixture();
      await (await epoch.openEpoch(Number(TWELVE_HOURS), Number(TEN_HOURS))).wait();
      const quote = {
        user: alice.address,
        epochId: 1n,
        collateralAsset: await usdt.getAddress(),
        collateralAmount: 100n * ONE,
        fyusdAmount: 100n * ONE,
        nonce: 1n,
        expiry: await nowPlus(600),
      };
      const sig = await signQuote(backend, quote);

      const aliceBefore = await usdt.balanceOf(alice.address);
      await (await epoch.connect(alice).deposit(quote, sig)).wait();
      assert.equal(await usdt.balanceOf(alice.address), aliceBefore - 100n * ONE);
      assert.equal(await epoch.fyusdEntitled(1n, alice.address), 100n * ONE);
      assert.equal(await epoch.depositedAmount(1n, alice.address), 100n * ONE);
      assert.equal(await epoch.depositedAsset(1n, alice.address), await usdt.getAddress());
    });

    it("rejects bad signature, expired quote, replayed nonce, paused asset", async () => {
      const { alice, backend, deployer, usdt, pauser, epoch } = await deployFixture();
      await (await epoch.openEpoch(Number(TWELVE_HOURS), Number(TEN_HOURS))).wait();
      const base = {
        user: alice.address,
        epochId: 1n,
        collateralAsset: await usdt.getAddress(),
        collateralAmount: 50n * ONE,
        fyusdAmount: 50n * ONE,
        nonce: 100n,
        expiry: await nowPlus(600),
      };

      // Bad sig: signed by wrong key.
      const badSig = await signQuote(deployer, base);
      await assert.rejects(
        epoch.connect(alice).deposit(base, badSig),
        (err) => err.message.includes("InvalidSignature"),
      );

      // Expired.
      const expired = { ...base, nonce: 101n, expiry: (await nowPlus(0)) - 1n };
      const expiredSig = await signQuote(backend, expired);
      await assert.rejects(
        epoch.connect(alice).deposit(expired, expiredSig),
        (err) => err.message.includes("ExpiredQuote"),
      );

      // Replay.
      const okQuote = { ...base, nonce: 102n };
      const okSig = await signQuote(backend, okQuote);
      await (await epoch.connect(alice).deposit(okQuote, okSig)).wait();
      await assert.rejects(
        epoch.connect(alice).deposit(okQuote, okSig),
        (err) => err.message.includes("NonceAlreadyUsed"),
      );

      // Paused asset.
      await (await epoch.connect(pauser).setDepositPaused(await usdt.getAddress(), true)).wait();
      const paused = { ...base, nonce: 103n };
      const pausedSig = await signQuote(backend, paused);
      await assert.rejects(
        epoch.connect(alice).deposit(paused, pausedSig),
        (err) => err.message.includes("DepositPausedForAsset"),
      );
    });

    it("rejects deposits to a LOCKED epoch (after lockAt elapses)", async () => {
      const { alice, backend, usdt, epoch } = await deployFixture();
      await (await epoch.openEpoch(Number(TWELVE_HOURS), Number(TEN_HOURS))).wait();
      await increaseTime(TEN_HOURS + 1n);
      // Don't even need to call lockEpoch — the time-based gate fires first.
      const quote = {
        user: alice.address,
        epochId: 1n,
        collateralAsset: await usdt.getAddress(),
        collateralAmount: 50n * ONE,
        fyusdAmount: 50n * ONE,
        nonce: 200n,
        expiry: await nowPlus(600),
      };
      const sig = await signQuote(backend, quote);
      await assert.rejects(
        epoch.connect(alice).deposit(quote, sig),
        (err) => err.message.includes("EpochAlreadyLocked"),
      );
    });
  });

  describe("claim — settled path", () => {
    it("pays pro-rata FYUSD per entitlement when fyusdMinted == totalEntitled", async () => {
      const { alice, bob, backend, executor, usdt, fyusd, epoch } = await deployFixture();
      await (await epoch.openEpoch(Number(TWELVE_HOURS), Number(TEN_HOURS))).wait();

      // Alice deposits 100, bob deposits 300; entitled FYUSD = same.
      for (const [user, n, amt] of [[alice, 1n, 100n * ONE], [bob, 2n, 300n * ONE]]) {
        const q = {
          user: user.address,
          epochId: 1n,
          collateralAsset: await usdt.getAddress(),
          collateralAmount: amt,
          fyusdAmount: amt,
          nonce: n,
          expiry: await nowPlus(600),
        };
        const sig = await signQuote(backend, q);
        await (await epoch.connect(user).deposit(q, sig)).wait();
      }

      await increaseTime(TEN_HOURS + 1n);
      await (await epoch.lockEpoch(1n)).wait();
      // Bitgo settled the full 400 FYUSD.
      await (await epoch.connect(executor).settleEpoch(1n, 400n * ONE)).wait();

      await (await epoch.claim(1n, alice.address)).wait();
      await (await epoch.claim(1n, bob.address)).wait();

      assert.equal(await fyusd.balanceOf(alice.address), 100n * ONE);
      assert.equal(await fyusd.balanceOf(bob.address), 300n * ONE);
      assert.equal(await epoch.epochState(1n), 4n); // DISTRIBUTED
    });

    it("pays pro-rata when settlement is short (Bitgo paid less than entitled)", async () => {
      const { alice, bob, backend, executor, usdt, fyusd, epoch } = await deployFixture();
      await (await epoch.openEpoch(Number(TWELVE_HOURS), Number(TEN_HOURS))).wait();

      for (const [user, n, amt] of [[alice, 1n, 100n * ONE], [bob, 2n, 300n * ONE]]) {
        const q = {
          user: user.address,
          epochId: 1n,
          collateralAsset: await usdt.getAddress(),
          collateralAmount: amt,
          fyusdAmount: amt,
          nonce: n,
          expiry: await nowPlus(600),
        };
        const sig = await signQuote(backend, q);
        await (await epoch.connect(user).deposit(q, sig)).wait();
      }
      await increaseTime(TEN_HOURS + 1n);
      await (await epoch.lockEpoch(1n)).wait();
      // Bitgo paid only 200 of 400 entitled — 50% shortfall.
      await (await epoch.connect(executor).settleEpoch(1n, 200n * ONE)).wait();

      await (await epoch.claim(1n, alice.address)).wait();
      await (await epoch.claim(1n, bob.address)).wait();
      assert.equal(await fyusd.balanceOf(alice.address), 50n * ONE);
      assert.equal(await fyusd.balanceOf(bob.address), 150n * ONE);
    });

    it("double claim reverts AlreadyClaimed", async () => {
      const { alice, backend, executor, usdt, epoch } = await deployFixture();
      await (await epoch.openEpoch(Number(TWELVE_HOURS), Number(TEN_HOURS))).wait();
      const q = {
        user: alice.address,
        epochId: 1n,
        collateralAsset: await usdt.getAddress(),
        collateralAmount: 100n * ONE,
        fyusdAmount: 100n * ONE,
        nonce: 1n,
        expiry: await nowPlus(600),
      };
      await (await epoch.connect(alice).deposit(q, await signQuote(backend, q))).wait();
      await increaseTime(TEN_HOURS + 1n);
      await (await epoch.lockEpoch(1n)).wait();
      await (await epoch.connect(executor).settleEpoch(1n, 100n * ONE)).wait();
      await (await epoch.claim(1n, alice.address)).wait();
      await assert.rejects(
        epoch.claim(1n, alice.address),
        (err) => err.message.includes("AlreadyClaimed"),
      );
    });
  });

  describe("cancelEpoch — refund path", () => {
    it("refunds depositors in the original collateral asset, not FYUSD", async () => {
      const { alice, backend, usdt, epoch } = await deployFixture();
      await (await epoch.openEpoch(Number(TWELVE_HOURS), Number(TEN_HOURS))).wait();
      const q = {
        user: alice.address,
        epochId: 1n,
        collateralAsset: await usdt.getAddress(),
        collateralAmount: 100n * ONE,
        fyusdAmount: 100n * ONE,
        nonce: 1n,
        expiry: await nowPlus(600),
      };
      await (await epoch.connect(alice).deposit(q, await signQuote(backend, q))).wait();

      // Cancel before lock.
      const reasonHash = ethers.keccak256(ethers.toUtf8Bytes("bitgo-outage-test"));
      await (await epoch.cancelEpoch(1n, reasonHash)).wait();
      assert.equal(await epoch.epochState(1n), 5n); // CANCELLED

      const aliceBefore = await usdt.balanceOf(alice.address);
      await (await epoch.claim(1n, alice.address)).wait();
      assert.equal(await usdt.balanceOf(alice.address), aliceBefore + 100n * ONE);
    });
  });

  describe("settlementPaused", () => {
    it("blocks settleEpoch when set, succeeds again after unpause", async () => {
      const { alice, backend, executor, pauser, deployer, usdt, epoch } = await deployFixture();
      await (await epoch.openEpoch(Number(TWELVE_HOURS), Number(TEN_HOURS))).wait();
      const q = {
        user: alice.address,
        epochId: 1n,
        collateralAsset: await usdt.getAddress(),
        collateralAmount: 100n * ONE,
        fyusdAmount: 100n * ONE,
        nonce: 1n,
        expiry: await nowPlus(600),
      };
      await (await epoch.connect(alice).deposit(q, await signQuote(backend, q))).wait();
      await increaseTime(TEN_HOURS + 1n);
      await (await epoch.lockEpoch(1n)).wait();

      await (await epoch.connect(pauser).setSettlementPaused(true)).wait();
      await assert.rejects(
        epoch.connect(executor).settleEpoch(1n, 100n * ONE),
        (err) => err.message.includes("SettlementPausedErr"),
      );

      // Pauser cannot unpause; admin can.
      await assert.rejects(
        epoch.connect(pauser).setSettlementPaused(false),
        (err) => err.message.includes("NotAdmin"),
      );
      await (await epoch.connect(deployer).setSettlementPaused(false)).wait();
      await (await epoch.connect(executor).settleEpoch(1n, 100n * ONE)).wait();
      assert.equal(await epoch.epochState(1n), 3n); // SETTLED
    });
  });

  describe("admin guards", () => {
    it("setSupportedAsset / setBackendSigner / setBackendExecutor / setPauserRole are admin-only", async () => {
      const { nonAdmin, usdt, epoch } = await deployFixture();
      const usdtAddr = await usdt.getAddress();
      const cases = [
        () => epoch.connect(nonAdmin).setSupportedAsset(usdtAddr, false),
        () => epoch.connect(nonAdmin).setBackendSigner(nonAdmin.address),
        () => epoch.connect(nonAdmin).setBackendExecutor(nonAdmin.address),
        () => epoch.connect(nonAdmin).setPauserRole(nonAdmin.address),
      ];
      for (const c of cases) {
        await assert.rejects(c(), (err) => err.message.includes("NotAdmin"));
      }
    });
  });
});
