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
    await clearinghouse.connect(relayer).executeMatchedTrade(
      trader.address,
      marketId,
      true,
      ethers.parseUnits("0.5", 18),
      ethers.parseUnits("60000", 18),
      ethers.parseUnits("20", 18)
    );

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
    await clearinghouse.connect(relayer).executeMatchedTrade(
      trader.address,
      marketId,
      true,
      ethers.parseUnits("0.5", 18),
      ethers.parseUnits("60000", 18),
      ethers.parseUnits("20", 18)
    );
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
    await clearinghouse.connect(relayer).executeMatchedTrade(
      trader.address,
      marketId,
      true,
      ethers.parseUnits("0.5", 18),
      ethers.parseUnits("60000", 18),
      ethers.parseUnits("20", 18)
    );
    await oracle.setLatestAnswer(52000n * 10n ** 8n);

    await assert.rejects(
      clearinghouse.connect(liquidator).liquidate(trader.address, marketId)
    , /insurance underfunded/);
  });
});
