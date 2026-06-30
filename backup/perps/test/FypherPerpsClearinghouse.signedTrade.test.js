// PH-1: account-signed (EIP-712) authorization for relayer-submitted trades.
// Before PH-1, executeMatchedTrade was relayer-only with no account signature,
// so a compromised relayer could move any depositor's collateral. These tests
// prove the signed path: valid sig accepted, unsigned/forged rejected, partial
// fills accumulate, limit price + deadline + nonce-cancel enforced.
const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

describe("FypherPerpsClearinghouse — PH-1 signed orders", function () {
  const marketId = ethers.encodeBytes32String("BTC-PERP");
  const FAR_DEADLINE = 2_000_000_000n; // year 2033
  const PRICE = ethers.parseUnits("60000", 18);

  const types = {
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

    return { owner, relayer, liquidator, trader, secondTrader, outsider, collateral, oracle, oracleRouter, clearinghouse };
  }

  async function domainFor(clearinghouse) {
    const net = await ethers.provider.getNetwork();
    return {
      name: "FypherPerpsClearinghouse",
      version: "1",
      chainId: net.chainId,
      verifyingContract: await clearinghouse.getAddress(),
    };
  }

  function makeOrder(account, over = {}) {
    return {
      account,
      marketId,
      isLong: true,
      maxBaseSizeE18: ethers.parseUnits("0.1", 18),
      limitPriceE18: 0n,
      leverageE18: ethers.parseUnits("5", 18),
      nonce: 1n,
      deadline: FAR_DEADLINE,
      ...over,
    };
  }

  async function sign(signer, clearinghouse, order) {
    const domain = await domainFor(clearinghouse);
    return signer.signTypedData(domain, types, order);
  }

  it("accepts a relayer fill backed by the account's EIP-712 signature", async function () {
    const { relayer, trader, clearinghouse } = await deployFixture();
    await clearinghouse.connect(trader).deposit(ethers.parseUnits("10000", 18));

    const order = makeOrder(trader.address);
    const sig = await sign(trader, clearinghouse, order);
    await clearinghouse.connect(relayer).executeMatchedTrade(order, sig, ethers.parseUnits("0.1", 18), PRICE);

    const pos = await clearinghouse.positions(trader.address, marketId);
    assert.equal(pos.isLong, true);
    assert.equal(pos.sizeE18, ethers.parseUnits("0.1", 18));
    assert.equal(pos.entryPriceE18, PRICE);
  });

  it("rejects a fill the account never signed (forged signature)", async function () {
    const { relayer, trader, outsider, clearinghouse } = await deployFixture();
    await clearinghouse.connect(trader).deposit(ethers.parseUnits("10000", 18));

    const order = makeOrder(trader.address);
    const forged = await sign(outsider, clearinghouse, order); // signed by someone other than account
    await assert.rejects(
      clearinghouse.connect(relayer).executeMatchedTrade(order, forged, ethers.parseUnits("0.1", 18), PRICE),
      /bad order signature/
    );
  });

  it("rejects a fill whose params were tampered after signing", async function () {
    const { relayer, trader, clearinghouse } = await deployFixture();
    await clearinghouse.connect(trader).deposit(ethers.parseUnits("10000", 18));

    const order = makeOrder(trader.address, { isLong: true });
    const sig = await sign(trader, clearinghouse, order);
    const tampered = { ...order, isLong: false }; // relayer flips side
    await assert.rejects(
      clearinghouse.connect(relayer).executeMatchedTrade(tampered, sig, ethers.parseUnits("0.1", 18), PRICE),
      /bad order signature/
    );
  });

  it("accumulates partial fills up to maxBaseSize and rejects overfill", async function () {
    const { relayer, trader, clearinghouse } = await deployFixture();
    await clearinghouse.connect(trader).deposit(ethers.parseUnits("10000", 18));

    const order = makeOrder(trader.address, { maxBaseSizeE18: ethers.parseUnits("0.1", 18) });
    const sig = await sign(trader, clearinghouse, order);

    await clearinghouse.connect(relayer).executeMatchedTrade(order, sig, ethers.parseUnits("0.06", 18), PRICE);
    await clearinghouse.connect(relayer).executeMatchedTrade(order, sig, ethers.parseUnits("0.04", 18), PRICE);

    const pos = await clearinghouse.positions(trader.address, marketId);
    assert.equal(pos.sizeE18, ethers.parseUnits("0.1", 18));

    const orderHash = await clearinghouse.hashOrder(order);
    assert.equal(await clearinghouse.orderFilledE18(orderHash), ethers.parseUnits("0.1", 18));

    await assert.rejects(
      clearinghouse.connect(relayer).executeMatchedTrade(order, sig, ethers.parseUnits("0.01", 18), PRICE),
      /order overfilled/
    );
  });

  it("enforces the user's limit price for a long (exec must be <= limit)", async function () {
    const { relayer, trader, clearinghouse } = await deployFixture();
    await clearinghouse.connect(trader).deposit(ethers.parseUnits("10000", 18));

    const order = makeOrder(trader.address, { isLong: true, limitPriceE18: PRICE });
    const sig = await sign(trader, clearinghouse, order);

    // exec above limit but within the oracle deviation band → still rejected by the user's cap
    await assert.rejects(
      clearinghouse.connect(relayer).executeMatchedTrade(order, sig, ethers.parseUnits("0.1", 18), ethers.parseUnits("60600", 18)),
      /price above limit/
    );
    // exec at/below limit → accepted
    await clearinghouse.connect(relayer).executeMatchedTrade(order, sig, ethers.parseUnits("0.1", 18), ethers.parseUnits("59900", 18));
  });

  it("rejects expired orders", async function () {
    const { relayer, trader, clearinghouse } = await deployFixture();
    await clearinghouse.connect(trader).deposit(ethers.parseUnits("10000", 18));

    const expired = makeOrder(trader.address, { deadline: 1n });
    const sig = await sign(trader, clearinghouse, expired);
    await assert.rejects(
      clearinghouse.connect(relayer).executeMatchedTrade(expired, sig, ethers.parseUnits("0.1", 18), PRICE),
      /order expired/
    );
  });

  it("lets an account cancel a nonce to invalidate a signed order", async function () {
    const { relayer, trader, clearinghouse } = await deployFixture();
    await clearinghouse.connect(trader).deposit(ethers.parseUnits("10000", 18));

    const order = makeOrder(trader.address, { nonce: 7n });
    const sig = await sign(trader, clearinghouse, order);
    await clearinghouse.connect(trader).cancelOrderNonce(7n);
    await assert.rejects(
      clearinghouse.connect(relayer).executeMatchedTrade(order, sig, ethers.parseUnits("0.1", 18), PRICE),
      /order cancelled/
    );
  });

  it("still enforces onlyRelayer on the signed path", async function () {
    const { trader, outsider, clearinghouse } = await deployFixture();
    await clearinghouse.connect(trader).deposit(ethers.parseUnits("10000", 18));

    const order = makeOrder(trader.address);
    const sig = await sign(trader, clearinghouse, order);
    await assert.rejects(
      clearinghouse.connect(outsider).executeMatchedTrade(order, sig, ethers.parseUnits("0.1", 18), PRICE),
      /not relayer/
    );
  });

  it("still rejects leverage above the market cap even with a valid signature", async function () {
    const { relayer, trader, clearinghouse } = await deployFixture();
    await clearinghouse.connect(trader).deposit(ethers.parseUnits("10000", 18));

    const order = makeOrder(trader.address, { leverageE18: ethers.parseUnits("25", 18) });
    const sig = await sign(trader, clearinghouse, order);
    await assert.rejects(
      clearinghouse.connect(relayer).executeMatchedTrade(order, sig, ethers.parseUnits("0.05", 18), PRICE),
      /invalid leverage/
    );
  });
});
