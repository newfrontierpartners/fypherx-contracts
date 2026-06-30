const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

describe("FypherPerpsClearinghouse", function () {
  const marketId = ethers.encodeBytes32String("BTC-PERP");

  // PH-1: executeMatchedTrade now requires the account's EIP-712 signature over a
  // TradeOrder. These helpers sign a market order (maxBaseSize = exact fill,
  // limit = 0) so the existing behavioural assertions are unchanged while the
  // calls go through the new signed path. Each call uses a fresh nonce so the
  // per-order fill budget never collides within a test.
  const ORDER_TYPES = {
    TradeOrder: [
      { name: "account", type: "address" },
      { name: "marketId", type: "bytes32" },
      { name: "isLong", type: "bool" },
      { name: "maxBaseSizeE18", type: "uint256" },
      { name: "limitPriceE18", type: "uint256" },
      { name: "leverageE18", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };
  let _nonce = 0;

  async function execTrade(clearinghouse, sender, account, isLong, sizeE18, priceE18, leverageE18) {
    const order = {
      account: account.address,
      marketId,
      isLong,
      maxBaseSizeE18: sizeE18,
      limitPriceE18: 0n,
      leverageE18,
      nonce: BigInt(++_nonce),
      deadline: 2_000_000_000n,
    };
    const net = await ethers.provider.getNetwork();
    const domain = {
      name: "FypherPerpsClearinghouse",
      version: "1",
      chainId: net.chainId,
      verifyingContract: await clearinghouse.getAddress(),
    };
    const sig = await account.signTypedData(domain, ORDER_TYPES, order);
    return clearinghouse.connect(sender).executeMatchedTrade(order, sig, sizeE18, priceE18);
  }

  async function deployFixture() {
    const [owner, relayer, liquidator, trader, secondTrader, outsider] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const MockPriceOracle = await ethers.getContractFactory("MockPriceOracle");
    const OracleRouter = await ethers.getContractFactory("FypherOracleRouter");
    const Clearinghouse = await ethers.getContractFactory("FypherPerpsClearinghouse");

    const collateral = await MockERC20.deploy("Mock USDC", "mUSDC", 18);
    const oracle = await MockPriceOracle.deploy(8, 60000n * 10n ** 8n);
    const oracleRouter = await OracleRouter.deploy();
    await oracleRouter.configureMarketOracle(marketId, await oracle.getAddress(), 8, 300, true);

    const clearinghouse = await Clearinghouse.deploy(await collateral.getAddress(), await oracleRouter.getAddress());
    await clearinghouse.setRelayer(relayer.address, true);
    await clearinghouse.setLiquidator(liquidator.address, true);
    await clearinghouse.configureMarket(
      marketId,
      500,
      300,
      2000,
      ethers.parseUnits("20", 18),
      ethers.parseUnits("5", 18),
      true
    );

    for (const user of [trader, secondTrader]) {
      await collateral.mint(user.address, ethers.parseUnits("50000", 18));
      await collateral.connect(user).approve(await clearinghouse.getAddress(), ethers.MaxUint256);
    }

    return {
      owner,
      relayer,
      liquidator,
      trader,
      secondTrader,
      outsider,
      collateral,
      oracle,
      oracleRouter,
      clearinghouse,
    };
  }

  it("allows a relayer to open and flip positions while realizing pnl", async function () {
    const { relayer, trader, clearinghouse } = await deployFixture();
    await clearinghouse.connect(trader).deposit(ethers.parseUnits("10000", 18));

    await execTrade(clearinghouse, relayer, trader, true, ethers.parseUnits("0.1", 18), ethers.parseUnits("60000", 18), ethers.parseUnits("5", 18));
    await execTrade(clearinghouse, relayer, trader, false, ethers.parseUnits("0.15", 18), ethers.parseUnits("65000", 18), ethers.parseUnits("4", 18));

    const position = await clearinghouse.positions(trader.address, marketId);
    assert.equal(position.isLong, false);
    assert.equal(position.sizeE18, ethers.parseUnits("0.05", 18));
    assert.equal(position.marginE18, ethers.parseUnits("812.5", 18));
    assert.equal(await clearinghouse.collateralBalanceE18(trader.address), ethers.parseUnits("10500", 18));
  });

  it("rejects trades from non-relayers and leverage above the market cap", async function () {
    const { trader, outsider, relayer, clearinghouse } = await deployFixture();
    await clearinghouse.connect(trader).deposit(ethers.parseUnits("5000", 18));

    await assert.rejects(
      execTrade(clearinghouse, outsider, trader, true, ethers.parseUnits("0.05", 18), ethers.parseUnits("60000", 18), ethers.parseUnits("5", 18)),
      /not relayer/
    );

    await assert.rejects(
      execTrade(clearinghouse, relayer, trader, true, ethers.parseUnits("0.05", 18), ethers.parseUnits("60000", 18), ethers.parseUnits("25", 18)),
      /invalid leverage/
    );
  });

  it("blocks withdrawals that would violate initial margin requirements", async function () {
    const { relayer, trader, clearinghouse } = await deployFixture();
    await clearinghouse.connect(trader).deposit(ethers.parseUnits("2000", 18));

    await execTrade(clearinghouse, relayer, trader, true, ethers.parseUnits("0.1", 18), ethers.parseUnits("60000", 18), ethers.parseUnits("5", 18));

    await assert.rejects(
      clearinghouse.connect(trader).withdraw(ethers.parseUnits("1000", 18))
    , /initial margin breach/);
  });

  it("rejects stale oracle data and liquidates unhealthy accounts", async function () {
    const { relayer, liquidator, trader, oracle, clearinghouse } = await deployFixture();
    await clearinghouse.connect(trader).deposit(ethers.parseUnits("2000", 18));

    await execTrade(clearinghouse, relayer, trader, true, ethers.parseUnits("0.5", 18), ethers.parseUnits("60000", 18), ethers.parseUnits("20", 18));

    await ethers.provider.send("evm_increaseTime", [301]);
    await ethers.provider.send("evm_mine", []);

    await assert.rejects(
      execTrade(clearinghouse, relayer, trader, true, ethers.parseUnits("0.01", 18), ethers.parseUnits("60010", 18), ethers.parseUnits("20", 18))
    , /stale oracle price/);

    await oracle.setLatestAnswer(57000n * 10n ** 8n);
    assert.equal(await clearinghouse.isLiquidatable(trader.address), true);

    await clearinghouse.connect(liquidator).liquidate(trader.address, marketId);
    const position = await clearinghouse.positions(trader.address, marketId);
    assert.equal(position.sizeE18, 0n);
    assert.equal(await clearinghouse.collateralBalanceE18(trader.address), ethers.parseUnits("500", 18));
  });

  // April-audit H-4: a liquidation that resolves to negative collateral
  // must draw the deficit from the insurance fund and zero the ledger,
  // not silently leave the account underwater (which previously gave the
  // user a free option to keep trading until equity climbed back).
  it("draws liquidation deficits from the insurance fund and zeroes the account", async function () {
    const { owner, relayer, liquidator, trader, collateral, oracle, clearinghouse } = await deployFixture();

    const Vault = await ethers.getContractFactory("FypherXInsuranceFundVault");
    const vault = await Vault.deploy(await collateral.getAddress(), owner.address);
    // Clearinghouse needs to be the operator so its `liquidate` can call
    // `withdraw` on the vault on behalf of the bad-debt account.
    await vault.setOperator(await clearinghouse.getAddress(), true);
    await clearinghouse.setInsuranceFund(await vault.getAddress());

    // Pre-fund the vault. The deposit is large enough to cover the
    // 2000-unit deficit we're about to create below.
    const fundedAmount = ethers.parseUnits("5000", 18);
    await collateral.mint(owner.address, fundedAmount);
    await collateral.connect(owner).approve(await vault.getAddress(), fundedAmount);
    await vault.connect(owner).deposit(fundedAmount, ethers.id("seed"));

    // Open a 0.5 BTC long at $60000 with 20x leverage on $2000 of margin.
    // A drop to $52000 produces a realized PnL of −$4000, exceeding the
    // collateral by $2000 — the exact figure the fund must cover.
    await clearinghouse.connect(trader).deposit(ethers.parseUnits("2000", 18));
    await execTrade(clearinghouse, relayer, trader, true, ethers.parseUnits("0.5", 18), ethers.parseUnits("60000", 18), ethers.parseUnits("20", 18));

    await oracle.setLatestAnswer(52000n * 10n ** 8n);
    assert.equal(await clearinghouse.isLiquidatable(trader.address), true);

    const vaultBalanceBefore = await collateral.balanceOf(await vault.getAddress());
    const clearingBalanceBefore = await collateral.balanceOf(await clearinghouse.getAddress());

    await assert.doesNotReject(
      clearinghouse.connect(liquidator).liquidate(trader.address, marketId)
    );

    const vaultBalanceAfter = await collateral.balanceOf(await vault.getAddress());
    const clearingBalanceAfter = await collateral.balanceOf(await clearinghouse.getAddress());
    const expectedDeficit = ethers.parseUnits("2000", 18);
    assert.equal(vaultBalanceBefore - vaultBalanceAfter, expectedDeficit);
    assert.equal(clearingBalanceAfter - clearingBalanceBefore, expectedDeficit);
    // The bad-debt user account is reset to 0 — no negative collateral
    // option remains.
    assert.equal(await clearinghouse.collateralBalanceE18(trader.address), 0n);
  });

  it("reverts a deficit liquidation when no insurance fund is configured", async function () {
    const { relayer, liquidator, trader, oracle, clearinghouse } = await deployFixture();

    await clearinghouse.connect(trader).deposit(ethers.parseUnits("2000", 18));
    await execTrade(clearinghouse, relayer, trader, true, ethers.parseUnits("0.5", 18), ethers.parseUnits("60000", 18), ethers.parseUnits("20", 18));
    await oracle.setLatestAnswer(52000n * 10n ** 8n);

    await assert.rejects(
      clearinghouse.connect(liquidator).liquidate(trader.address, marketId)
    , /no insurance fund/);
  });

  it("reverts a deficit liquidation when the insurance fund cannot cover it", async function () {
    const { owner, relayer, liquidator, trader, collateral, oracle, clearinghouse } = await deployFixture();

    const Vault = await ethers.getContractFactory("FypherXInsuranceFundVault");
    const vault = await Vault.deploy(await collateral.getAddress(), owner.address);
    await vault.setOperator(await clearinghouse.getAddress(), true);
    await clearinghouse.setInsuranceFund(await vault.getAddress());

    // Fund the vault with only $500 — strictly less than the $2000
    // deficit, so the safeguard check should trip.
    const seedAmount = ethers.parseUnits("500", 18);
    await collateral.mint(owner.address, seedAmount);
    await collateral.connect(owner).approve(await vault.getAddress(), seedAmount);
    await vault.connect(owner).deposit(seedAmount, ethers.id("seed-too-small"));

    await clearinghouse.connect(trader).deposit(ethers.parseUnits("2000", 18));
    await execTrade(clearinghouse, relayer, trader, true, ethers.parseUnits("0.5", 18), ethers.parseUnits("60000", 18), ethers.parseUnits("20", 18));
    await oracle.setLatestAnswer(52000n * 10n ** 8n);

    await assert.rejects(
      clearinghouse.connect(liquidator).liquidate(trader.address, marketId)
    , /insurance underfunded/);
  });

  // ── Admin / access control ───────────────────────────────────────────────
  it("allows owner to transfer ownership", async function () {
    const { owner, outsider, clearinghouse } = await deployFixture();
    await clearinghouse.connect(owner).setOwner(outsider.address);
    assert.equal(await clearinghouse.owner(), outsider.address);
  });

  it("rejects setOwner from non-owner", async function () {
    const { outsider, clearinghouse } = await deployFixture();
    await assert.rejects(clearinghouse.connect(outsider).setOwner(outsider.address), /not owner/);
  });

  it("allows owner to add and revoke relayers and liquidators", async function () {
    const { owner, outsider, clearinghouse } = await deployFixture();
    await clearinghouse.connect(owner).setRelayer(outsider.address, true);
    assert.equal(await clearinghouse.relayers(outsider.address), true);
    await clearinghouse.connect(owner).setRelayer(outsider.address, false);
    assert.equal(await clearinghouse.relayers(outsider.address), false);

    await clearinghouse.connect(owner).setLiquidator(outsider.address, true);
    assert.equal(await clearinghouse.liquidators(outsider.address), true);
  });

  it("rejects configureMarket from non-owner", async function () {
    const { outsider, clearinghouse } = await deployFixture();
    await assert.rejects(
      clearinghouse.connect(outsider).configureMarket(marketId, 500, 300, 2000, ethers.parseUnits("20", 18), ethers.parseUnits("5", 18), true),
      /not owner/
    );
  });

  it("rejects configureMarket with invalid margin params", async function () {
    const { owner, clearinghouse } = await deployFixture();
    const mkt = ethers.encodeBytes32String("NEW-PERP");
    // initialMarginBps = 0
    await assert.rejects(
      clearinghouse.connect(owner).configureMarket(mkt, 0, 300, 2000, ethers.parseUnits("20", 18), ethers.parseUnits("5", 18), true),
      /invalid im/
    );
    // maintenanceMarginBps > initialMarginBps
    await assert.rejects(
      clearinghouse.connect(owner).configureMarket(mkt, 300, 500, 2000, ethers.parseUnits("20", 18), ethers.parseUnits("5", 18), true),
      /invalid mm/
    );
  });

  // ── Deposit / withdraw ───────────────────────────────────────────────────
  it("deposit and full withdraw with no open position", async function () {
    const { trader, collateral, clearinghouse } = await deployFixture();
    const dep = ethers.parseUnits("5000", 18);
    const balBefore = await collateral.balanceOf(trader.address);
    await clearinghouse.connect(trader).deposit(dep);
    assert.equal(await clearinghouse.collateralBalanceE18(trader.address), dep);
    await clearinghouse.connect(trader).withdraw(dep);
    assert.equal(await clearinghouse.collateralBalanceE18(trader.address), 0n);
    assert.equal(await collateral.balanceOf(trader.address), balBefore);
  });

  it("rejects zero deposit and zero withdraw", async function () {
    const { trader, clearinghouse } = await deployFixture();
    await assert.rejects(clearinghouse.connect(trader).deposit(0n), /invalid deposit/);
    await assert.rejects(clearinghouse.connect(trader).withdraw(0n), /invalid withdraw/);
  });

  it("rejects withdraw exceeding collateral balance", async function () {
    const { trader, clearinghouse } = await deployFixture();
    await clearinghouse.connect(trader).deposit(ethers.parseUnits("1000", 18));
    await assert.rejects(
      clearinghouse.connect(trader).withdraw(ethers.parseUnits("2000", 18)),
      /insufficient collateral/
    );
  });

  // ── View helpers ─────────────────────────────────────────────────────────
  it("getConfiguredMarkets returns the market list", async function () {
    const { clearinghouse } = await deployFixture();
    const markets = await clearinghouse.getConfiguredMarkets();
    assert.equal(markets.length, 1);
    assert.equal(markets[0], marketId);
  });

  it("getAccountMarkets is empty before any trade", async function () {
    const { trader, clearinghouse } = await deployFixture();
    const acctMarkets = await clearinghouse.getAccountMarkets(trader.address);
    assert.equal(acctMarkets.length, 0);
  });

  it("getAccountMarkets lists market after opening a position", async function () {
    const { relayer, trader, clearinghouse } = await deployFixture();
    await clearinghouse.connect(trader).deposit(ethers.parseUnits("5000", 18));
    await execTrade(clearinghouse, relayer, trader, true, ethers.parseUnits("0.1", 18), ethers.parseUnits("60000", 18), ethers.parseUnits("5", 18));
    const acctMarkets = await clearinghouse.getAccountMarkets(trader.address);
    assert.equal(acctMarkets.length, 1);
    assert.equal(acctMarkets[0], marketId);
  });

  it("getAccountSnapshot reflects position state correctly", async function () {
    const { relayer, trader, clearinghouse } = await deployFixture();
    await clearinghouse.connect(trader).deposit(ethers.parseUnits("5000", 18));
    await execTrade(clearinghouse, relayer, trader, true, ethers.parseUnits("0.1", 18), ethers.parseUnits("60000", 18), ethers.parseUnits("5", 18));
    const snap = await clearinghouse.getAccountSnapshot(trader.address);
    assert.ok(snap.collateralE18 > 0n, "collateral should be positive");
    assert.equal(snap.liquidatable, false);
    assert.ok(snap.initialMarginUsedE18 > 0n, "initial margin should be non-zero");
  });

  it("isLiquidatable returns false for a healthy account", async function () {
    const { relayer, trader, clearinghouse } = await deployFixture();
    await clearinghouse.connect(trader).deposit(ethers.parseUnits("10000", 18));
    await execTrade(clearinghouse, relayer, trader, true, ethers.parseUnits("0.1", 18), ethers.parseUnits("60000", 18), ethers.parseUnits("5", 18));
    assert.equal(await clearinghouse.isLiquidatable(trader.address), false);
  });

  it("rejects liquidation of a healthy account", async function () {
    const { relayer, liquidator, trader, clearinghouse } = await deployFixture();
    await clearinghouse.connect(trader).deposit(ethers.parseUnits("10000", 18));
    await execTrade(clearinghouse, relayer, trader, true, ethers.parseUnits("0.1", 18), ethers.parseUnits("60000", 18), ethers.parseUnits("5", 18));
    await assert.rejects(
      clearinghouse.connect(liquidator).liquidate(trader.address, marketId),
      /account healthy/
    );
  });

  // ── Reduce and close position ─────────────────────────────────────────────
  it("reduces a position partially and closes it fully", async function () {
    const { relayer, trader, clearinghouse } = await deployFixture();
    await clearinghouse.connect(trader).deposit(ethers.parseUnits("10000", 18));

    // open 0.2 BTC long
    await execTrade(clearinghouse, relayer, trader, true, ethers.parseUnits("0.2", 18), ethers.parseUnits("60000", 18), ethers.parseUnits("5", 18));
    // reduce by 0.1
    await execTrade(clearinghouse, relayer, trader, false, ethers.parseUnits("0.1", 18), ethers.parseUnits("60000", 18), ethers.parseUnits("5", 18));
    let pos = await clearinghouse.positions(trader.address, marketId);
    assert.equal(pos.sizeE18, ethers.parseUnits("0.1", 18));

    // close remaining
    await execTrade(clearinghouse, relayer, trader, false, ethers.parseUnits("0.1", 18), ethers.parseUnits("60000", 18), ethers.parseUnits("5", 18));
    pos = await clearinghouse.positions(trader.address, marketId);
    assert.equal(pos.sizeE18, 0n);
  });

  // ── Inactive market ───────────────────────────────────────────────────────
  it("rejects trades on an inactive market", async function () {
    const { owner, relayer, trader, clearinghouse } = await deployFixture();
    await clearinghouse.connect(trader).deposit(ethers.parseUnits("5000", 18));

    // deactivate market
    await clearinghouse.connect(owner).configureMarket(
      marketId, 500, 300, 2000,
      ethers.parseUnits("20", 18), ethers.parseUnits("5", 18), false
    );

    await assert.rejects(
      execTrade(clearinghouse, relayer, trader, true, ethers.parseUnits("0.1", 18), ethers.parseUnits("60000", 18), ethers.parseUnits("5", 18)),
      /market inactive/
    );
  });
});
