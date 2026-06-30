// PH-5: independent clearinghouse kill-switches. Pausing trading must still
// allow liquidations (wind-down), and pausing liquidations must not stop trading.
const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

describe("FypherPerpsClearinghouse — PH-5 independent pause", function () {
  const marketId = ethers.encodeBytes32String("BTC-PERP");
  const FAR_DEADLINE = 2_000_000_000n;
  const PRICE = ethers.parseUnits("60000", 18);

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
    await clearinghouse.configureMarket(marketId, 500, 300, 2000, ethers.parseUnits("20", 18), ethers.parseUnits("5", 18), true);
    for (const u of [trader, secondTrader]) {
      await collateral.mint(u.address, ethers.parseUnits("50000", 18));
      await collateral.connect(u).approve(await clearinghouse.getAddress(), ethers.MaxUint256);
    }
    return { owner, relayer, liquidator, trader, secondTrader, outsider, collateral, oracle, oracleRouter, clearinghouse };
  }

  async function execTrade(clearinghouse, relayer, account, sizeE18, leverageE18, nonce) {
    const order = {
      account: account.address, marketId, isLong: true,
      maxBaseSizeE18: sizeE18, limitPriceE18: 0n, leverageE18,
      nonce: BigInt(nonce), deadline: FAR_DEADLINE,
    };
    const net = await ethers.provider.getNetwork();
    const domain = { name: "FypherPerpsClearinghouse", version: "1", chainId: net.chainId, verifyingContract: await clearinghouse.getAddress() };
    const sig = await account.signTypedData(domain, ORDER_TYPES, order);
    return clearinghouse.connect(relayer).executeMatchedTrade(order, sig, sizeE18, PRICE);
  }

  it("trading pause blocks new trades but liquidation still works", async function () {
    const { owner, relayer, liquidator, trader, oracle, clearinghouse } = await deployFixture();
    await clearinghouse.connect(trader).deposit(ethers.parseUnits("2000", 18));
    await execTrade(clearinghouse, relayer, trader, ethers.parseUnits("0.5", 18), ethers.parseUnits("20", 18), 1);

    await clearinghouse.connect(owner).setTradingPaused(true);

    // new trades blocked
    await assert.rejects(
      execTrade(clearinghouse, relayer, trader, ethers.parseUnits("0.01", 18), ethers.parseUnits("5", 18), 2),
      /trading paused/
    );

    // but a liquidatable account can still be wound down (drop to 57000 → liquidatable, no deficit)
    await oracle.setLatestAnswer(57000n * 10n ** 8n);
    assert.equal(await clearinghouse.isLiquidatable(trader.address), true);
    await clearinghouse.connect(liquidator).liquidate(trader.address, marketId);
    assert.equal((await clearinghouse.positions(trader.address, marketId)).sizeE18, 0n);
  });

  it("liquidation pause blocks liquidation but trading still works", async function () {
    const { owner, relayer, liquidator, trader, secondTrader, oracle, clearinghouse } = await deployFixture();
    await clearinghouse.connect(trader).deposit(ethers.parseUnits("2000", 18));
    await execTrade(clearinghouse, relayer, trader, ethers.parseUnits("0.5", 18), ethers.parseUnits("20", 18), 1);

    await clearinghouse.connect(owner).setLiquidationPaused(true);
    await oracle.setLatestAnswer(57000n * 10n ** 8n);
    assert.equal(await clearinghouse.isLiquidatable(trader.address), true);

    // liquidation blocked
    await assert.rejects(
      clearinghouse.connect(liquidator).liquidate(trader.address, marketId),
      /liquidation paused/
    );

    // trading still works (reset oracle so the new account is healthy)
    await oracle.setLatestAnswer(60000n * 10n ** 8n);
    await clearinghouse.connect(secondTrader).deposit(ethers.parseUnits("5000", 18));
    await execTrade(clearinghouse, relayer, secondTrader, ethers.parseUnits("0.1", 18), ethers.parseUnits("5", 18), 2);
    assert.equal((await clearinghouse.positions(secondTrader.address, marketId)).sizeE18, ethers.parseUnits("0.1", 18));
  });

  it("only the owner can toggle the pause flags", async function () {
    const { owner, outsider, clearinghouse } = await deployFixture();
    await assert.rejects(clearinghouse.connect(outsider).setTradingPaused(true), /not owner/);
    await assert.rejects(clearinghouse.connect(outsider).setLiquidationPaused(true), /not owner/);
    await clearinghouse.connect(owner).setTradingPaused(true);
    assert.equal(await clearinghouse.tradingPaused(), true);
    await clearinghouse.connect(owner).setLiquidationPaused(true);
    assert.equal(await clearinghouse.liquidationPaused(), true);
  });
});
