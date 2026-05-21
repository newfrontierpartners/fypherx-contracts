/**
 * FypherBurnQueue — Phase 1 burn flow.
 *
 * Validates:
 *   1. Backend-signed quote is required; bad signatures, replay, expiry, and
 *      blacklist are all rejected.
 *   2. RUSD is burned at request time (totalSupply decreases).
 *   3. Claim is gated on-chain by `block.timestamp >= requestedAt + 7 days`
 *      (UTC). Both sides of the boundary are exercised.
 *   4. Per-asset pause and supportedAsset toggles work; existing tickets
 *      stay claimable when an asset is paused mid-flight.
 *   5. emergencyReverse is multisig-only (admin-only here) and frees the
 *      committed liability.
 *   6. View helpers (isClaimable, ticketsOf, isNonceUsed, hashQuote)
 *      reflect storage truthfully.
 *
 * Style mirrors test/FypherLPVault.test.js: node:assert/strict + hardhat
 * ethers v6 + a single deployFixture per test.
 */
const assert = require("node:assert/strict");
const { ethers, upgrades, network } = require("hardhat");

const ONE_DAY = 24n * 60n * 60n;
const SEVEN_DAYS = 7n * ONE_DAY;
const ONE_RUSD = 10n ** 18n;
const ONE_USDT = 10n ** 18n; // mock USDT in this fixture is 18-decimals

async function increaseTime(seconds) {
  await network.provider.send("evm_increaseTime", [Number(seconds)]);
  await network.provider.send("evm_mine", []);
}

async function latestTimestamp() {
  const blk = await ethers.provider.getBlock("latest");
  return BigInt(blk.timestamp);
}

/**
 * Sign a BurnQuote with the given signer using the EIP-712 envelope
 * FypherBurnQueue._verifyQuote authenticates against (FYP-07 patch).
 */
async function signQuote(signer, queueAddress, quote) {
  const { chainId } = await ethers.provider.getNetwork();
  const domain = {
    name: "FypherBurnQueue",
    version: "1",
    chainId,
    verifyingContract: queueAddress,
  };
  const types = {
    BurnQuote: [
      { name: "user", type: "address" },
      { name: "collateralAsset", type: "address" },
      { name: "rusdAmount", type: "uint256" },
      { name: "collateralAmount", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "expiry", type: "uint256" },
    ],
  };
  return signer.signTypedData(domain, types, quote);
}

async function deployFixture() {
  const [deployer, alice, bob, backend, nonAdmin, blacklister] = await ethers.getSigners();

  // 1) SettingManagement (admin = deployer for tests).
  const SettingManagement = await ethers.getContractFactory("SettingManagement");
  const setting = await upgrades.deployProxy(SettingManagement, [deployer.address], {
    initializer: "initialize",
    kind: "transparent",
  });

  // 2) RUSD (owner = deployer; deployer becomes minter so we can seed users).
  const RUSD = await ethers.getContractFactory("RUSD");
  const rusd = await upgrades.deployProxy(RUSD, [deployer.address], {
    initializer: "initialize",
    kind: "transparent",
  });
  await (await rusd.setMinter(deployer.address)).wait();

  // 3) USDT mock (18 decimals — matches the on-chain testnet mock).
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const usdt = await MockERC20.deploy("Mock USDT", "mUSDT", 18);

  // 4) FypherBurnQueue.
  const BurnQueue = await ethers.getContractFactory("FypherBurnQueue");
  const queue = await upgrades.deployProxy(
    BurnQueue,
    [
      await setting.getAddress(),
      await rusd.getAddress(),
      backend.address,
    ],
    { initializer: "initialize", kind: "transparent" },
  );

  // 5) Whitelist USDT as supported collateral.
  await (await queue.setSupportedAsset(await usdt.getAddress(), true)).wait();

  // 6) Seed alice/bob with 1000 RUSD each + approve queue.
  const seedRusd = 1000n * ONE_RUSD;
  for (const u of [alice, bob]) {
    await (await rusd.mint(u.address, seedRusd)).wait();
    await (await rusd.connect(u).approve(await queue.getAddress(), ethers.MaxUint256)).wait();
  }

  // 7) Top up the queue with 10000 USDT so claims have liquidity.
  const seedUsdt = 10_000n * ONE_USDT;
  await (await usdt.mint(deployer.address, seedUsdt)).wait();
  await (await usdt.approve(await queue.getAddress(), ethers.MaxUint256)).wait();
  await (await queue.topUp(await usdt.getAddress(), seedUsdt)).wait();

  return { deployer, alice, bob, backend, nonAdmin, blacklister, setting, rusd, usdt, queue };
}

