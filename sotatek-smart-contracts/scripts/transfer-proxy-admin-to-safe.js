/**
 * transfer-proxy-admin-to-safe.js — hand the OZ ProxyAdmin (upgrade
 * authority) of every upgradeable proxy to the Operator Safe, so the temp
 * deployer EOA retains NO upgrade control.
 *
 * Why this is needed
 * ──────────────────
 * grant-admin-to-safe.js / accept-admin-from-safe.js move the *application*
 * admin role (SettingManagement._admin, read by every onlyAdmin modifier).
 * They do NOT touch the *upgrade* authority. With OZ v5 +
 * hardhat-upgrades v3, every TransparentUpgradeableProxy is paired with its
 * own ProxyAdmin contract, and that ProxyAdmin is Ownable — owned by the
 * deployer EOA that ran deployProxy. Until its ownership is transferred, the
 * deployer can still upgrade the proxy implementation (i.e. swap the logic
 * out from under the Safe). That single residual authority would make the
 * whole multisig migration moot, so we move it here.
 *
 * What it does
 * ────────────
 * For each upgradeable proxy:
 *   1. adminAddr = upgrades.erc1967.getAdminAddress(proxyAddr)
 *      → the proxy's dedicated ProxyAdmin contract.
 *   2. Treat the ProxyAdmin as Ownable: read owner().
 *   3. If owner == Safe already → skip (idempotent).
 *      If owner == deployer    → transferOwnership(Safe).
 *      Otherwise (neither)     → ABORT with a clear error (never blindly
 *                                send; an unexpected owner means the state
 *                                isn't what we think it is).
 *
 * NOTE: two proxies can legitimately share ONE ProxyAdmin (hardhat-upgrades
 * reuses a network's ProxyAdmin in some flows). The script de-duplicates by
 * ProxyAdmin address so it only transfers each once.
 *
 * Which proxies
 * ─────────────
 * Discovered from addresses/<chainId>.json: the upgradeable ones are
 * SettingManagement, FypherCircuitBreaker, and any key == "FyusdEarnVault"
 * or starting with "FyusdEarnVault" (the prod set has two — USDC + USDT).
 * The single-key registry may only retain ONE FyusdEarnVault address, so
 * pass the second vault's proxy via PROXY_ADDRESSES (comma-separated).
 * ReservePool + EarnLockRegistry are NOT proxies and are skipped (the lock
 * registry's owner is moved by transfer-lock-registry-owner.js).
 *
 * Required env:
 *   PRIVATE_KEY             deployer EOA (current ProxyAdmin owner).
 *   OPERATOR_SAFE_ADDRESS   the Operator Safe (new ProxyAdmin owner).
 * Optional env:
 *   PROXY_ADDRESSES         extra proxy addresses (comma-separated) to
 *                           include beyond what the registry lists — e.g.
 *                           the second (USDT) FyusdEarnVault proxy.
 *
 * ⚠ IRREVERSIBLE: once the Safe owns a ProxyAdmin, only the Safe can
 *   upgrade that proxy or transfer the ProxyAdmin onward. Run AFTER the
 *   SettingManagement admin transfer (D-1/D-2) is settled.
 *
 * Usage:
 *   OPERATOR_SAFE_ADDRESS=0x<safe> \
 *     npx hardhat run scripts/transfer-proxy-admin-to-safe.js --network mainnet
 *   # add the second vault proxy if the registry only kept one:
 *   OPERATOR_SAFE_ADDRESS=0x<safe> PROXY_ADDRESSES=0x<usdt vault proxy> \
 *     npx hardhat run scripts/transfer-proxy-admin-to-safe.js --network mainnet
 */
const { ethers, upgrades } = require("hardhat");
const addresses = require("./lib/addresses");

