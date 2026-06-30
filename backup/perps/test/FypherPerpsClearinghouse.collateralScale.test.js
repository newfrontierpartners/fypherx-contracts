// PH-2: 6-decimal collateral scaling. Internal accounting is E18; on-chain
// transfers (deposit/withdraw + insurance-fund draw) are in the token's native
// units. Verifies a 6-dec (USDC/USDT-style) collateral round-trips correctly and
// that a liquidation deficit is drawn from the vault in token units.
const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

describe("FypherPerpsClearinghouse — PH-2 6-decimal collateral", function () {
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

  // collateralDecimals lets us exercise both 6-dec (PH-2 path) and 18-dec.
  async function deployFixture(collateralDecimals) {
    const [owner, relayer, liquidator, trader, secondTrader, outsider] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const MockPriceOracle = await ethers.getContractFactory("MockPriceOracle");
    const OracleRouter = await ethers.getContractFactory("FypherOracleRouter");
    const Clearinghouse = await ethers.getContractFactory("FypherPerpsClearinghouse");

    const collateral = await MockERC20.deploy("Mock USDC", "mUSDC", collateralDecimals);
    const oracle = await MockPriceOracle.deploy(8, 60000n * 10n ** 8n);
    const oracleRouter = await OracleRouter.deploy();
    await oracleRouter.configureMarketOracle(marketId, await oracle.getAddress(), 8, 300, true);

    const clearinghouse = await Clearinghouse.deploy(await collateral.getAddress(), await oracleRouter.getAddress());
    await clearinghouse.setRelayer(relayer.address, true);
    await clearinghouse.setLiquidator(liquidator.address, true);
    await clearinghouse.configureMarket(
      marketId, 500, 300, 2000,
      ethers.parseUnits("20", 18), ethers.parseUnits("5", 18), true
    );

    for (const user of [trader, secondTrader]) {
      await collateral.mint(user.address, ethers.parseUnits("50000", collateralDecimals));
      await collateral.connect(user).approve(await clearinghouse.getAddress(), ethers.MaxUint256);
    }

    return { owner, relayer, liquidator, trader, secondTrader, outsider, collateral, oracle, oracleRouter, clearinghouse };
  }

  async function signOrder(account, clearinghouse, order) {
    const net = await ethers.provider.getNetwork();
    const domain = {
      name: "FypherPerpsClearinghouse",
      version: "1",
      chainId: net.chainId,
      verifyingContract: await clearinghouse.getAddress(),
    };
    return account.signTypedData(domain, ORDER_TYPES, order);
  }

  async function execTrade(clearinghouse, relayer, account, over, nonce) {
    const order = {
      account: account.address, marketId, isLong: true,
      maxBaseSizeE18: ethers.parseUnits("0.5", 18), limitPriceE18: 0n,
      leverageE18: ethers.parseUnits("20", 18), nonce: BigInt(nonce), deadline: FAR_DEADLINE,
      ...over,
    };
    const sig = await signOrder(account, clearinghouse, order);
    return clearinghouse.connect(relayer).executeMatchedTrade(order, sig, order.maxBaseSizeE18, PRICE);
  }

  it("collateralScale is 1e12 for a 6-decimal token (and 1 for 18-dec)", async function () {
    const six = await deployFixture(6);
    assert.equal(await six.clearinghouse.collateralScale(), 10n ** 12n);
    const eighteen = await deployFixture(18);
    assert.equal(await eighteen.clearinghouse.collateralScale(), 1n);
  });

  it("deposit/withdraw move token-native units while the ledger stays E18", async function () {
    const { trader, collateral, clearinghouse } = await deployFixture(6);
    const depE18 = ethers.parseUnits("5000", 18);
    const expectTokens = ethers.parseUnits("5000", 6); // 5000e6 actually transferred

    const balBefore = await collateral.balanceOf(trader.address);
    await clearinghouse.connect(trader).deposit(depE18);
    assert.equal(balBefore - (await collateral.balanceOf(trader.address)), expectTokens);
    // ledger is E18
    assert.equal(await clearinghouse.collateralBalanceE18(trader.address), depE18);
    // contract holds the 6-dec tokens
    assert.equal(await collateral.balanceOf(await clearinghouse.getAddress()), expectTokens);

    await clearinghouse.connect(trader).withdraw(depE18);
    assert.equal(await clearinghouse.collateralBalanceE18(trader.address), 0n);
    assert.equal(await collateral.balanceOf(trader.address), balBefore);
  });

  it("rejects deposits/withdrawals not aligned to the token granularity", async function () {
    const { trader, clearinghouse } = await deployFixture(6);
    // 1 wei of E18 is sub-token for a 6-dec collateral (scale 1e12) → revert
    await assert.rejects(clearinghouse.connect(trader).deposit(1n), /amount not token-aligned/);
    await clearinghouse.connect(trader).deposit(ethers.parseUnits("1000", 18));
    await assert.rejects(
      clearinghouse.connect(trader).withdraw(ethers.parseUnits("1000", 18) + 1n),
      /amount not token-aligned/
    );
  });

  it("draws a liquidation deficit from a 6-dec-funded insurance vault in token units", async function () {
    const { owner, relayer, liquidator, trader, collateral, oracle, clearinghouse } = await deployFixture(6);

    const Vault = await ethers.getContractFactory("FypherXInsuranceFundVault");
    const vault = await Vault.deploy(await collateral.getAddress(), owner.address);
    await vault.setOperator(await clearinghouse.getAddress(), true);
    await clearinghouse.setInsuranceFund(await vault.getAddress());

    // Fund the vault with 5000 USDC (6-dec native units).
    const seed = ethers.parseUnits("5000", 6);
    await collateral.mint(owner.address, seed);
    await collateral.connect(owner).approve(await vault.getAddress(), seed);
    await vault.connect(owner).deposit(seed, ethers.id("seed-6dec"));

    // 0.5 BTC long @ 60000, 20x, on 2000 margin. Drop to 52000 → -4000 PnL →
    // 2000 deficit (E18) → 2000e6 token units pulled from the vault.
    await clearinghouse.connect(trader).deposit(ethers.parseUnits("2000", 18));
    await execTrade(clearinghouse, relayer, trader, {}, 1);

    await oracle.setLatestAnswer(52000n * 10n ** 8n);
    assert.equal(await clearinghouse.isLiquidatable(trader.address), true);

    const vaultBefore = await collateral.balanceOf(await vault.getAddress());
    await clearinghouse.connect(liquidator).liquidate(trader.address, marketId);
    const vaultAfter = await collateral.balanceOf(await vault.getAddress());

    assert.equal(vaultBefore - vaultAfter, ethers.parseUnits("2000", 6)); // token units, not E18
    assert.equal(await clearinghouse.collateralBalanceE18(trader.address), 0n);
  });
});