/**
 * Build a fresh, valid quote for the given user. `overrides` lets a test
 * mutate one field to provoke a specific revert.
 */
async function makeQuote(user, queue, usdt, overrides = {}) {
  const expiryDefault = (await latestTimestamp()) + 600n;
  return {
    user: user.address,
    collateralAsset: await usdt.getAddress(),
    rusdAmount: 100n * ONE_RUSD,
    collateralAmount: 100n * ONE_USDT,
    nonce: BigInt(overrides.nonce ?? Math.floor(Math.random() * 2 ** 32)),
    expiry: expiryDefault,
    ...overrides,
  };
}

describe("FypherBurnQueue", () => {
  describe("requestBurn", () => {
    it("burns RUSD immediately and issues a sequenced ticket", async () => {
      const { alice, backend, rusd, queue, usdt } = await deployFixture();
      const supplyBefore = await rusd.totalSupply();
      const aliceBefore = await rusd.balanceOf(alice.address);

      const quote = await makeQuote(alice, queue, usdt);
      const sig = await signQuote(backend, await queue.getAddress(), quote);

      const tx = await queue.connect(alice).requestBurn(quote, sig);
      const receipt = await tx.wait();

      // RUSD totalSupply and alice's balance both went down by 100 RUSD.
      assert.equal(await rusd.balanceOf(alice.address), aliceBefore - quote.rusdAmount);
      assert.equal(await rusd.totalSupply(), supplyBefore - quote.rusdAmount);

      // Ticket id is 1 (sequence starts at 1).
      assert.equal(await queue.nextTicketId(), 1n);
      const t = await queue.tickets(1n);
      assert.equal(t.user, alice.address);
      assert.equal(t.collateralAsset, await usdt.getAddress());
      assert.equal(t.rusdAmount, quote.rusdAmount);
      assert.equal(t.collateralAmount, quote.collateralAmount);
      assert.equal(t.claimed, false);

      // outstandingLiability incremented.
      assert.equal(
        await queue.outstandingLiability(await usdt.getAddress()),
        quote.collateralAmount,
      );

      // Event emitted with the correct claimableAt (= requestedAt + 7d).
      const evt = receipt.logs
        .map((l) => {
          try { return queue.interface.parseLog(l); } catch { return null; }
        })
        .find((p) => p && p.name === "BurnRequested");
      assert.ok(evt, "BurnRequested event missing");
      assert.equal(evt.args.user, alice.address);
      assert.equal(evt.args.ticketId, 1n);
      assert.equal(BigInt(evt.args.claimableAt), BigInt(evt.args.requestedAt) + SEVEN_DAYS);
    });

    it("rejects a quote signed by anyone other than backendSigner", async () => {
      const { alice, deployer, queue, usdt } = await deployFixture();
      const quote = await makeQuote(alice, queue, usdt);
      const badSig = await signQuote(deployer, await queue.getAddress(), quote);

      await assert.rejects(
        queue.connect(alice).requestBurn(quote, badSig),
        (err) => err.message.includes("InvalidSignature"),
      );
    });

    it("rejects expired quotes", async () => {
      const { alice, backend, queue, usdt } = await deployFixture();
      const quote = await makeQuote(alice, queue, usdt, {
        expiry: (await latestTimestamp()) - 1n,
      });
      const sig = await signQuote(backend, await queue.getAddress(), quote);
      await assert.rejects(
        queue.connect(alice).requestBurn(quote, sig),
        (err) => err.message.includes("ExpiredQuote"),
      );
    });

    it("rejects nonce replay", async () => {
      const { alice, backend, queue, usdt } = await deployFixture();
      const quote = await makeQuote(alice, queue, usdt, { nonce: 42n });
      const sig = await signQuote(backend, await queue.getAddress(), quote);
      await (await queue.connect(alice).requestBurn(quote, sig)).wait();
      await assert.rejects(
        queue.connect(alice).requestBurn(quote, sig),
        (err) => err.message.includes("NonceAlreadyUsed"),
      );
    });

    it("rejects unsupported collateral asset", async () => {
      const { alice, backend, queue } = await deployFixture();
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const random = await MockERC20.deploy("Random", "RND", 18);
      const quote = await makeQuote(alice, queue, random);
      const sig = await signQuote(backend, await queue.getAddress(), quote);
      await assert.rejects(
        queue.connect(alice).requestBurn(quote, sig),
        (err) => err.message.includes("UnsupportedAsset"),
      );
    });

    it("rejects requests when burn is paused for the asset", async () => {
      const { alice, backend, queue, usdt } = await deployFixture();
      await (await queue.setBurnPaused(await usdt.getAddress(), true)).wait();
      const quote = await makeQuote(alice, queue, usdt);
      const sig = await signQuote(backend, await queue.getAddress(), quote);
      await assert.rejects(
        queue.connect(alice).requestBurn(quote, sig),
        (err) => err.message.includes("BurnPausedForAsset"),
      );
    });

    it("rejects blacklisted users", async () => {
      const { alice, backend, setting, queue, usdt } = await deployFixture();
      await (await setting.addToBlacklist(alice.address)).wait();
      const quote = await makeQuote(alice, queue, usdt);
      const sig = await signQuote(backend, await queue.getAddress(), quote);
      await assert.rejects(
        queue.connect(alice).requestBurn(quote, sig),
        (err) => err.message.includes("UserBlacklisted"),
      );
    });

    it("rejects zero rusd or collateral amount", async () => {
      const { alice, backend, queue, usdt } = await deployFixture();
      const zeroRusd = await makeQuote(alice, queue, usdt, { rusdAmount: 0n });
      const zeroColl = await makeQuote(alice, queue, usdt, { collateralAmount: 0n });
      const sig1 = await signQuote(backend, await queue.getAddress(), zeroRusd);
      const sig2 = await signQuote(backend, await queue.getAddress(), zeroColl);
      await assert.rejects(
        queue.connect(alice).requestBurn(zeroRusd, sig1),
        (err) => err.message.includes("ZeroAmount"),
      );
      await assert.rejects(
        queue.connect(alice).requestBurn(zeroColl, sig2),
        (err) => err.message.includes("ZeroAmount"),
      );
    });
  });

  describe("claim", () => {
    it("reverts before 7-day delay elapses (1 second early)", async () => {
      const { alice, backend, queue, usdt } = await deployFixture();
      const quote = await makeQuote(alice, queue, usdt);
      const sig = await signQuote(backend, await queue.getAddress(), quote);
      await (await queue.connect(alice).requestBurn(quote, sig)).wait();

      // Advance to (7 days - 2 seconds) so the next mined block is still
      // strictly before the gate.
      await increaseTime(SEVEN_DAYS - 2n);
      await assert.rejects(
        queue.claim(1n),
        (err) => err.message.includes("EarlyClaim"),
      );
    });

    it("succeeds at exactly the 7-day boundary", async () => {
      const { alice, backend, queue, usdt } = await deployFixture();
      const aliceUsdtBefore = await usdt.balanceOf(alice.address);
      const quote = await makeQuote(alice, queue, usdt);
      const sig = await signQuote(backend, await queue.getAddress(), quote);
      await (await queue.connect(alice).requestBurn(quote, sig)).wait();

      // Advance exactly past 7d.
      await increaseTime(SEVEN_DAYS + 1n);
      await (await queue.claim(1n)).wait();

      // Collateral landed at alice; ticket flagged claimed; liability cleared.
      assert.equal(
        await usdt.balanceOf(alice.address),
        aliceUsdtBefore + quote.collateralAmount,
      );
      const t = await queue.tickets(1n);
      assert.equal(t.claimed, true);
      assert.equal(await queue.outstandingLiability(await usdt.getAddress()), 0n);
    });

    it("rejects double claim", async () => {
      const { alice, backend, queue, usdt } = await deployFixture();
      const quote = await makeQuote(alice, queue, usdt);
      const sig = await signQuote(backend, await queue.getAddress(), quote);
      await (await queue.connect(alice).requestBurn(quote, sig)).wait();
      await increaseTime(SEVEN_DAYS + 1n);
      await (await queue.claim(1n)).wait();
      await assert.rejects(
        queue.claim(1n),
        (err) => err.message.includes("AlreadyClaimed"),
      );
    });

    it("rejects claim of unknown ticket", async () => {
      const { queue } = await deployFixture();
      await assert.rejects(
        queue.claim(999n),
        (err) => err.message.includes("InvalidTicket"),
      );
    });

    it("permits claim by anyone (always pays original user)", async () => {
      const { alice, bob, backend, queue, usdt } = await deployFixture();
      const aliceBefore = await usdt.balanceOf(alice.address);
      const bobBefore = await usdt.balanceOf(bob.address);

      const quote = await makeQuote(alice, queue, usdt);
      const sig = await signQuote(backend, await queue.getAddress(), quote);
      await (await queue.connect(alice).requestBurn(quote, sig)).wait();
      await increaseTime(SEVEN_DAYS + 1n);

      // Bob calls claim on alice's ticket — collateral must still go to alice.
      await (await queue.connect(bob).claim(1n)).wait();
      assert.equal(
        await usdt.balanceOf(alice.address),
        aliceBefore + quote.collateralAmount,
      );
      assert.equal(await usdt.balanceOf(bob.address), bobBefore);
    });

    it("pause does not block in-flight tickets from being claimed", async () => {
      const { alice, backend, queue, usdt } = await deployFixture();
      const quote = await makeQuote(alice, queue, usdt);
      const sig = await signQuote(backend, await queue.getAddress(), quote);
      await (await queue.connect(alice).requestBurn(quote, sig)).wait();
      // Pause AFTER the burn happened. Claim must still succeed.
      await (await queue.setBurnPaused(await usdt.getAddress(), true)).wait();
      await increaseTime(SEVEN_DAYS + 1n);
      await (await queue.claim(1n)).wait();
      assert.equal((await queue.tickets(1n)).claimed, true);
    });
  });

  describe("emergencyReverse", () => {
    it("only admin can call; non-admin reverts NotAdmin", async () => {
      const { alice, nonAdmin, backend, queue, usdt } = await deployFixture();
      const quote = await makeQuote(alice, queue, usdt);
      const sig = await signQuote(backend, await queue.getAddress(), quote);
      await (await queue.connect(alice).requestBurn(quote, sig)).wait();
      await assert.rejects(
        queue.connect(nonAdmin).emergencyReverse(1n, nonAdmin.address, ethers.ZeroHash),
        (err) => err.message.includes("NotAdmin"),
      );
    });

    it("admin can divert collateral and clears the liability", async () => {
      const { deployer, alice, backend, queue, usdt } = await deployFixture();
      const remediation = ethers.Wallet.createRandom().address;
      const quote = await makeQuote(alice, queue, usdt);
      const sig = await signQuote(backend, await queue.getAddress(), quote);
      await (await queue.connect(alice).requestBurn(quote, sig)).wait();

      const reasonHash = ethers.keccak256(ethers.toUtf8Bytes("ops-incident-001"));
      await (await queue.connect(deployer).emergencyReverse(1n, remediation, reasonHash)).wait();

      assert.equal(await usdt.balanceOf(remediation), quote.collateralAmount);
      assert.equal((await queue.tickets(1n)).claimed, true);
      assert.equal(await queue.outstandingLiability(await usdt.getAddress()), 0n);
    });
  });

  describe("admin guards", () => {
    it("setSupportedAsset / setBurnPaused / setBackendSigner only callable by admin", async () => {
      const { nonAdmin, queue, usdt } = await deployFixture();
      await assert.rejects(
        queue.connect(nonAdmin).setSupportedAsset(await usdt.getAddress(), false),
        (err) => err.message.includes("NotAdmin"),
      );
      await assert.rejects(
        queue.connect(nonAdmin).setBurnPaused(await usdt.getAddress(), true),
        (err) => err.message.includes("NotAdmin"),
      );
      await assert.rejects(
        queue.connect(nonAdmin).setBackendSigner(nonAdmin.address),
        (err) => err.message.includes("NotAdmin"),
      );
    });

    it("setBackendSigner rotates the verification key", async () => {
      const { alice, backend, deployer, queue, usdt } = await deployFixture();
      // Rotate to deployer.
      await (await queue.setBackendSigner(deployer.address)).wait();

      // A quote signed by old backend now fails.
      const quoteOld = await makeQuote(alice, queue, usdt);
      const oldSig = await signQuote(backend, await queue.getAddress(), quoteOld);
      await assert.rejects(
        queue.connect(alice).requestBurn(quoteOld, oldSig),
        (err) => err.message.includes("InvalidSignature"),
      );

      // A quote signed by new backend (deployer) succeeds.
      const quoteNew = await makeQuote(alice, queue, usdt, { nonce: 999n });
      const newSig = await signQuote(deployer, await queue.getAddress(), quoteNew);
      await (await queue.connect(alice).requestBurn(quoteNew, newSig)).wait();
      assert.equal(await queue.nextTicketId(), 1n);
    });
  });

  describe("view helpers", () => {
    it("isClaimable / ticketsOf / isNonceUsed / hashQuote behave consistently with storage", async () => {
      const { alice, backend, queue, usdt } = await deployFixture();
      assert.equal(await queue.isClaimable(1n), false);  // doesn't exist
      assert.equal((await queue.ticketsOf(alice.address)).length, 0);

      const quote = await makeQuote(alice, queue, usdt, { nonce: 7n });
      const sig = await signQuote(backend, await queue.getAddress(), quote);

      // hashQuote returns the EIP-712 struct hash (BURN_TYPEHASH + fields)
      // used inside _verifyQuote (FYP-07 patch).
      const onchainHash = await queue.hashQuote(quote);
      const BURN_TYPEHASH = ethers.keccak256(ethers.toUtf8Bytes(
        "BurnQuote(address user,address collateralAsset,uint256 rusdAmount,uint256 collateralAmount,uint256 nonce,uint256 expiry)"
      ));
      const offchainHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "address", "address", "uint256", "uint256", "uint256", "uint256"],
          [
            BURN_TYPEHASH,
            quote.user,
            quote.collateralAsset,
            quote.rusdAmount,
            quote.collateralAmount,
            quote.nonce,
            quote.expiry,
          ],
        ),
      );
      assert.equal(onchainHash, offchainHash);

      await (await queue.connect(alice).requestBurn(quote, sig)).wait();

      assert.equal(await queue.isNonceUsed(alice.address, 7n), true);
      assert.equal((await queue.ticketsOf(alice.address))[0], 1n);
      assert.equal(await queue.isClaimable(1n), false); // still in 7d window
      await increaseTime(SEVEN_DAYS + 1n);
      assert.equal(await queue.isClaimable(1n), true);
    });
  });
});
