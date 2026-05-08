/**
 * FypherLending — Stage 1 smoke test (RUSD/USDT market).
 *
 * Refactored from the original `backup/scripts/lending-smoke.js`. Exercises
 * the happy path:
 *   • Alice supplies RUSD as collateral; Bob supplies USDT liquidity.
 *   • Alice borrows USDT under LLTV; healthFactor > 1.
 *   • Time fast-forwards 1 year → interest accrues; totalBorrowAssets grows.
 *   • Alice repays in full, Bob withdraws (gains accrued yield net of reserve).
 *   • Reserves skim to the InsuranceFundV2.
 *
 * Plus revert-path checks:
 *   • Borrow above LLTV reverts.
 *   • Liquidating a healthy position reverts.
 *
 * Mirrors the params hard-coded in scripts/deploy-lending-sepolia.js so the
 * test is a faithful smoke for the Stage 1 deploy script.
 */
const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

const ONE = 10n ** 18n;
const WAD = 10n ** 18n;
const ORACLE_PRICE_SCALE = 10n ** 36n;

// IRM params — must match deploy-lending-sepolia.js.
const IRM_BASE      = (4n   * WAD) / 100n;
const IRM_KINK      = (80n  * WAD) / 100n;
const IRM_SLOPE1    = (10n  * WAD) / 100n;
const IRM_SLOPE2    = (250n * WAD) / 100n;

// Market params (Stage 1 RUSD/USDT) — must match deploy-lending-sepolia.js.
const LLTV_BPS               = 9200n;
const LIQUIDATION_BONUS_BPS  = 500n;
const RESERVE_FACTOR_BPS     = 1000n;

async function deployStack() {
  const [deployer, alice, bob, liquidator] = await ethers.getSigners();

  const MockERC20 = await ethers.getContractFactory("contracts/mocks/MockERC20.sol:MockERC20");
  const rusd = await MockERC20.deploy("RUSD", "RUSD", 18);
  const usdt = await MockERC20.deploy("USDT", "USDT", 18);
  await rusd.waitForDeployment();
  await usdt.waitForDeployment();

  const Adapter = await ethers.getContractFactory("ConstantOracleAdapter");
  const oracle = await Adapter.deploy(ORACLE_PRICE_SCALE);
  await oracle.waitForDeployment();

  const KinkedIRM = await ethers.getContractFactory("KinkedIRM");
  const irm = await KinkedIRM.deploy(IRM_BASE, IRM_KINK, IRM_SLOPE1, IRM_SLOPE2);
  await irm.waitForDeployment();

  const Fund = await ethers.getContractFactory("InsuranceFundV2");
  const fund = await Fund.deploy(deployer.address);
  await fund.waitForDeployment();

  const Factory = await ethers.getContractFactory("FypherLendingMarketFactory");
  const factory = await Factory.deploy(deployer.address, await fund.getAddress());
  await factory.waitForDeployment();
  await (await fund.setFactory(await factory.getAddress())).wait();

  const init = {
    loanToken:           await usdt.getAddress(),
    collateralToken:     await rusd.getAddress(),
    oracle:              await oracle.getAddress(),
    irm:                 await irm.getAddress(),
    lltvBps:             LLTV_BPS,
    liquidationBonusBps: LIQUIDATION_BONUS_BPS,
    reserveFactorBps:    RESERVE_FACTOR_BPS,
    supplyCap:           0n,
    borrowCap:           0n,
    timelock:            deployer.address,
    insuranceFund:       await fund.getAddress(),
  };
  await (await factory.createMarket(init)).wait();
  const marketAddr = await factory.markets(0);
  const market = await ethers.getContractAt("FypherLendingMarket", marketAddr);

  return { deployer, alice, bob, liquidator, rusd, usdt, oracle, irm, fund, factory, market };
}

