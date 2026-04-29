/**
 * FypherLPVault — on-chain behaviour tests.
 *
 * We exercise the vault against a mock Pancake V2 router/pair pair (see
 * `contracts/mocks/MockPancakeV2.sol`). The mock does NOT model xy=k pricing;
 * it just enforces the interface contract + minimum-amount guards + LP token
 * accounting. That's enough to validate the vault's ERC-4626-ish share math,
 * its slippage guards, its pause switch, and its emergency exit path.
 *
 * Matches the style of the sibling `fypherx-contracts/contracts/test/*.test.js`
 * suite (node:assert/strict + hardhat ethers v6).
 */
const assert = require("node:assert/strict");
const { ethers, network } = require("hardhat");

const ONE = 10n ** 18n;

async function deployFixture(options = {}) {
  const [deployer, alice, bob, nonOwner] = await ethers.getSigners();

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const rusd      = await MockERC20.deploy("Mock RUSD", "mRUSD", 18);
  const usdt      = await MockERC20.deploy("Mock USDT", "mUSDT", 18);

  const MockPair   = await ethers.getContractFactory("MockPancakePair");
  const MockRouter = await ethers.getContractFactory("MockPancakeRouterV2");

  const pair   = await MockPair.deploy();
  const router = await MockRouter.deploy(
    await pair.getAddress(),
    await rusd.getAddress(),
    await usdt.getAddress(),
  );
  await (await pair.setMinter(await router.getAddress())).wait();

  const Vault = await ethers.getContractFactory("FypherLPVault");
  const vault = await Vault.deploy(
    deployer.address,
    await rusd.getAddress(),
    await usdt.getAddress(),
    await pair.getAddress(),
    await router.getAddress(),
    "Fypher LP Vault RUSD/USDT",
    "fyLP-RUSD-USDT",
  );

  // Seed both users with 10k RUSD + 10k USDT and pre-approve the vault for
  // MaxUint256 so each individual test doesn't re-plumb the approvals.
  const seed = ethers.parseUnits("10000", 18);
  for (const user of [alice, bob]) {
    await (await rusd.mint(user.address, seed)).wait();
    await (await usdt.mint(user.address, seed)).wait();
    await (await rusd.connect(user).approve(await vault.getAddress(), ethers.MaxUint256)).wait();
    await (await usdt.connect(user).approve(await vault.getAddress(), ethers.MaxUint256)).wait();
  }

  const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;

  return { deployer, alice, bob, nonOwner, rusd, usdt, pair, router, vault, deadline };
}

