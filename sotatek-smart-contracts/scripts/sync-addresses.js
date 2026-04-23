#!/usr/bin/env node
/**
 * After `deploy-lp-lending.js` lands and writes fresh addresses into
 * `deployed-addresses.json`, this script patches the two downstream
 * configs that bake those addresses in:
 *
 *   1. `fypherx-frontend/src/lib/defi/contracts/addresses.ts`
 *      → LENDING_ADDRS + LP_ADDRS literals (one row per LP_QUOTES entry).
 *
 *   2. `fypherx-backend-services/k8s/fypherx-chain-config.yaml`
 *      → FYPHERX_LIQUIDITY_MANAGER, FYPHERX_LP_VAULT (legacy alias),
 *        FYPHERX_LENDING_TIMELOCK, FYPHERX_LENDING_ORACLE,
 *        FYPHERX_LENDING_INSURANCE_FUND, FYPHERX_LENDING_IRM,
 *        FYPHERX_LENDING_MARKET_FACTORY, FYPHERX_LENDING_MARKET_RUSD_USDT,
 *        plus per-pair FYPHERX_PAIR_RUSD_<SYM> + FYPHERX_LP_VAULT_RUSD_<SYM>.
 *
 * Both repos are expected to sit next to `fypherx-contracts` at
 * `/Users/shchoi/Documents/Fypher/`. Override via env:
 *   FRONTEND_REPO=/path   BACKEND_REPO=/path   node sync-addresses.js
 *
 * Side-effects only (file edits); no git commits. Commit/push is the
 * caller's responsibility so each repo's CODEOWNERS review kicks in.
 *
 * Per-pair env vars must already exist in the k8s YAML (with empty `""`
 * defaults) so the regex below has something to overwrite. The Stage 4
 * config-only PR that ships those placeholder lines is the precondition;
 * if a key is missing the script fails fast with a precise error.
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

/**
 * Quote symbols paired with RUSD on the LP side. Mirrors
 * `deploy-lp-lending.js` LP_QUOTES + the backend `lp-pairs` config + the
 * frontend `liveLpPools.ts ALL_LP_POOL_CANDIDATES` table.
 */
const LP_QUOTES = ["USDT", "USDC", "FYUSD", "FYP"];

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

/** Width of the property identifier (including the trailing colon) within
 *  the LP_ADDRS block of `addresses.ts`. The block aligns every value at
 *  column 21 (2-space leading indent + 18-char key area + 1 trailing
 *  space), where 18 is the width of the longest key + colon
 *  (`LPVault_RUSD_FYUSD:` = 19 chars; we round up to 20 so the trailing
 *  space exists for the longest key too). */
function lpFieldPad(field) {
  return field.padEnd(20, " ");
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

  // LP_ADDRS block — per-pair Pair_RUSD_<SYM> + LPVault_RUSD_<SYM>.
  // Each slot may currently be either an address literal (USDT post-Stage-3)
  // or a bare `null` (USDC/FYUSD/FYP pre-Stage-4 deploy). The regex covers
  // both so the script is idempotent across re-runs.
  for (const sym of LP_QUOTES) {
    const pairKey   = `Pair_RUSD_${sym}`;
    const vaultKey  = `LPVault_RUSD_${sym}`;
    const pairAddr  = requireAddr(addrs, `PancakeV2Pair_RUSD_${sym}`);
    const vaultAddr = requireAddr(addrs, `FypherLPVault_RUSD_${sym}`);

    src = replaceLine(
      src,
      new RegExp(`${pairKey}:\\s+(null|'0x[a-fA-F0-9]{40}'),`),
      `${lpFieldPad(pairKey + ":")}'${pairAddr}',`,
      `LP_ADDRS.${pairKey}`
    );
    src = replaceLine(
      src,
      new RegExp(`${vaultKey}:\\s+(null|'0x[a-fA-F0-9]{40}'),`),
      `${lpFieldPad(vaultKey + ":")}'${vaultAddr}',`,
      `LP_ADDRS.${vaultKey}`
    );
  }
  src = replaceLine(
    src,
    /LiquidityManager:\s+'0x[a-fA-F0-9]{40}',/,
    `LiquidityManager:   '${addrs.FypherLiquidityManager}',`,
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
  // Legacy single-vault alias — kept in lockstep with the USDT vault for
  // backward compatibility with any service still reading FYPHERX_LP_VAULT.
  setEnv("FYPHERX_LP_VAULT",                   addrs.FypherLPVault_RUSD_USDT);
  setEnv("FYPHERX_LENDING_TIMELOCK",           addrs.FypherTimelock);
  setEnv("FYPHERX_LENDING_ORACLE",             addrs.FypherOracleRouterV2);
  setEnv("FYPHERX_LENDING_INSURANCE_FUND",     addrs.FypherXInsuranceFundV2);
  setEnv("FYPHERX_LENDING_IRM",                addrs.FypherKinkedIRM);
  setEnv("FYPHERX_LENDING_MARKET_FACTORY",     addrs.FypherLendingMarketFactory);
  setEnv("FYPHERX_LENDING_MARKET_RUSD_USDT",   addrs.FypherLendingMarket_RUSD_USDT);

  // Per-pair env vars — the gateway `application.yml lp-pairs` reads from
  // these keys. The k8s file must already contain the placeholder rows
  // (empty `""` defaults are fine) for the regex above to land.
  for (const sym of LP_QUOTES) {
    setEnv(`FYPHERX_PAIR_RUSD_${sym}`,     addrs[`PancakeV2Pair_RUSD_${sym}`]);
    setEnv(`FYPHERX_LP_VAULT_RUSD_${sym}`, addrs[`FypherLPVault_RUSD_${sym}`]);
  }

  fs.writeFileSync(BACKEND_CHAIN_CONFIG, src);
  console.log(`✓ patched ${BACKEND_CHAIN_CONFIG}`);
}

function main() {
  if (!fs.existsSync(ADDR_PATH)) {
    throw new Error(`deployed-addresses.json not found at ${ADDR_PATH}`);
  }
  const addrs = JSON.parse(fs.readFileSync(ADDR_PATH, "utf8"));

  // Validate every key we're about to use. Per-pair keys are added in the
  // loop so the error message names exactly which symbol is missing.
  [
    "FypherTimelock",
    "FypherOracleRouterV2",
    "FypherXInsuranceFundV2",
    "FypherKinkedIRM",
    "FypherLendingMarketFactory",
    "FypherLendingMarket_RUSD_USDT",
    "FypherLiquidityManager",
  ].forEach((k) => requireAddr(addrs, k));
  for (const sym of LP_QUOTES) {
    requireAddr(addrs, `PancakeV2Pair_RUSD_${sym}`);
    requireAddr(addrs, `FypherLPVault_RUSD_${sym}`);
  }

  patchFrontend(addrs);
  patchBackendYaml(addrs);
  console.log("\nAll configs synced. Next: commit + push in each repo.");
}

main();
