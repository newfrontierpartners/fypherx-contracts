/**
 * Post-deploy verification — reads the just-deployed contracts and asserts
 * that every ownership handoff + every parameter we meant to set landed as
 * intended. No writes, so this is safe to re-run after merges.
 */
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const A = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf8"));

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

  const vault = new ethers.Contract(A.FypherLPVault_RUSD_USDT, [
    "function owner() view returns (address)",
    "function rusd() view returns (address)",
    "function quoteToken() view returns (address)",
    "function pair() view returns (address)",
    "function router() view returns (address)",
    "function depositsPaused() view returns (bool)",
  ], p);

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
  check("mgr.vaults(0)",               await mgr.vaults(0),                 A.FypherLPVault_RUSD_USDT);
  check("mgr.vaultCount",              await mgr.vaultCount(),              1n);
  check("vault.owner → Manager",       await vault.owner(),                 A.FypherLiquidityManager);
  check("vault.rusd",                  await vault.rusd(),                  A.RUSD);
  check("vault.quoteToken",            await vault.quoteToken(),            A.USDT);
  check("vault.pair",                  await vault.pair(),                  A.PancakeV2Pair_RUSD_USDT);
  check("vault.router",                await vault.router(),                A.PancakeV2Router);
  check("vault.depositsPaused",        await vault.depositsPaused(),        false);

  for (const [s, label, detail] of checks) {
    console.log(`${s} ${label.padEnd(32)} ${s === "✓" ? detail : "← " + detail}`);
  }
  const failed = checks.filter(([s]) => s === "✗").length;
  console.log(`\n${failed === 0 ? "ALL OK" : `${failed} FAILED`}`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
