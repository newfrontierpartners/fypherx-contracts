// PH-3: capped liquidation reward paid to the liquidator from the insurance fund.
const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

describe("FypherPerpsClearinghouse — PH-3 liquidation reward", function () {
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
    const Vault = await ethers.getContractFactory("FypherXInsuranceFundVault");

    const collateral = await MockERC20.deploy("Mock USDC", "mUSDC", 18);
    const oracle = await MockPriceOracle.deploy(8, 60000n * 10n ** 8n);
    const oracleRouter = await OracleRouter.deploy();
    await oracleRouter.configureMarketOracle(marketId, await oracle.getAddress(), 8, 300, true);
    const clearinghouse = await Clearinghouse.deploy(await collateral.getAddress(), await oracleRouter.getAddress());
    await clearinghouse.setRelayer(relayer.address, true);
    await clearinghouse.setLiquidator(liquidator.address, true);
    await clearinghouse.configureMarket(marketId, 500, 300, 2000, ethers.parseUnits("20", 18), ethers.parseUnits("5", 18), true);

    const vault = await Vault.deploy(await collateral.getAddress(), owner.address);
    await vault.setOperator(await clearinghouse.getAddress(), true);
    await clearinghouse.setInsuranceFund(await vault.getAddress());
    const seed = ethers.parseUnits("1000", 18);
    await collateral.mint(owner.address, seed);
    await collateral.connect(owner).approve(await vault.getAddress(), seed);
    await vault.connect(owner).deposit(seed, ethers.id("seed"));

    for (const u of [trader, secondTrader]) {
      await collateral.mint(u.address, ethers.parseUnits("50000", 18));
      await collateral.connect(u).approve(await clearinghouse.getAddress(), ethers.MaxUint256);
    }
    return { owner, relayer, liquidator, trader, outsider, collateral, oracle, clearinghouse, vault };
  }

  async function openHalfLong(clearinghouse, relayer, trader) {
    const order = {
      account: trader.address, marketId, isLong: true,
      maxBaseSizeE18: ethers.parseUnits("0.5", 18), limitPriceE18: 0n,
      leverageE18: ethers.parseUnits("20", 18), nonce: 1n, deadline: FAR_DEADLINE,
    };
    const net = await ethers.provider.getNetwork();
    const domain = { name: "FypherPerpsClearinghouse", version: "1", chainId: net.chainId, verifyingContract: await clearinghouse.getAddress() };
    const sig = await trader.signTypedData(domain, ORDER_TYPES, order);
    await clearinghouse.connect(relayer).executeMatchedTrade(order, sig, order.maxBaseSizeE18, PRICE);
  }

  it("only owner sets the reward and bps is capped at 5%", async function () {
    const { owner, outsider, clearinghouse } = await deployFixture();
    await assert.rejects(clearinghouse.connect(outsider).setLiquidationReward(10, 0n), /not owner/);
    await assert.rejects(clearinghouse.connect(owner).setLiquidationReward(501, 0n), /reward bps too high/);
    await clearinghouse.connect(owner).setLiquidationReward(10, 0n);
    assert.equal(await clearinghouse.liquidationRewardBps(), 10n);
  });

  it("pays the liquidator a bps reward from the insurance fund on liquidation", async function () {
    const { owner, relayer, liquidator, trader, oracle, collateral, clearinghouse, vault } = await deployFixture();
    await clearinghouse.connect(trader).deposit(ethers.parseUnits("2000", 18));
    await openHalfLong(clearinghouse, relayer, trader);
    await clearinghouse.connect(owner).setLiquidationReward(10, 0n); // 0.1%

    await oracle.setLatestAnswer(57000n * 10n ** 8n); // liquidatable, no deficit (residual +500)
    assert.equal(await clearinghouse.isLiquidatable(trader.address), true);

    const liqBefore = await collateral.balanceOf(liquidator.address);
    const fundBefore = await vault.balance();
    await clearinghouse.connect(liquidator).liquidate(trader.address, marketId);

    // notional at mark 57000 = 0.5 * 57000 = 28500; reward = 28500 * 10bps = 28.5
    const reward = ethers.parseUnits("28.5", 18);
    assert.equal((await collateral.balanceOf(liquidator.address)) - liqBefore, reward);
    assert.equal(fundBefore - (await vault.balance()), reward);
  });

  it("respects the absolute reward cap", async function () {
    const { owner, relayer, liquidator, trader, oracle, collateral, clearinghouse } = await deployFixture();
    await clearinghouse.connect(trader).deposit(ethers.parseUnits("2000", 18));
    await openHalfLong(clearinghouse, relayer, trader);
    await clearinghouse.connect(owner).setLiquidationReward(10, ethers.parseUnits("10", 18)); // cap below bps reward

    await oracle.setLatestAnswer(57000n * 10n ** 8n);
    const liqBefore = await collateral.balanceOf(liquidator.address);
    await clearinghouse.connect(liquidator).liquidate(trader.address, marketId);
    assert.equal((await collateral.balanceOf(liquidator.address)) - liqBefore, ethers.parseUnits("10", 18));
  });

  it("pays no reward when unconfigured (default off)", async function () {
    const { relayer, liquidator, trader, oracle, collateral, clearinghouse } = await deployFixture();
    await clearinghouse.connect(trader).deposit(ethers.parseUnits("2000", 18));
    await openHalfLong(clearinghouse, relayer, trader);
    await oracle.setLatestAnswer(57000n * 10n ** 8n);
    const liqBefore = await collateral.balanceOf(liquidator.address);
    await clearinghouse.connect(liquidator).liquidate(trader.address, marketId);
    assert.equal(await collateral.balanceOf(liquidator.address), liqBefore); // unchanged
  });
});
