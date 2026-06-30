// PH-10: cross-margin liquidation completeness. liquidateAll() winds down a
// multi-market unhealthy account, re-checking health after each market and
// stopping once solvent (no over-liquidation).
const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

describe("FypherPerpsClearinghouse — PH-10 liquidateAll (cross-margin)", function () {
  const BTC = ethers.encodeBytes32String("BTC-PERP");
  const ETH = ethers.encodeBytes32String("ETH-PERP");
  const FAR_DEADLINE = 2_000_000_000n;

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
    const [owner, relayer, liquidator, trader, outsider] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const MockPriceOracle = await ethers.getContractFactory("MockPriceOracle");
    const OracleRouter = await ethers.getContractFactory("FypherOracleRouter");
    const Clearinghouse = await ethers.getContractFactory("FypherPerpsClearinghouse");
    const Vault = await ethers.getContractFactory("FypherXInsuranceFundVault");

    const collateral = await MockERC20.deploy("Mock USDC", "mUSDC", 18);
    const btcOracle = await MockPriceOracle.deploy(8, 60000n * 10n ** 8n);
    const ethOracle = await MockPriceOracle.deploy(8, 60000n * 10n ** 8n);
    const oracleRouter = await OracleRouter.deploy();
    await oracleRouter.configureMarketOracle(BTC, await btcOracle.getAddress(), 8, 300, true);
    await oracleRouter.configureMarketOracle(ETH, await ethOracle.getAddress(), 8, 300, true);

    const clearinghouse = await Clearinghouse.deploy(await collateral.getAddress(), await oracleRouter.getAddress());
    await clearinghouse.setRelayer(relayer.address, true);
    await clearinghouse.setLiquidator(liquidator.address, true);
    for (const m of [BTC, ETH]) {
      await clearinghouse.configureMarket(m, 500, 300, 2000, ethers.parseUnits("20", 18), ethers.parseUnits("5", 18), true);
    }

    const vault = await Vault.deploy(await collateral.getAddress(), owner.address);
    await vault.setOperator(await clearinghouse.getAddress(), true);
    await clearinghouse.setInsuranceFund(await vault.getAddress());
    const seed = ethers.parseUnits("5000", 18);
    await collateral.mint(owner.address, seed);
    await collateral.connect(owner).approve(await vault.getAddress(), seed);
    await vault.connect(owner).deposit(seed, ethers.id("seed"));

    await collateral.mint(trader.address, ethers.parseUnits("50000", 18));
    await collateral.connect(trader).approve(await clearinghouse.getAddress(), ethers.MaxUint256);

    return { owner, relayer, liquidator, trader, outsider, collateral, btcOracle, ethOracle, clearinghouse, vault };
  }

  let _nonce = 0;
  async function openLong(clearinghouse, relayer, trader, market, sizeE18, priceE18) {
    const order = {
      account: trader.address, marketId: market, isLong: true,
      maxBaseSizeE18: sizeE18, limitPriceE18: 0n, leverageE18: ethers.parseUnits("20", 18),
      nonce: BigInt(++_nonce), deadline: FAR_DEADLINE,
    };
    const net = await ethers.provider.getNetwork();
    const domain = { name: "FypherPerpsClearinghouse", version: "1", chainId: net.chainId, verifyingContract: await clearinghouse.getAddress() };
    const sig = await trader.signTypedData(domain, ORDER_TYPES, order);
    return clearinghouse.connect(relayer).executeMatchedTrade(order, sig, sizeE18, priceE18);
  }

  it("winds down ALL positions of a multi-market unhealthy account", async function () {
    const { relayer, liquidator, trader, btcOracle, ethOracle, clearinghouse } = await deployFixture();
    await clearinghouse.connect(trader).deposit(ethers.parseUnits("5000", 18));
    await openLong(clearinghouse, relayer, trader, BTC, ethers.parseUnits("0.5", 18), ethers.parseUnits("60000", 18));
    await openLong(clearinghouse, relayer, trader, ETH, ethers.parseUnits("0.5", 18), ethers.parseUnits("60000", 18));

    // Both drop to 54000 → uPnL -3000 each → equity -1000, deeply unhealthy.
    await btcOracle.setLatestAnswer(54000n * 10n ** 8n);
    await ethOracle.setLatestAnswer(54000n * 10n ** 8n);
    assert.equal(await clearinghouse.isLiquidatable(trader.address), true);

    await clearinghouse.connect(liquidator).liquidateAll(trader.address);

    assert.equal((await clearinghouse.positions(trader.address, BTC)).sizeE18, 0n);
    assert.equal((await clearinghouse.positions(trader.address, ETH)).sizeE18, 0n);
    assert.equal(await clearinghouse.isLiquidatable(trader.address), false);
  });

  it("stops early once the account is healthy (no over-liquidation)", async function () {
    const { relayer, liquidator, trader, btcOracle, clearinghouse } = await deployFixture();
    await clearinghouse.connect(trader).deposit(ethers.parseUnits("5000", 18));
    // BTC is the loss-maker (opened first → liquidated first); ETH stays healthy.
    await openLong(clearinghouse, relayer, trader, BTC, ethers.parseUnits("0.5", 18), ethers.parseUnits("60000", 18));
    await openLong(clearinghouse, relayer, trader, ETH, ethers.parseUnits("0.1", 18), ethers.parseUnits("60000", 18));

    // Only BTC drops (to 51000): uPnL -4500 → equity 500 < maintenance → liquidatable.
    await btcOracle.setLatestAnswer(51000n * 10n ** 8n);
    assert.equal(await clearinghouse.isLiquidatable(trader.address), true);

    await clearinghouse.connect(liquidator).liquidateAll(trader.address);

    // BTC closed; ETH left open because the account was healthy again after BTC.
    assert.equal((await clearinghouse.positions(trader.address, BTC)).sizeE18, 0n);
    assert.equal((await clearinghouse.positions(trader.address, ETH)).sizeE18, ethers.parseUnits("0.1", 18));
    assert.equal(await clearinghouse.isLiquidatable(trader.address), false);
  });

  it("rejects liquidateAll from a non-liquidator and a healthy account", async function () {
    const { relayer, liquidator, trader, outsider, clearinghouse } = await deployFixture();
    await clearinghouse.connect(trader).deposit(ethers.parseUnits("5000", 18));
    await openLong(clearinghouse, relayer, trader, BTC, ethers.parseUnits("0.1", 18), ethers.parseUnits("60000", 18));

    await assert.rejects(clearinghouse.connect(outsider).liquidateAll(trader.address), /not liquidator/);
    await assert.rejects(clearinghouse.connect(liquidator).liquidateAll(trader.address), /account healthy/);
  });
});
