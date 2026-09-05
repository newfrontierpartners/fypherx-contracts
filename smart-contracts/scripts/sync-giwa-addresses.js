#!/usr/bin/env node
/**
 * Sync deployed GIWA addresses into the frontend contract registry.
 *
 * Rewrites the `// <giwa-addresses>` block in
 *   fypherx-frontend/src/lib/defi/contracts/addresses.ts
 * from
 *   fypherx-contracts/smart-contracts/addresses/91342.json
 *
 * <p>Why a script and not a copy-paste: the frontend refuses to build while
 * the registry is at the zero-address scaffold (scripts/assert-giwa-addresses.mjs),
 * so this runs on every deploy — and a hand-edited address that is subtly
 * wrong is far more dangerous than one that is obviously missing. Generating
 * it removes the transcription step entirely.
 *
 * Plain node — no hardhat runtime needed.
 *
 * Usage:
 *   node scripts/sync-giwa-addresses.js [path/to/fypherx-frontend]
 */
const fs = require("fs");
const path = require("path");

const CHAIN_ID = 91342;
const CONTRACTS_ROOT = path.join(__dirname, "..");

/**
 * frontend registry key -> key in addresses/91342.json.
 *
 * Explicit rather than derived: the two sides genuinely disagree on some
 * names (the frontend's `FyusdYieldVault` is the ERC-4626 vault, recorded
 * on-chain under `FyusdYieldVaultErc4626`), and a mapping that guessed would
 * silently point the vault UI at the legacy pre-ERC4626 contract.
 */
const KEY_MAP = {
  SettingManagement: "SettingManagement",
  FYUSD: "FYUSD",
  FyusdTeller: "FyusdTeller",
  RUSD: "RUSD",
  FYP: "FYP",
  USDT: "USDT",
  USDC: "USDC",
  FypherMinting: "FypherMinting",
  FypherBurnQueue: "FypherBurnQueue",
  FyusdEpochSettlement: "FyusdEpochSettlement",
  FypherStakingHub: "FypherStakingHub",
  FyusdYieldVault: "FyusdYieldVaultErc4626",
  RusdYieldVault: "RUSDYieldVault",
  ReservePool: "ReservePool",
  StakedRUSD: "StakedRUSD",
  stAUSD: "stAUSD",
  StakedFYP: "StakedFYP",
};

/** Keys the frontend expects but GIWA has no equivalent for. */
const PINNED = {
  // Model A has no on-chain ERC-4626 Earn vault; the yield vault above is it.
  FyusdEarnVault: "null",
  // Redemption is the teller, not the BitGo-mirrored epoch contract.
  FyusdEpochRedemption: "null",
  // OP-Stack predeploy — same address on every OP chain.
  WETH: "'0x4200000000000000000000000000000000000006'",
  // Never deployed on GIWA; alpha mode gates their UI off.
  iRUSD: "ZERO",
  StakedIRUSD: "ZERO",
  PerpsClearinghouse: "null",
};

function resolveFrontendPath(argPath) {
  const candidates = [
    argPath,
    path.join(CONTRACTS_ROOT, "..", "..", "fypherx-frontend"),
  ].filter(Boolean);
  for (const c of candidates) {
    const file = path.join(c, "src/lib/defi/contracts/addresses.ts");
    if (fs.existsSync(file)) return file;
  }
  throw new Error(
    "Could not find fypherx-frontend/src/lib/defi/contracts/addresses.ts. " +
      "Pass the frontend repo path as the first argument.",
  );
}

function main() {
  const addrFile = path.join(CONTRACTS_ROOT, "addresses", `${CHAIN_ID}.json`);
  if (!fs.existsSync(addrFile)) {
    console.error(`No addresses/${CHAIN_ID}.json — deploy to GIWA first.`);
    process.exit(1);
  }
  const deployed = JSON.parse(fs.readFileSync(addrFile, "utf8"));

  const lines = [];
  const missing = [];
  const width = Math.max(
    ...[...Object.keys(KEY_MAP), ...Object.keys(PINNED)].map((k) => k.length),
  );

  for (const [feKey, onchainKey] of Object.entries(KEY_MAP)) {
    const value = deployed[onchainKey];
    if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
      missing.push(`${feKey} (addresses/${CHAIN_ID}.json#${onchainKey})`);
      lines.push(`  ${(feKey + ':').padEnd(width + 1)} ZERO,`);
      continue;
    }
    lines.push(`  ${(feKey + ':').padEnd(width + 1)} '${value}',`);
  }
  for (const [feKey, literal] of Object.entries(PINNED)) {
    lines.push(`  ${(feKey + ':').padEnd(width + 1)} ${literal},`);
  }

  const target = resolveFrontendPath(process.argv[2]);
  const source = fs.readFileSync(target, "utf8");
  const marker = /(\/\/ <giwa-addresses>\nconst GIWA_CONTRACTS: AddressMap = \{\n)[\s\S]*?(\n\};\n\/\/ <\/giwa-addresses>)/;
  if (!marker.test(source)) {
    console.error(
      "Could not find the <giwa-addresses> block in the frontend registry. " +
        "Did the marker comments or the const signature change?",
    );
    process.exit(1);
  }
  fs.writeFileSync(target, source.replace(marker, `$1${lines.join("\n")}$2`));

  console.log(`Synced ${Object.keys(KEY_MAP).length} GIWA addresses ->`);
  console.log(`  ${target}`);
  if (missing.length > 0) {
    console.log("");
    console.log("  Still unset (written as ZERO):");
    for (const m of missing) console.log(`    - ${m}`);
    console.log("");
    console.log("  The frontend build will refuse to ship while FYUSD or");
    console.log("  FyusdTeller are among these. Finish the deploy runbook.");
  }
}

main();