describe("FypherLending — Stage 1 smoke (RUSD/USDT)", () => {
  it("end-to-end: supply → borrow → accrue → repay → withdraw → skim", async () => {
    const { alice, bob, deployer, rusd, usdt, fund, market } = await deployStack();
    const marketAddr = await market.getAddress();

    // Fund Alice (collateral), Bob (liquidity).
    await (await rusd.mint(alice.address, 500n * ONE)).wait();
    await (await usdt.mint(bob.address,   1000n * ONE)).wait();

    // Alice supplies 500 RUSD as collateral.
    await (await rusd.connect(alice).approve(marketAddr, 500n * ONE)).wait();
    await (await market.connect(alice).supplyCollateral(500n * ONE, alice.address)).wait();
    assert.equal((await market.collateralOf(alice.address)).toString(), (500n * ONE).toString());

    // Bob supplies 1000 USDT.
    await (await usdt.connect(bob).approve(marketAddr, 1000n * ONE)).wait();
    await (await market.connect(bob).supply(1000n * ONE, bob.address)).wait();
    assert.equal((await market.supplyAssetsOf(bob.address)).toString(), (1000n * ONE).toString());

    // Alice borrows 400 USDT (under 92% LLTV ≈ 460 max).
    await (await market.connect(alice).borrow(400n * ONE, alice.address)).wait();
    assert.equal((await usdt.balanceOf(alice.address)).toString(), (400n * ONE).toString());
    const hf0 = await market.healthFactor(alice.address);
    assert.ok(hf0 > WAD, `healthFactor should exceed 1e18, got ${hf0}`);

    // Fast-forward 1 year → utilisation 40% (under kink) so rate ≈ 4 + 10*40/80 = 9% APR.
    await ethers.provider.send("evm_increaseTime", [365 * 86400]);
    await ethers.provider.send("evm_mine", []);

    // Trigger _accrueInterest via a tiny supply; supplyCollateral wouldn't accrue.
    await (await usdt.mint(deployer.address, 1)).wait();
    await (await usdt.approve(marketAddr, 1)).wait();
    await (await market.supply(1, deployer.address)).wait();

    const debtAfter = await market.debtAssetsOf(alice.address);
    assert.ok(debtAfter > 400n * ONE, `debt should grow with interest, got ${debtAfter}`);

    // Alice repays in full.
    const aliceShares = await market.borrowSharesOf(alice.address);
    const approveAmount = (debtAfter * 11n) / 10n + ONE; // headroom for re-accrual on tx
    await (await usdt.mint(alice.address, approveAmount)).wait();
    await (await usdt.connect(alice).approve(marketAddr, approveAmount)).wait();
    await (await market.connect(alice).repay(aliceShares, alice.address)).wait();
    assert.equal((await market.borrowSharesOf(alice.address)).toString(), "0");

    // Bob withdraws fully — should receive > 1000 USDT (accrued interest minus reserve).
    const bobBalBefore = await usdt.balanceOf(bob.address);
    const bobShares = await market.supplySharesOf(bob.address);
    await (await market.connect(bob).withdraw(bobShares, bob.address)).wait();
    const bobBalAfter = await usdt.balanceOf(bob.address);
    assert.ok(
      bobBalAfter - bobBalBefore > 1000n * ONE,
      `Bob should profit from accrued interest, delta=${bobBalAfter - bobBalBefore}`
    );

    // Skim reserves to the insurance fund.
    const fundAddr = await fund.getAddress();
    const fundBalBefore = await usdt.balanceOf(fundAddr);
    await (await market.skimReservesToFund()).wait();
    const fundBalAfter = await usdt.balanceOf(fundAddr);
    assert.ok(
      fundBalAfter > fundBalBefore,
      `Insurance fund should receive reserves, before=${fundBalBefore} after=${fundBalAfter}`
    );
  });

  it("borrow above LLTV reverts", async () => {
    const { alice, bob, rusd, usdt, market } = await deployStack();
    const marketAddr = await market.getAddress();

    await (await rusd.mint(alice.address, 100n * ONE)).wait();
    await (await usdt.mint(bob.address,   1000n * ONE)).wait();

    await (await rusd.connect(alice).approve(marketAddr, 100n * ONE)).wait();
    await (await market.connect(alice).supplyCollateral(100n * ONE, alice.address)).wait();
    await (await usdt.connect(bob).approve(marketAddr, 1000n * ONE)).wait();
    await (await market.connect(bob).supply(1000n * ONE, bob.address)).wait();

    // 100 RUSD * 92% = 92 USDT borrow ceiling. Try 95 — must revert.
    await assert.rejects(market.connect(alice).borrow(95n * ONE, alice.address));
  });

  it("liquidate on healthy position reverts", async () => {
    const { alice, bob, liquidator, rusd, usdt, market } = await deployStack();
    const marketAddr = await market.getAddress();

    await (await rusd.mint(alice.address, 500n * ONE)).wait();
    await (await usdt.mint(bob.address,   1000n * ONE)).wait();
    await (await usdt.mint(liquidator.address, 1000n * ONE)).wait();

    await (await rusd.connect(alice).approve(marketAddr, 500n * ONE)).wait();
    await (await market.connect(alice).supplyCollateral(500n * ONE, alice.address)).wait();
    await (await usdt.connect(bob).approve(marketAddr, 1000n * ONE)).wait();
    await (await market.connect(bob).supply(1000n * ONE, bob.address)).wait();
    await (await market.connect(alice).borrow(100n * ONE, alice.address)).wait();

    await (await usdt.connect(liquidator).approve(marketAddr, 1000n * ONE)).wait();
    await assert.rejects(market.connect(liquidator).liquidate(alice.address, 50n * ONE));
  });
});
