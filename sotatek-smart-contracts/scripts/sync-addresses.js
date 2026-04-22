#!/usr/bin/env node
/**
 * After `deploy-lp-lending.js` lands and writes fresh addresses into
 * `deployed-addresses.json`, this script patches the two downstream
 * configs that bake those addresses in:
 *
 *   1. `fypherx-frontend/src/lib/defi/contracts/addresses.ts`
 *      → LENDING_ADDRS + LP_ADDRS literals
 *
 *   2. `fypherx-backend-services/k8s/fypherx-chain-config.yaml`
 *      → FYPHERX_LIQUIDITY_MANAGER, FYPHERX_LP_VAULT,
 *        FYPHERX_LENDING_TIMELOCK, FYPHERX_LENDING_ORACLE,
 *        FYPHERX_LENDING_INSURANCE_FUND, FYPHERX_LENDING_IRM,
 *        FYPHERX_LENDING_MARKET_FACTORY,
 *        FYPHERX_LENDING_MARKET_RUSD_USDT
 *
 * Both repos are expected to sit next to `fypherx-contracts` at
 * `/Users/shchoi/Documents/Fypher/`. Override via env:
 *   FRONTEND_REPO=/path   BACKEND_REPO=/path   node sync-addresses.js
 *
 * Side-effects only (file edits); no git commits. Commit/push is the
 * caller's responsibility so each repo's CODEOWNERS review kicks in.
 */

const fs = require("fs");
const path = require("path");

const ADDR_PATH = path.join(__dirname, "..", "deployed-addresses.json");
const FRONTEND_REPO = process.env.FRONTEND_REPO
  || "/Users/shchoi/Documents/Fypher/fypherx-frontend";
const BACKEND_REPO = process.env.BACKEND_REPO
  || "/Users/shchoi/Documents/Fypher/fypherx-backend-services";

const FRONTEND_ADDRS = path.join(
  FRONTEND_REPO, "src/lib/defi/contracts/addresses.ts"
);
const BACKEND_CHAIN_CONFIG = path.join(
  BACKEND_REPO, "k8s/fypherx-chain-config.yaml"
);

function requireAddr(map, key) {
  const v = map[key];
  if (!v || typeof v !== "string" || !v.startsWith("0x") || v.length !== 42) {
    throw new Error(`deployed-addresses.json is missing a valid ${key}: got ${JSON.stringify(v)}`);
  }
  return v;
}

function replaceLine(content, pattern, replacement, what) {
  if (!pattern.test(content)) {
    throw new Error(`pattern not found while updating ${what}: ${pattern}`);
  }
  return content.replace(pattern, replacement);
}