// ProxyAdmin is Ownable (OZ v5): owner() + transferOwnership(address).
const OWNABLE_ABI = [
  "function owner() view returns (address)",
  "function transferOwnership(address newOwner)",
];

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No signer — is PRIVATE_KEY set for this network?");

  const safe = process.env.OPERATOR_SAFE_ADDRESS;
  if (!safe || !ethers.isAddress(safe)) {
    throw new Error(`OPERATOR_SAFE_ADDRESS missing/invalid — got "${safe}".`);
  }
  if (safe.toLowerCase() === deployer.address.toLowerCase()) {
    throw new Error("OPERATOR_SAFE_ADDRESS == deployer; that would be a no-op transfer.");
  }

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Transfer ProxyAdmin (upgrade authority) → Operator Safe");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`Chain id:   ${chainId}`);
  console.log(`Deployer:   ${deployer.address}`);
  console.log(`Safe:       ${safe}`);
  console.log("");

  const addrs = addresses.load(chainId);

  // ── Collect proxy addresses: registry keys + PROXY_ADDRESSES env ──
  const proxies = []; // { name, proxyAddr }
  const seenProxy = new Set();
  const addProxy = (name, proxyAddr) => {
    if (!proxyAddr || !ethers.isAddress(proxyAddr)) return;
    const key = proxyAddr.toLowerCase();
    if (seenProxy.has(key)) return;
    seenProxy.add(key);
    proxies.push({ name, proxyAddr: ethers.getAddress(proxyAddr) });
  };

  for (const [name, value] of Object.entries(addrs)) {
    if (typeof value !== "string") continue; // skip the nested `lending` object etc.
    if (
      name === "SettingManagement" ||
      name === "FypherCircuitBreaker" ||
      name === "FyusdEarnVault" ||
      name.startsWith("FyusdEarnVault")
    ) {
      addProxy(name, value);
    }
  }

  if (process.env.PROXY_ADDRESSES) {
    for (const raw of process.env.PROXY_ADDRESSES.split(",")) {
      const a = raw.trim();
      if (!a) continue;
      if (!ethers.isAddress(a)) throw new Error(`PROXY_ADDRESSES contains an invalid address: "${a}"`);
      addProxy("PROXY_ADDRESSES(env)", a);
    }
  }

  if (proxies.length === 0) {
    throw new Error(
      `No upgradeable proxies found in addresses/${chainId}.json (SettingManagement / ` +
      `FypherCircuitBreaker / FyusdEarnVault*) and PROXY_ADDRESSES is empty. Nothing to do.`,
    );
  }

  console.log(`Found ${proxies.length} proxy(ies) to process:`);
  for (const p of proxies) console.log(`  - ${p.name}: ${p.proxyAddr}`);
  console.log("");

  // ── Resolve each proxy → its ProxyAdmin, then transfer ownership ──
  // De-dup by ProxyAdmin address (proxies may share one ProxyAdmin).
  const handledAdmins = new Map(); // proxyAdminAddr(lower) => result string
  const results = []; // for the final summary

  for (const { name, proxyAddr } of proxies) {
    const proxyAdminAddr = await upgrades.erc1967.getAdminAddress(proxyAddr);
    if (!proxyAdminAddr || proxyAdminAddr === ethers.ZeroAddress) {
      throw new Error(
        `${name} (${proxyAddr}): no ProxyAdmin (admin slot is zero). Is this actually a ` +
        `TransparentUpgradeableProxy? Aborting — refusing to guess.`,
      );
    }
    const adminKey = proxyAdminAddr.toLowerCase();

    if (handledAdmins.has(adminKey)) {
      const prior = handledAdmins.get(adminKey);
      console.log(`• ${name}: ProxyAdmin ${proxyAdminAddr} — ${prior} (shared, already handled)`);
      results.push(`${name}: ProxyAdmin ${proxyAdminAddr} (shared)`);
      continue;
    }

    const proxyAdmin = new ethers.Contract(proxyAdminAddr, OWNABLE_ABI, deployer);
    let currentOwner;
    try {
      currentOwner = await proxyAdmin.owner();
    } catch (e) {
      throw new Error(
        `${name}: could not read owner() on ProxyAdmin ${proxyAdminAddr} — is it Ownable? (${e.message})`,
      );
    }

    if (currentOwner.toLowerCase() === safe.toLowerCase()) {
      console.log(`• ${name}: ProxyAdmin ${proxyAdminAddr} owner already = Safe — skip`);
      handledAdmins.set(adminKey, "already Safe — skipped");
      results.push(`${name}: ProxyAdmin ${proxyAdminAddr} owner = Safe (already)`);
      continue;
    }

    if (currentOwner.toLowerCase() !== deployer.address.toLowerCase()) {
      throw new Error(
        `${name}: ProxyAdmin ${proxyAdminAddr} owner is ${currentOwner}, which is NEITHER the ` +
        `deployer (${deployer.address}) NOR the Safe (${safe}). Refusing to send a transfer ` +
        `against an unexpected owner. Investigate before proceeding.`,
      );
    }

    console.log(`• ${name}: ProxyAdmin ${proxyAdminAddr} owner = deployer → transferOwnership(Safe)…`);
    const tx = await proxyAdmin.transferOwnership(safe);
    await tx.wait();
    console.log(`  ✓ ${name}: ProxyAdmin ${proxyAdminAddr} owner → ${safe} (tx ${tx.hash})`);
    handledAdmins.set(adminKey, `transferred → Safe (tx ${tx.hash})`);
    results.push(`${name}: ProxyAdmin ${proxyAdminAddr} owner → Safe (tx ${tx.hash})`);
  }

  // ── Summary ──
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  ProxyAdmin transfer complete");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  for (const r of results) console.log(`  ${r}`);
  console.log("");
  console.log("  ⚠ IRREVERSIBLE: the Safe now controls upgrades for these proxies.");
  console.log("    Only the Safe can upgrade their implementations or move the");
  console.log("    ProxyAdmin onward. The deployer no longer holds upgrade authority.");
  console.log("");
  console.log("  Next: run scripts/transfer-lock-registry-owner.js, then verify the");
  console.log("  deployer holds ZERO privileged control (checklist D-4).");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
