/**
 * Verify the OpenZeppelin proxy shells on the GIWA explorer.
 *
 * <p>scripts/verify-giwa.js verifies the IMPLEMENTATION behind each proxy,
 * which is what makes the source readable: Blockscout detects
 * `proxy_type: eip1967` and renders the implementation's code and ABI on the
 * proxy page. That is enough to review the logic, but the proxy address itself
 * still reports `is_verified: false`, and a reviewer checking addresses
 * programmatically sees a false negative on the very contracts that hold the
 * funds.
 *
 * <p>The proxies cannot be verified from this project's build-info because the
 * upgrades plugin deploys them from its OWN precompiled artifacts, not from
 * our sources. But it ships the standard JSON input it compiled them with, at
 * @openzeppelin/upgrades-core/artifacts/build-info-v5.json (solc 0.8.29,
 * optimizer 200 runs), which is exactly what Blockscout's standard-input
 * endpoint wants.
 *
 * <p>Run AFTER verify-giwa.js. Idempotent, and skips anything already verified.
 *
 * Usage:
 *   npx hardhat run scripts/verify-giwa-proxies.js --network giwaSepolia
 */
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const addresses = require("./lib/addresses");

const CHAIN_ID = 91342;
const EXPLORER = "https://sepolia-explorer.giwa.io";
const LICENSE = "mit";
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const SKIP_KEYS = new Set(["_comment", "_explorer", "_rpc"]);

const PROXY_FQN =
  "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy";
const BUILD_INFO = path.join(
  __dirname, "..", "node_modules", "@openzeppelin", "upgrades-core",
  "artifacts", "build-info-v5.json",
);

// The explorer 403s clients that do not look like a browser, so every request
// here carries a UA. Without it a checker reports "unverified" for contracts
// that are perfectly verified — a false negative that is worse than no check.
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const isAddress = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

async function isVerified(address) {
  try {
    const res = await fetch(`${EXPLORER}/api/v2/addresses/${address}`, {
      headers: { "User-Agent": UA },
    });
    if (!res.ok) return false;
    return Boolean((await res.json()).is_verified);
  } catch {
    return false;
  }
}

async function submit(address, input, solcLongVersion) {
  const form = new FormData();
  form.append("compiler_version", `v${solcLongVersion}`);
  form.append("license_type", LICENSE);
  form.append("contract_name", PROXY_FQN);
  form.append("autodetect_constructor_args", "true");
  form.append(
    "files[0]",
    new Blob([JSON.stringify(input)], { type: "application/json" }),
    "standard-input.json",
  );
  const res = await fetch(
    `${EXPLORER}/api/v2/smart-contracts/${address}/verification/via/standard-input`,
    { method: "POST", body: form, headers: { "User-Agent": UA } },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
}

async function waitVerified(address, tries = 15, delayMs = 3000) {
  for (let i = 0; i < tries; i++) {
    if (await isVerified(address)) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== CHAIN_ID) {
    console.error(`Requires chainId ${CHAIN_ID}, got ${chainId}.`);
    process.exit(1);
  }
  if (!fs.existsSync(BUILD_INFO)) {
    console.error(`Missing ${BUILD_INFO}. Run npm install first.`);
    process.exit(1);
  }
  const bi = JSON.parse(fs.readFileSync(BUILD_INFO, "utf8"));

  const registry = addresses.load(chainId);
  const proxies = [];
  for (const [key, address] of Object.entries(registry)) {
    if (SKIP_KEYS.has(key) || !isAddress(address)) continue;
    const raw = await ethers.provider.getStorage(address, IMPL_SLOT);
    const impl = ethers.getAddress("0x" + raw.slice(-40));
    if (impl !== ethers.ZeroAddress) proxies.push({ key, address });
  }

  console.log(`\n${proxies.length} proxy shells to verify (solc ${bi.solcLongVersion})\n`);

  const pending = [];
  for (const p of proxies) {
    process.stdout.write(`  ${p.key.padEnd(26)} ${p.address} ... `);
    if (await isVerified(p.address)) { console.log("already verified"); continue; }
    try {
      await submit(p.address, bi.input, bi.solcLongVersion);
      console.log("submitted");
      pending.push(p);
    } catch (e) {
      console.log(`FAILED — ${e.message}`);
      pending.push(p);
    }
  }

  if (pending.length) console.log(`\nConfirming ${pending.length} with the explorer...\n`);
  const failed = [];
  for (const p of pending) {
    process.stdout.write(`  ${p.key.padEnd(26)} `);
    if (await waitVerified(p.address)) console.log("verified");
    else { console.log("STILL UNVERIFIED"); failed.push(p); }
  }

  console.log(`\n  proxies verified: ${proxies.length - failed.length}/${proxies.length}\n`);
  // Not a hard failure: the implementations are already verified, so the source
  // is reviewable either way. This only closes the cosmetic gap on the proxy
  // address itself.
  if (failed.length) {
    console.log("  Implementations remain verified, so source is still readable");
    console.log("  on each proxy page via Blockscout's eip1967 detection.\n");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