function patchFrontend(addrs) {
  let src = fs.readFileSync(FRONTEND_ADDRS, "utf8");

  // LENDING_ADDRS block
  src = replaceLine(
    src,
    /Timelock:\s+'0x[a-fA-F0-9]{40}',/,
    `Timelock:         '${addrs.FypherTimelock}',`,
    "LENDING_ADDRS.Timelock"
  );
  src = replaceLine(
    src,
    /OracleRouter:\s+'0x[a-fA-F0-9]{40}',/,
    `OracleRouter:     '${addrs.FypherOracleRouterV2}',`,
    "LENDING_ADDRS.OracleRouter"
  );
  src = replaceLine(
    src,
    /InsuranceFund:\s+'0x[a-fA-F0-9]{40}',/,
    `InsuranceFund:    '${addrs.FypherXInsuranceFundV2}',`,
    "LENDING_ADDRS.InsuranceFund"
  );
  src = replaceLine(
    src,
    /IRM:\s+'0x[a-fA-F0-9]{40}',/,
    `IRM:              '${addrs.FypherKinkedIRM}',`,
    "LENDING_ADDRS.IRM"
  );
  src = replaceLine(
    src,
    /MarketFactory:\s+'0x[a-fA-F0-9]{40}',/,
    `MarketFactory:    '${addrs.FypherLendingMarketFactory}',`,
    "LENDING_ADDRS.MarketFactory"
  );
  // Market_RUSD_USDT may have been `null` literal or already an address.
  src = replaceLine(
    src,
    /Market_RUSD_USDT:\s+(null|'0x[a-fA-F0-9]{40}'),/,
    `Market_RUSD_USDT: '${addrs.FypherLendingMarket_RUSD_USDT}',`,
    "LENDING_ADDRS.Market_RUSD_USDT"
  );

  // LP_ADDRS block
  src = replaceLine(
    src,
    /Pair_RUSD_USDT:\s+'0x[a-fA-F0-9]{40}',/,
    `Pair_RUSD_USDT:    '${addrs.PancakeV2Pair_RUSD_USDT}',`,
    "LP_ADDRS.Pair_RUSD_USDT"
  );
  src = replaceLine(
    src,
    /LPVault_RUSD_USDT:\s+'0x[a-fA-F0-9]{40}',/,
    `LPVault_RUSD_USDT: '${addrs.FypherLPVault_RUSD_USDT}',`,
    "LP_ADDRS.LPVault_RUSD_USDT"
  );
  src = replaceLine(
    src,
    /LiquidityManager:\s+'0x[a-fA-F0-9]{40}',/,
    `LiquidityManager:  '${addrs.FypherLiquidityManager}',`,
    "LP_ADDRS.LiquidityManager"
  );

  fs.writeFileSync(FRONTEND_ADDRS, src);
  console.log(`✓ patched ${FRONTEND_ADDRS}`);
}

function patchBackendYaml(addrs) {
  let src = fs.readFileSync(BACKEND_CHAIN_CONFIG, "utf8");

  const setEnv = (key, value) => {
    const re = new RegExp(`(^\\s*${key}:\\s*")[^"]*(".*)$`, "m");
    if (!re.test(src)) throw new Error(`k8s config missing ${key}`);
    src = src.replace(re, `$1${value}$2`);
  };

  setEnv("FYPHERX_LIQUIDITY_MANAGER",          addrs.FypherLiquidityManager);
  setEnv("FYPHERX_LP_VAULT",                   addrs.FypherLPVault_RUSD_USDT);
  setEnv("FYPHERX_LENDING_TIMELOCK",           addrs.FypherTimelock);
  setEnv("FYPHERX_LENDING_ORACLE",             addrs.FypherOracleRouterV2);
  setEnv("FYPHERX_LENDING_INSURANCE_FUND",     addrs.FypherXInsuranceFundV2);
  setEnv("FYPHERX_LENDING_IRM",                addrs.FypherKinkedIRM);
  setEnv("FYPHERX_LENDING_MARKET_FACTORY",     addrs.FypherLendingMarketFactory);
  setEnv("FYPHERX_LENDING_MARKET_RUSD_USDT",   addrs.FypherLendingMarket_RUSD_USDT);

  fs.writeFileSync(BACKEND_CHAIN_CONFIG, src);
  console.log(`✓ patched ${BACKEND_CHAIN_CONFIG}`);
}

function main() {
  if (!fs.existsSync(ADDR_PATH)) {
    throw new Error(`deployed-addresses.json not found at ${ADDR_PATH}`);
  }
  const addrs = JSON.parse(fs.readFileSync(ADDR_PATH, "utf8"));

  // Validate every key we're about to use.
  [
    "FypherTimelock",
    "FypherOracleRouterV2",
    "FypherXInsuranceFundV2",
    "FypherKinkedIRM",
    "FypherLendingMarketFactory",
    "FypherLendingMarket_RUSD_USDT",
    "PancakeV2Pair_RUSD_USDT",
    "FypherLPVault_RUSD_USDT",
    "FypherLiquidityManager",
  ].forEach((k) => requireAddr(addrs, k));

  patchFrontend(addrs);
  patchBackendYaml(addrs);
  console.log("\nAll configs synced. Next: commit + push in each repo.");
}

main();
