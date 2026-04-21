/**
 * Local smoke for FypherLending — runs against the hardhat in-memory chain.
 *
 * Exercises the core happy-path:
 *   1. Alice supplies collateral (RUSD), Bob supplies liquidity (USDT).
 *   2. Alice borrows USDT up to 80% of her LLTV budget.
 *   3. Time jumps 1 year. Interest accrues.
 *   4. Alice repays in full.
 *   5. Bob withdraws liquidity; totalSupplyAssets should have grown by accrued interest
 *      minus the reserve share.
 *
 * Not a full test suite — meant to catch obvious arithmetic regressions before we
 * touch the testnet. Run with `npx hardhat run scripts/lending-smoke.js`.
 */

const { ethers } = require("hardhat");

const WAD = 10n ** 18n;
const ORACLE_PRICE_SCALE = 10n ** 36n;
const ONE = 10n ** 18n;

async function main() {
  const [deployer, alice, bob, liquidator] = await ethers.getSigners();

  // Loan + collateral mocks (ERC20Mock from sotatek set). We deploy fresh ones via OZ ERC20.
  const MockERC20 = await ethers.getContractFactory("contracts/mocks/MockERC20.sol:MockERC20");
  const rusd = await MockERC20.deploy("RUSD", "RUSD", 18);
  const usdt = await MockERC20.deploy("USDT", "USDT", 18);
  await rusd.waitForDeployment();
  await usdt.waitForDeployment();

  await (await rusd.mint(alice.address, 1000n * ONE)).wait();
  await (await usdt.mint(bob.address, 1000n * ONE)).wait();
  await (await usdt.mint(liquidator.address, 1000n * ONE)).wait();

  // Oracle + IRM + fund
  const ConstantAdapter = await ethers.getContractFactory("ConstantOracleAdapter");
  const adapter = await ConstantAdapter.deploy(ORACLE_PRICE_SCALE);
  await adapter.waitForDeployment();

  const KinkedIRM = await ethers.getContractFactory("KinkedIRM");
  const irm = await KinkedIRM.deploy((4n * WAD) / 100n, (80n * WAD) / 100n, (10n * WAD) / 100n, (250n * WAD) / 100n);
  await irm.waitForDeployment();

  const InsuranceFund = await ethers.getContractFactory("InsuranceFundV2");
  const fund = await InsuranceFund.deploy(deployer.address);
  await fund.waitForDeployment();

  const Factory = await ethers.getContractFactory("FypherLendingMarketFactory");
  const factory = await Factory.deploy(deployer.address, await fund.getAddress());
  await factory.waitForDeployment();

  await (await fund.setFactory(await factory.getAddress())).wait();

  // Market
  const init = {
    loanToken: await usdt.getAddress(),
    collateralToken: await rusd.getAddress(),
    oracle: await adapter.getAddress(),
    irm: await irm.getAddress(),
    lltvBps: 9000,
    liquidationBonusBps: 500,
    reserveFactorBps: 1000,
    supplyCap: 0,
    borrowCap: 0,
    timelock: deployer.address,   // smoke: deployer stands in for Timelock
    insuranceFund: await fund.getAddress(),
  };
  await (await factory.createMarket(init)).wait();
  const marketAddress = await factory.markets(0);
  const market = await ethers.getContractAt("FypherLendingMarket", marketAddress);
  console.log("market:", marketAddress);

  // ── Happy path ──
  await (await rusd.connect(alice).approve(marketAddress, 500n * ONE)).wait();
  await (await market.connect(alice).supplyCollateral(500n * ONE, alice.address)).wait();
  console.log("alice collateral:", (await market.collateralOf(alice.address)).toString());

  await (await usdt.connect(bob).approve(marketAddress, 1000n * ONE)).wait();
  await (await market.connect(bob).supply(1000n * ONE, bob.address)).wait();
  console.log("bob supplyAssets:", (await market.supplyAssetsOf(bob.address)).toString());

  // Alice borrows 400 USDT (below 500 * 90% = 450 LLTV budget)
  await (await market.connect(alice).borrow(400n * ONE, alice.address)).wait();
  console.log("alice debt:", (await market.debtAssetsOf(alice.address)).toString());
  console.log("alice HF:  ", (await market.healthFactor(alice.address)).toString());

  // Time jump 1 year
  await ethers.provider.send("evm_increaseTime", [365 * 86400]);
  await ethers.provider.send("evm_mine", []);

  // Trigger accrue via a 1-wei supply (this path calls _accrueInterest unlike supplyCollateral).
  await (await usdt.mint(deployer.address, 1)).wait();
  await (await usdt.approve(marketAddress, 1)).wait();
  await (await market.supply(1, deployer.address)).wait();
  console.log("\nafter 1yr:");
  console.log("  totalBorrowAssets:", (await market.totalBorrowAssets()).toString());
  console.log("  totalSupplyAssets:", (await market.totalSupplyAssets()).toString());
  console.log("  alice debt:",        (await market.debtAssetsOf(alice.address)).toString());
  console.log("  bob supplyAssets:",  (await market.supplyAssetsOf(bob.address)).toString());
  console.log("  reserve (assets):",  (await market.accumulatedReserve()).toString());

  // Alice repays everything — approve generously since repay() will re-accrue
  // between approve and the internal transferFrom.
  const aliceShares = await market.borrowSharesOf(alice.address);
  const aliceDebt = await market.debtAssetsOf(alice.address);
  const approveAmount = (aliceDebt * 11n) / 10n + ONE;
  await (await usdt.mint(alice.address, approveAmount)).wait();
  await (await usdt.connect(alice).approve(marketAddress, approveAmount)).wait();
  await (await market.connect(alice).repay(aliceShares, alice.address)).wait();
  console.log("\nafter repay:");
  console.log("  alice borrowShares:", (await market.borrowSharesOf(alice.address)).toString());
  console.log("  totalBorrowAssets: ", (await market.totalBorrowAssets()).toString());

  // Bob withdraws fully
  const bobShares = await market.supplySharesOf(bob.address);
  await (await market.connect(bob).withdraw(bobShares, bob.address)).wait();
  console.log("  bob USDT after withdraw:", (await usdt.balanceOf(bob.address)).toString());

  // Skim reserves
  const skimTx = await market.skimReservesToFund();
  await skimTx.wait();
  console.log("  fund USDT after skim:   ", (await usdt.balanceOf(await fund.getAddress())).toString());

  console.log("\n✓ smoke path ok");
}

main().catch((e) => { console.error(e); process.exit(1); });
