/**
 * Per-chain addresses loader (ADR-010).
 *
 *   - Primary store:    addresses/<chainId>.json
 *   - Legacy fallback:  deployed-addresses.json
 *
 * The loader is dual-write on save: it always writes to the per-chain
 * file AND mirrors to the legacy flat file. That way the dozen+
 * existing scripts that read deployed-addresses.json directly
 * (mint-tokens.js, probe-*.js, setup-custodian.js, sync-addresses.js,
 * verify-wiring.js, deploy-lp-lending*.js, the new multisig/*.js)
 * keep working while we migrate them to {load} / {save} one at a time.
 *
 * The legacy file IS chain-specific too — it implicitly carried the
 * chainId of the most recent deploy. After ADR-010 the per-chain files
 * are the source of truth; the legacy file becomes a "last-deployed
 * snapshot" mirror that's easy to grep for during incident response.
 */
const fs = require("fs");
const path = require("path");

const CONTRACTS_ROOT = path.join(__dirname, "..", "..");

function perChainPath(chainId) {
  return path.join(CONTRACTS_ROOT, "addresses", `${chainId}.json`);
}

function legacyPath() {
  return path.join(CONTRACTS_ROOT, "deployed-addresses.json");
}

/**
 * Load the addresses map for the given chainId. Tries the per-chain
 * file first; falls back to the legacy flat file. Throws if neither
 * exists.
 */
function load(chainId) {
  const pcp = perChainPath(chainId);
  if (fs.existsSync(pcp)) {
    return JSON.parse(fs.readFileSync(pcp, "utf8"));
  }
  const legacy = legacyPath();
  if (fs.existsSync(legacy)) {
    return JSON.parse(fs.readFileSync(legacy, "utf8"));
  }
  throw new Error(
    `No addresses file for chainId ${chainId}. ` +
    `Expected addresses/${chainId}.json (or legacy deployed-addresses.json).`
  );
}

/**
 * Save the addresses map for the given chainId. Dual-writes the
 * per-chain file AND mirrors to the legacy flat file. Pretty-printed.
 */
function save(chainId, addresses) {
  const pcp = perChainPath(chainId);
  const dir = path.dirname(pcp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const serialized = JSON.stringify(addresses, null, 2);
  fs.writeFileSync(pcp, serialized);
  // Legacy mirror — keeps backward-compat with existing scripts that
  // hard-code the flat path. Safe to remove once all consumers
  // migrate to load().
  fs.writeFileSync(legacyPath(), serialized);
}

/**
 * Update a single key in the per-chain file (and mirror) without
 * needing to re-load + re-save manually. Useful for one-off scripts
 * that add a single contract address (e.g., the multisig deploy).
 */
function setOne(chainId, key, value) {
  let addrs = {};
  try { addrs = load(chainId); } catch { /* fresh chain */ }
  addrs[key] = value;
  save(chainId, addrs);
  return addrs;
}

module.exports = { load, save, setOne, perChainPath, legacyPath };
