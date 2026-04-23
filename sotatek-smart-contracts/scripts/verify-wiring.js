/**
 * Post-deploy verification — reads the just-deployed contracts and asserts
 * that every ownership handoff + every parameter we meant to set landed as
 * intended. No writes, so this is safe to re-run after merges.
 *
 * Stage 4 update: walks ALL FypherLPVaults registered with the manager
 * (one per LP_QUOTES symbol), not just the legacy RUSD/USDT slot. The
 * manager's own `vaultCount` + `vaults(i)` view is the source of truth so
 * a vault that's deployed but never registered surfaces as a missing
 * `mgr.vaults(i)` rather than a silent skip.
 */
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const A = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf8"));

/** Mirror of LP_QUOTES in deploy-lp-lending.js. Keep ordered. */
const LP_QUOTES = ["USDT", "USDC", "FYUSD", "FYP"];

async function main() {
  const p = ethers.provider;

  const market = new ethers.Contract(A.FypherLendingMarket_RUSD_USDT, [
    "function loanToken() view returns (address)",
    "function collateralToken() view returns (address)",
    "function oracle() view returns (address)",
    "function irm() view returns (address)",
    "function timelock() view returns (address)",
    "function insuranceFund() view returns (address)",
    "function lltvBps() view returns (uint16)",
    "function liquidationBonusBps() view returns (uint16)",
    "function reserveFactorBps() view returns (uint16)",
    "function paused() view returns (bool)",
    "function totalSupplyAssets() view returns (uint256)",
    "function totalBorrowAssets() view returns (uint256)",
  ], p);

  const factory = new ethers.Contract(A.FypherLendingMarketFactory, [
    "function owner() view returns (address)",
    "function insuranceFund() view returns (address)",
    "function markets(uint256) view returns (address)",
  ], p);

  const fund = new ethers.Contract(A.FypherXInsuranceFundV2, [
    "function owner() view returns (address)",
    "function factory() view returns (address)",
    "function allowedMarket(address) view returns (bool)",
  ], p);

  const router = new ethers.Contract(A.FypherOracleRouterV2, [
    "function owner() view returns (address)",
    "function getAdapter(address,address) view returns (address)",
  ], p);

  const mgr = new ethers.Contract(A.FypherLiquidityManager, [
    "function owner() view returns (address)",
    "function vaults(uint256) view returns (address)",
    "function vaultCount() view returns (uint256)",
  ], p);

  const vaultAbi = [
    "function owner() view returns (address)",
    "function rusd() view returns (address)",
    "function quoteToken() view returns (address)",
    "function pair() view returns (address)",
    "function router() view returns (address)",
    "function depositsPaused() view returns (bool)",
  ];

  const checks = [];
  const check = (label, got, want) => {
    const ok = String(got).toLowerCase() === String(want).toLowerCase();
    checks.push([ok ? "✓" : "✗", label, ok ? got : `got ${got}, want ${want}`]);
  };

  // Market wiring
  check("market.loanToken",            await market.loanToken(),            A.USDT);
  check("market.collateralToken",      await market.collateralToken(),      A.RUSD);
  check("market.oracle",               await market.oracle(),               A.ConstantAdapter_RUSD_USDT);
  check("market.irm",                  await market.irm(),                  A.FypherKinkedIRM);
  check("market.timelock",             await market.timelock(),             A.FypherTimelock);
  check("market.insuranceFund",        await market.insuranceFund(),        A.FypherXInsuranceFundV2);
  check("market.lltvBps",              await market.lltvBps(),              9000);
  check("market.liquidationBonusBps",  await market.liquidationBonusBps(),  500);
  check("market.reserveFactorBps",     await market.reserveFactorBps(),     1000);
  check("market.paused",               await market.paused(),               false);
  check("market.totalSupplyAssets",    await market.totalSupplyAssets(),    0n);
  check("market.totalBorrowAssets",    await market.totalBorrowAssets(),    0n);

  // Ownership handoffs
  check("factory.owner → Timelock",    await factory.owner(),               A.FypherTimelock);
  check("factory.insuranceFund",       await factory.insuranceFund(),       A.FypherXInsuranceFundV2);
  check("factory.markets(0)",          await factory.markets(0),            A.FypherLendingMarket_RUSD_USDT);
  check("fund.owner → Timelock",       await fund.owner(),                  A.FypherTimelock);
  check("fund.factory",                await fund.factory(),                A.FypherLendingMarketFactory);
  check("fund.allowedMarket(market)",  await fund.allowedMarket(A.FypherLendingMarket_RUSD_USDT), true);
  check("router.owner → Timelock",     await router.owner(),                A.FypherTimelock);
  check("router.getAdapter(RUSD,USDT)",await router.getAdapter(A.RUSD, A.USDT), A.ConstantAdapter_RUSD_USDT);
  check("mgr.owner → Timelock",        await mgr.owner(),                   A.FypherTimelock);
  check("mgr.vaultCount",              await mgr.vaultCount(),              BigInt(LP_QUOTES.length));

  // Per-pair vault wiring. Loop matches the deploy-lp-lending.js order so
  // `mgr.vaults(i)` lines up with LP_QUOTES[i]. If a quote was skipped on
  // deploy (e.g. partial run), the address-map lookup throws and we fail
  // loudly rather than checking against `undefined`.
  for (let i = 0; i < LP_QUOTES.length; i++) {
    const sym = LP_QUOTES[i];
    const expectedVault = A[`FypherLPVault_RUSD_${sym}`];
    const expectedPair  = A[`PancakeV2Pair_RUSD_${sym}`];
    const expectedQuote = A[sym];
    if (!expectedVault) throw new Error(`address map missing FypherLPVault_RUSD_${sym}`);
    if (!expectedPair)  throw new Error(`address map missing PancakeV2Pair_RUSD_${sym}`);
    if (!expectedQuote) throw new Error(`address map missing quote token ${sym}`);

    check(`mgr.vaults(${i})  RUSD/${sym}`, await mgr.vaults(i), expectedVault);

    const v = new ethers.Contract(expectedVault, vaultAbi, p);
    check(`vault[${sym}].owner → Manager`,  await v.owner(),          A.FypherLiquidityManager);
    check(`vault[${sym}].rusd`,             await v.rusd(),           A.RUSD);
    check(`vault[${sym}].quoteToken`,       await v.quoteToken(),     expectedQuote);
    check(`vault[${sym}].pair`,             await v.pair(),           expectedPair);
    check(`vault[${sym}].router`,           await v.router(),         A.PancakeV2Router);
    check(`vault[${sym}].depositsPaused`,   await v.depositsPaused(), false);
  }

  for (const [s, label, detail] of checks) {
    console.log(`${s} ${label.padEnd(36)} ${s === "✓" ? detail : "← " + detail}`);
  }
  const failed = checks.filter(([s]) => s === "✗").length;
  console.log(`\n${failed === 0 ? "ALL OK" : `${failed} FAILED`}`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
