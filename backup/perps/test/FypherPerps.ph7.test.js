// PH-7: safe ERC-20 (non-bool tokens), reentrancy guard surface, tradeId!=0.
const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

describe("PH-7 — safe ERC20 + tradeId guard", function () {
  const marketId = ethers.encodeBytes32String("BTC-PERP");

  it("clearinghouse deposit/withdraw work with a non-bool-returning ERC20 (USDT-style)", async function () {
    const [owner, trader] = await ethers.getSigners();
    const MockNoReturn = await ethers.getContractFactory("MockNoReturnERC20");
    const MockPriceOracle = await ethers.getContractFactory("MockPriceOracle");
    const OracleRouter = await ethers.getContractFactory("FypherOracleRouter");
    const Clearinghouse = await ethers.getContractFactory("FypherPerpsClearinghouse");

    const collateral = await MockNoReturn.deploy("USDT", "USDT", 18);
    const oracle = await MockPriceOracle.deploy(8, 60000n * 10n ** 8n);
    const oracleRouter = await OracleRouter.deploy();
    await oracleRouter.configureMarketOracle(marketId, await oracle.getAddress(), 8, 300, true);
    const clearinghouse = await Clearinghouse.deploy(await collateral.getAddress(), await oracleRouter.getAddress());

    await collateral.mint(trader.address, ethers.parseUnits("10000", 18));
    await collateral.connect(trader).approve(await clearinghouse.getAddress(), ethers.MaxUint256);

    const dep = ethers.parseUnits("5000", 18);
    // would revert here if _safeTransferFrom required a bool return
    await clearinghouse.connect(trader).deposit(dep);
    assert.equal(await clearinghouse.collateralBalanceE18(trader.address), dep);
    assert.equal(await collateral.balanceOf(await clearinghouse.getAddress()), dep);

    await clearinghouse.connect(trader).withdraw(dep);
    assert.equal(await clearinghouse.collateralBalanceE18(trader.address), 0n);
    assert.equal(await collateral.balanceOf(trader.address), ethers.parseUnits("10000", 18));
  });

  it("insurance vault deposit/withdraw work with a non-bool-returning ERC20", async function () {
    const [owner, operator, recipient] = await ethers.getSigners();
    const MockNoReturn = await ethers.getContractFactory("MockNoReturnERC20");
    const Vault = await ethers.getContractFactory("FypherXInsuranceFundVault");

    const token = await MockNoReturn.deploy("USDT", "USDT", 6);
    const vault = await Vault.deploy(await token.getAddress(), operator.address);

    await token.mint(owner.address, ethers.parseUnits("1000", 6));
    await token.connect(owner).approve(await vault.getAddress(), ethers.MaxUint256);
    await vault.connect(owner).deposit(ethers.parseUnits("1000", 6), ethers.id("seed"));
    assert.equal(await vault.balance(), ethers.parseUnits("1000", 6));

    await vault.connect(operator).withdraw(recipient.address, ethers.parseUnits("400", 6), ethers.id("draw"));
    assert.equal(await token.balanceOf(recipient.address), ethers.parseUnits("400", 6));
    assert.equal(await vault.balance(), ethers.parseUnits("600", 6));
  });

  it("settlement rejects a zero tradeId (cannot be deduped against replay)", async function () {
    const [owner, relayer, signer] = await ethers.getSigners();
    const Settlement = await ethers.getContractFactory("FypherXSettlement");
    const settlement = await Settlement.deploy(relayer.address, signer.address);

    const trade = {
      tradeId: ethers.ZeroHash,
      marketId,
      makerSubaccountId: ethers.encodeBytes32String("maker"),
      takerSubaccountId: ethers.encodeBytes32String("taker"),
      priceE18: ethers.parseUnits("60000", 18),
      quantityE18: ethers.parseUnits("0.1", 18),
      makerFeeE18: 0n,
      takerFeeE18: 0n,
      payload: "0x",
    };
    const dummySig = "0x" + "11".repeat(64) + "1b"; // 65 bytes; checked AFTER tradeId guard
    await assert.rejects(
      settlement.connect(relayer).settleTrade(trade, dummySig),
      /invalid tradeId/
    );
  });
});