describe("FypherLPVault", function () {
  describe("deployment", function () {
    it("wires immutables and mints zero supply on fresh deploy", async function () {
      const { rusd, usdt, pair, router, vault, deployer } = await deployFixture();

      assert.equal(await vault.rusd(),       await rusd.getAddress());
      assert.equal(await vault.quoteToken(), await usdt.getAddress());
      assert.equal(await vault.pair(),       await pair.getAddress());
      assert.equal(await vault.router(),     await router.getAddress());
      assert.equal(await vault.owner(),      deployer.address);
      assert.equal(await vault.totalSupply(), 0n);
      assert.equal(await vault.totalLp(),     0n);
      assert.equal(await vault.depositsPaused(), false);
    });

    it("exposes the configured ERC-20 metadata", async function () {
      const { vault } = await deployFixture();
      assert.equal(await vault.name(),   "Fypher LP Vault RUSD/USDT");
      assert.equal(await vault.symbol(), "fyLP-RUSD-USDT");
      // decimals() is a uint8 — ethers v6 returns bigint, so match on 18n.
      assert.equal(await vault.decimals(), 18n);
    });
  });

  describe("deposit — happy path", function () {
    it("pulls RUSD + USDT, adds liquidity, and mints 1:1 shares for the first depositor", async function () {
      const { alice, rusd, usdt, vault, pair, deadline } = await deployFixture();

      const rusdIn = ethers.parseUnits("100", 18);
      const usdtIn = ethers.parseUnits("100", 18);

      const tx = await vault.connect(alice).deposit(
        rusdIn,
        usdtIn,
        rusdIn, // min == desired because mock doesn't skim by default
        usdtIn,
        deadline,
        alice.address,
      );
      const rcpt = await tx.wait();

      // First deposit: sharesMinted == lpReceived == rusdIn + usdtIn (per mock formula).
      const expectedLp     = rusdIn + usdtIn;
      const expectedShares = expectedLp;

      assert.equal(await vault.totalSupply(),             expectedShares);
      assert.equal(await vault.balanceOf(alice.address),  expectedShares);
      assert.equal(await vault.totalLp(),                 expectedLp);
      assert.equal(await pair.balanceOf(await vault.getAddress()), expectedLp);

      // User balances debited exactly.
      assert.equal(await rusd.balanceOf(alice.address), ethers.parseUnits("9900", 18));
      assert.equal(await usdt.balanceOf(alice.address), ethers.parseUnits("9900", 18));

      // Deposit event wiring.
      const depositLog = rcpt.logs
        .map((l) => { try { return vault.interface.parseLog(l); } catch { return null; }})
        .find((p) => p && p.name === "Deposit");
      assert.ok(depositLog, "expected Deposit event");
      assert.equal(depositLog.args.caller,       alice.address);
      assert.equal(depositLog.args.recipient,    alice.address);
      assert.equal(depositLog.args.rusdIn,       rusdIn);
      assert.equal(depositLog.args.quoteIn,      usdtIn);
      assert.equal(depositLog.args.lpMinted,     expectedLp);
      assert.equal(depositLog.args.sharesMinted, expectedShares);
    });

    it("mints shares proportional to LP received for subsequent depositors", async function () {
      const { alice, bob, vault, deadline } = await deployFixture();

      const amt = ethers.parseUnits("100", 18);
      await (await vault.connect(alice).deposit(amt, amt, amt, amt, deadline, alice.address)).wait();

      // Bob deposits 50 + 50 — should get roughly half of Alice's shares.
      const half = ethers.parseUnits("50", 18);
      await (await vault.connect(bob).deposit(half, half, half, half, deadline, bob.address)).wait();

      const aliceShares = await vault.balanceOf(alice.address);
      const bobShares   = await vault.balanceOf(bob.address);
      // Bob's LP == half of Alice's (first was 200 WAD, second was 100 WAD).
      // shares = (lpReceived * totalSupply_before) / totalLp_before
      //        = (100e18 * 200e18) / 200e18
      //        = 100e18
      assert.equal(aliceShares, ethers.parseUnits("200", 18));
      assert.equal(bobShares,   ethers.parseUnits("100", 18));
      assert.equal(await vault.totalSupply(), ethers.parseUnits("300", 18));
    });

    it("routes shares to the recipient, not the caller, when they differ", async function () {
      const { alice, bob, vault, deadline } = await deployFixture();
      const amt = ethers.parseUnits("25", 18);

      await (await vault.connect(alice).deposit(amt, amt, amt, amt, deadline, bob.address)).wait();

      assert.equal(await vault.balanceOf(alice.address), 0n);
      assert.equal(await vault.balanceOf(bob.address), amt + amt); // first deposit = a+b
    });

    it("refunds the leftover leg when the router consumes only a subset", async function () {
      const { alice, rusd, usdt, vault, router, deadline } = await deployFixture();

      // Router will only take 95% of each desired amount.
      await (await router.setSkim(9500, 10000)).wait();

      const rusdDesired = ethers.parseUnits("100", 18);
      const usdtDesired = ethers.parseUnits("100", 18);

      const rusdBefore = await rusd.balanceOf(alice.address);
      const usdtBefore = await usdt.balanceOf(alice.address);

      await (await vault.connect(alice).deposit(
        rusdDesired,
        usdtDesired,
        1n,    // accept anything >=1 wei of A
        1n,
        deadline,
        alice.address,
      )).wait();

      const rusdAfter = await rusd.balanceOf(alice.address);
      const usdtAfter = await usdt.balanceOf(alice.address);

      // Vault pulled 100, router used 95, 5 should be refunded — net debit = 95.
      assert.equal(rusdBefore - rusdAfter, ethers.parseUnits("95", 18));
      assert.equal(usdtBefore - usdtAfter, ethers.parseUnits("95", 18));
    });
  });

  describe("deposit — reverts", function () {
    it("reverts when depositsPaused is true", async function () {
      const { alice, vault, deadline } = await deployFixture();
      await (await vault.setDepositsPaused(true)).wait();
      const amt = ethers.parseUnits("1", 18);

      await assert.rejects(
        vault.connect(alice).deposit(amt, amt, amt, amt, deadline, alice.address),
        (err) => /DepositsArePaused/.test(err.message),
      );
    });

    it("reverts when block.timestamp > deadline", async function () {
      const { alice, vault } = await deployFixture();
      const stale = (await ethers.provider.getBlock("latest")).timestamp - 1;
      const amt = ethers.parseUnits("1", 18);

      await assert.rejects(
        vault.connect(alice).deposit(amt, amt, amt, amt, stale, alice.address),
        (err) => /DeadlineExpired/.test(err.message),
      );
    });

    it("reverts when either amount is zero", async function () {
      const { alice, vault, deadline } = await deployFixture();
      const amt = ethers.parseUnits("1", 18);

      await assert.rejects(
        vault.connect(alice).deposit(0n, amt, 0n, 1n, deadline, alice.address),
        (err) => /ZeroAmount/.test(err.message),
      );
      await assert.rejects(
        vault.connect(alice).deposit(amt, 0n, 1n, 0n, deadline, alice.address),
        (err) => /ZeroAmount/.test(err.message),
      );
    });

    it("reverts when the router's returned amount falls below the min guard", async function () {
      const { alice, router, vault, deadline } = await deployFixture();
      // Router will only supply 80% but caller asks for 100% min — should trip insufficient A.
      await (await router.setSkim(8000, 10000)).wait();
      const amt = ethers.parseUnits("100", 18);

      await assert.rejects(
        vault.connect(alice).deposit(amt, amt, amt, amt, deadline, alice.address),
        // The revert bubbles up from the mock router; any failure is acceptable.
        () => true,
      );
    });
  });

  describe("withdraw", function () {
    async function withDeposit() {
      const ctx = await deployFixture();
      const { alice, vault, deadline } = ctx;
      const amt = ethers.parseUnits("100", 18);
      await (await vault.connect(alice).deposit(amt, amt, amt, amt, deadline, alice.address)).wait();
      return ctx;
    }

    it("burns shares and routes underlying back to the recipient", async function () {
      const { alice, bob, rusd, usdt, vault, deadline } = await withDeposit();

      const sharesBefore = await vault.balanceOf(alice.address);
      assert.equal(sharesBefore, ethers.parseUnits("200", 18));

      const half = sharesBefore / 2n;
      const tx = await vault.connect(alice).withdraw(
        half,
        1n, // accept anything back — we're not testing slippage here
        1n,
        deadline,
        bob.address,
      );
      const rcpt = await tx.wait();

      assert.equal(await vault.balanceOf(alice.address), sharesBefore - half);

      // Bob (recipient) receives half of the vault's underlying.
      // LP = 200 units. removeLiquidity(100) returns 50 RUSD + 50 USDT.
      assert.equal(await rusd.balanceOf(bob.address), ethers.parseUnits("10050", 18));
      assert.equal(await usdt.balanceOf(bob.address), ethers.parseUnits("10050", 18));

      // Event wiring.
      const log = rcpt.logs
        .map((l) => { try { return vault.interface.parseLog(l); } catch { return null; }})
        .find((p) => p && p.name === "Withdraw");
      assert.ok(log, "expected Withdraw event");
      assert.equal(log.args.caller,       alice.address);
      assert.equal(log.args.recipient,    bob.address);
      assert.equal(log.args.sharesBurned, half);
    });

    it("reverts when burning zero shares", async function () {
      const { alice, vault, deadline } = await withDeposit();
      await assert.rejects(
        vault.connect(alice).withdraw(0n, 0n, 0n, deadline, alice.address),
        (err) => /ZeroAmount/.test(err.message),
      );
    });

    it("reverts on expired deadline", async function () {
      const { alice, vault } = await withDeposit();
      const stale = (await ethers.provider.getBlock("latest")).timestamp - 1;
      await assert.rejects(
        vault.connect(alice).withdraw(1n, 0n, 0n, stale, alice.address),
        (err) => /DeadlineExpired/.test(err.message),
      );
    });

    it("reverts when the min-amount guards trip", async function () {
      const { alice, vault, deadline } = await withDeposit();
      const shares = await vault.balanceOf(alice.address);
      // Ask for more than the pool can return for this shares amount.
      const tooMuch = ethers.parseUnits("10000", 18);
      await assert.rejects(
        vault.connect(alice).withdraw(shares / 4n, tooMuch, tooMuch, deadline, alice.address),
        () => true,
      );
    });

    it("reverts when the caller has no shares", async function () {
      const { bob, vault, deadline } = await withDeposit();
      await assert.rejects(
        vault.connect(bob).withdraw(1n, 0n, 0n, deadline, bob.address),
        // _burn on zero-balance reverts via OZ ERC20InsufficientBalance
        () => true,
      );
    });
  });

  describe("emergencyWithdraw", function () {
    it("ships raw LP tokens to the caller, bypassing the router", async function () {
      const { alice, vault, pair, deadline } = await deployFixture();
      const amt = ethers.parseUnits("100", 18);
      await (await vault.connect(alice).deposit(amt, amt, amt, amt, deadline, alice.address)).wait();

      const sharesBefore = await vault.balanceOf(alice.address);
      const lpInVaultBefore = await pair.balanceOf(await vault.getAddress());
      const tx = await vault.connect(alice).emergencyWithdraw(sharesBefore);
      const rcpt = await tx.wait();

      assert.equal(await vault.balanceOf(alice.address), 0n);
      assert.equal(await vault.totalSupply(), 0n);
      // All LP token flows out to alice.
      assert.equal(await pair.balanceOf(alice.address), lpInVaultBefore);
      assert.equal(await pair.balanceOf(await vault.getAddress()), 0n);

      const log = rcpt.logs
        .map((l) => { try { return vault.interface.parseLog(l); } catch { return null; }})
        .find((p) => p && p.name === "EmergencyWithdraw");
      assert.ok(log, "expected EmergencyWithdraw event");
    });

    it("reverts on zero shares", async function () {
      const { alice, vault } = await deployFixture();
      await assert.rejects(
        vault.connect(alice).emergencyWithdraw(0n),
        (err) => /ZeroAmount/.test(err.message),
      );
    });
  });

  describe("admin — setDepositsPaused", function () {
    it("owner can flip the pause flag", async function () {
      const { vault } = await deployFixture();
      assert.equal(await vault.depositsPaused(), false);
      await (await vault.setDepositsPaused(true)).wait();
      assert.equal(await vault.depositsPaused(), true);
      await (await vault.setDepositsPaused(false)).wait();
      assert.equal(await vault.depositsPaused(), false);
    });

    it("non-owner cannot flip the pause flag", async function () {
      const { vault, nonOwner } = await deployFixture();
      await assert.rejects(
        vault.connect(nonOwner).setDepositsPaused(true),
        (err) => /OwnableUnauthorizedAccount/.test(err.message),
      );
    });
  });

  describe("views", function () {
    it("totalLp tracks pair.balanceOf(vault)", async function () {
      const { alice, vault, pair, deadline } = await deployFixture();
      const amt = ethers.parseUnits("77", 18);
      await (await vault.connect(alice).deposit(amt, amt, amt, amt, deadline, alice.address)).wait();
      assert.equal(await vault.totalLp(), await pair.balanceOf(await vault.getAddress()));
    });

    it("lpOf(user) returns the pro-rata LP backing a user's shares", async function () {
      const { alice, bob, vault, deadline } = await deployFixture();
      const amt = ethers.parseUnits("100", 18);
      await (await vault.connect(alice).deposit(amt, amt, amt, amt, deadline, alice.address)).wait();
      await (await vault.connect(bob).deposit(amt, amt, amt, amt, deadline, bob.address)).wait();

      const aliceLp = await vault.lpOf(alice.address);
      const bobLp   = await vault.lpOf(bob.address);
      const total   = await vault.totalLp();
      // both users deposited equal amounts → each backs exactly half the LP.
      assert.equal(aliceLp, total / 2n);
      assert.equal(bobLp,   total / 2n);
    });

    it("lpOf returns 0 for a non-depositor", async function () {
      const { bob, vault } = await deployFixture();
      assert.equal(await vault.lpOf(bob.address), 0n);
    });

    it("underlyingOf decomposes shares into RUSD + quote amounts", async function () {
      const { alice, vault, deadline } = await deployFixture();
      const amt = ethers.parseUnits("100", 18);
      await (await vault.connect(alice).deposit(amt, amt, amt, amt, deadline, alice.address)).wait();

      const [rusdOut, quoteOut] = await vault.underlyingOf(alice.address);
      // alice owns 100% of the vault; vault holds 100 RUSD + 100 USDT worth of LP.
      // pair.totalSupply == 200, rusdReserve == 100, quoteReserve == 100.
      // userLp == 200 (all of it) → rusdOut = (200 * 100) / 200 = 100.
      assert.equal(rusdOut,  ethers.parseUnits("100", 18));
      assert.equal(quoteOut, ethers.parseUnits("100", 18));
    });

    it("underlyingOf returns (0, 0) when total supply is zero", async function () {
      const { alice, vault } = await deployFixture();
      const [r, q] = await vault.underlyingOf(alice.address);
      assert.equal(r, 0n);
      assert.equal(q, 0n);
    });
  });

  describe("round trip", function () {
    it("alice deposits then fully withdraws and is returned to her starting balance", async function () {
      const { alice, rusd, usdt, vault, deadline } = await deployFixture();

      const rusdStart = await rusd.balanceOf(alice.address);
      const usdtStart = await usdt.balanceOf(alice.address);

      const amt = ethers.parseUnits("123", 18);
      await (await vault.connect(alice).deposit(amt, amt, amt, amt, deadline, alice.address)).wait();

      const shares = await vault.balanceOf(alice.address);
      await (await vault.connect(alice).withdraw(shares, 1n, 1n, deadline, alice.address)).wait();

      assert.equal(await rusd.balanceOf(alice.address), rusdStart);
      assert.equal(await usdt.balanceOf(alice.address), usdtStart);
      assert.equal(await vault.totalSupply(), 0n);
      assert.equal(await vault.totalLp(), 0n);
    });
  });
});
