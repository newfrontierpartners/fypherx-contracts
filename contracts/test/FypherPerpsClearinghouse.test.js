const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

describe("FypherPerpsClearinghouse", function () {
  const marketId = ethers.encodeBytes32String("BTC-PERP");
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

    await clearinghouse.connect(relayer).executeMatchedTrade(
      trader.address,
      marketId,
      true,
      ethers.parseUnits("0.1", 18),
      ethers.parseUnits("60000", 18),
      ethers.parseUnits("5", 18)
    );

    await clearinghouse.connect(relayer).executeMatchedTrade(
      trader.address,
      marketId,
      false,
      ethers.parseUnits("0.15", 18),
      ethers.parseUnits("65000", 18),
      ethers.parseUnits("4", 18)
    );

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
      clearinghouse.connect(outsider).executeMatchedTrade(
        trader.address,
        marketId,
        true,
        ethers.parseUnits("0.05", 18),
        ethers.parseUnits("60000", 18),
        ethers.parseUnits("5", 18)
      )
    , /not relayer/);

    await assert.rejects(
      clearinghouse.connect(relayer).executeMatchedTrade(
        trader.address,
        marketId,
        true,
        ethers.parseUnits("0.05", 18),
        ethers.parseUnits("60000", 18),
        ethers.parseUnits("25", 18)
      )
    , /invalid leverage/);
  });

  it("blocks withdrawals that would violate initial margin requirements", async function () {
    const { relayer, trader, clearinghouse } = await deployFixture();
    await clearinghouse.connect(trader).deposit(ethers.parseUnits("2000", 18));

    await clearinghouse.connect(relayer).executeMatchedTrade(
      trader.address,
      marketId,
      true,
      ethers.parseUnits("0.1", 18),
      ethers.parseUnits("60000", 18),
      ethers.parseUnits("5", 18)
    );

    await assert.rejects(
      clearinghouse.connect(trader).withdraw(ethers.parseUnits("1000", 18))
    , /initial margin breach/);
  });

  it("rejects stale oracle data and liquidates unhealthy accounts", async function () {
    const { relayer, liquidator, trader, oracle, clearinghouse } = await deployFixture();
    await clearinghouse.connect(trader).deposit(ethers.parseUnits("2000", 18));

    await clearinghouse.connect(relayer).executeMatchedTrade(
      trader.address,
      marketId,
      true,
      ethers.parseUnits("0.5", 18),
      ethers.parseUnits("60000", 18),
      ethers.parseUnits("20", 18)
    );

    await ethers.provider.send("evm_increaseTime", [301]);
    await ethers.provider.send("evm_mine", []);

    await assert.rejects(
      clearinghouse.connect(relayer).executeMatchedTrade(
        trader.address,
        marketId,
        true,
        ethers.parseUnits("0.01", 18),
        ethers.parseUnits("60010", 18),
        ethers.parseUnits("20", 18)
      )
    , /stale oracle price/);

    await oracle.setLatestAnswer(57000n * 10n ** 8n);
    assert.equal(await clearinghouse.isLiquidatable(trader.address), true);

    await clearinghouse.connect(liquidator).liquidate(trader.address, marketId);
    const position = await clearinghouse.positions(trader.address, marketId);
    assert.equal(position.sizeE18, 0n);
    assert.equal(await clearinghouse.collateralBalanceE18(trader.address), ethers.parseUnits("500", 18));
  });
});
