/**
 * Verify GIWA contracts against Blockscout's v2 API.
 *
 * <p>WHY NOT `hardhat verify`: GIWA runs Blockscout v11, whose legacy
 * Etherscan-compatible endpoint (`?module=contract&action=verifysourcecode`)
 * still answers `status: 1 / OK` but does not actually verify anything.
 * `@nomicfoundation/hardhat-verify` reads that as success and prints
 * "verified" for every contract while the explorer continues to report
 * {@code is_verified: false}. A false green here is worse than a red one:
 * the whole point of verification is that a reviewer can read the source.
 *
 * <p>This script talks to the v2 API that Blockscout v11 actually implements
 * ({@code POST /api/v2/smart-contracts/{addr}/verification/via/standard-input}),
 * submits the exact Solidity standard-JSON input hardhat compiled with, then
 * <b>polls the explorer until it independently reports the contract as
 * verified</b>. It never trusts the submission response.
 *
 * <p>Proxies: OZ's upgrades plugin puts a TransparentUpgradeableProxy at the
 * address in our registry, with the real logic at a separate implementation
 * address. Source lives on the implementation, so for every proxy we read the
 * ERC-1967 implementation slot and verify that too — otherwise the contract a
 * reviewer opens shows only proxy bytecode.
 *
 * <p>Blockscout detects the proxy itself as {@code proxy_type: eip1967} and
 * renders the linked implementation's source and ABI on the proxy page, so a
 * reviewer opening the token address sees the code. The proxy's own bytecode
 * stays unverified because OZ's upgrades plugin ships it precompiled, outside
 * this project's build-info.
 *
 * Usage:
 *   npx hardhat run scripts/verify-giwa.js --network giwaSepolia
 *
 * Exits non-zero if ANY target is still unverified when it finishes.
 */
const fs = require("fs");
const path = require("path");
const { ethers, artifacts } = require("hardhat");
const addresses = require("./lib/addresses");

const CHAIN_ID = 91342;
const EXPLORER = "https://sepolia-explorer.giwa.io";
const LICENSE = "mit"; // every contract here carries SPDX-License-Identifier: MIT

// ERC-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const SKIP_KEYS = new Set(["_comment", "_explorer", "_rpc"]);
const isAddress = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

/** Registry key -> the contract we compiled it from, where the names differ. */
const SOURCE_NAME = {
  USDT: "MockERC20",
  USDC: "MockERC20",
  MockConcreteAdapterFyusd: "MockConcreteAdapter",
  MockConcreteAdapterRusd: "MockConcreteAdapter",
  FyusdYieldVaultErc4626: "FyusdYieldVault",
  RUSDYieldVault: "RUSDYieldVault",
};

/** Locate the build-info that compiled `fqName`, and its standard JSON input. */
function buildInfoFor(fqName) {
  const dir = path.join(__dirname, "..", "artifacts", "build-info");
  for (const file of fs.readdirSync(dir)) {
    const info = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    const [sourcePath, contractName] = fqName.split(":");
    if (info.output?.contracts?.[sourcePath]?.[contractName]) {
      return { input: info.input, solcLongVersion: info.solcLongVersion };
    }
  }
  return null;
}

async function isVerified(address) {
  try {
    const res = await fetch(`${EXPLORER}/api/v2/addresses/${address}`);
    if (!res.ok) return false;
    return Boolean((await res.json()).is_verified);
  } catch {
    return false;
  }
}

async function submit(address, fqName) {
  const bi = buildInfoFor(fqName);
  if (!bi) throw new Error(`no build-info for ${fqName} (run: npx hardhat compile)`);

  const form = new FormData();
  form.append("compiler_version", `v${bi.solcLongVersion}`);
  form.append("license_type", LICENSE);
  form.append("contract_name", fqName);
  // Constructor args are appended to the creation bytecode on chain; letting
  // Blockscout recover them avoids threading per-contract argument lists
  // through this script and getting one subtly wrong.
  form.append("autodetect_constructor_args", "true");
  form.append(
    "files[0]",
    new Blob([JSON.stringify(bi.input)], { type: "application/json" }),
    "standard-input.json",
  );

  const res = await fetch(
    `${EXPLORER}/api/v2/smart-contracts/${address}/verification/via/standard-input`,
    { method: "POST", body: form },
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 180)}`);
  return text.slice(0, 180);
}

/** Poll until the EXPLORER says verified. Submission success proves nothing. */
async function waitVerified(address, { tries = 20, delayMs = 3000 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (await isVerified(address)) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

async function implementationOf(address) {
  const raw = await ethers.provider.getStorage(address, IMPL_SLOT);
  const impl = ethers.getAddress("0x" + raw.slice(-40));
  return impl === ethers.ZeroAddress ? null : impl;
}

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== CHAIN_ID) {
    console.error(`Requires chainId ${CHAIN_ID}, got ${chainId}.`);
    process.exit(1);
  }
  const registry = addresses.load(chainId);

  // Build the target list: every registry entry, plus the implementation
  // behind any entry that turns out to be a proxy.
  const targets = [];
  for (const [key, address] of Object.entries(registry)) {
    if (SKIP_KEYS.has(key) || !isAddress(address)) continue;
    const contractName = SOURCE_NAME[key] || key;
    let fq;
    try {
      fq = (await artifacts.getAllFullyQualifiedNames()).find(
        (n) => n.split(":")[1] === contractName,
      );
    } catch {
      fq = null;
    }
    if (!fq) {
      console.log(`  ${key.padEnd(26)} [no artifact for "${contractName}" — skipped]`);
      continue;
    }

    const impl = await implementationOf(address);
    if (impl) {
      // The registry address is a proxy. Source belongs on the implementation;
      // Blockscout links the two once the implementation is verified.
      targets.push({ label: `${key} (impl)`, address: impl, fq });
    } else {
      targets.push({ label: key, address, fq });
    }
  }

  console.log(`\nVerifying ${targets.length} contracts via the Blockscout v2 API\n`);

  const pending = [];
  for (const t of targets) {
    process.stdout.write(`  ${t.label.padEnd(28)} ${t.address} ... `);
    if (await isVerified(t.address)) {
      console.log("already verified");
      continue;
    }
    try {
      await submit(t.address, t.fq);
      console.log("submitted");
      pending.push(t);
    } catch (e) {
      console.log(`SUBMIT FAILED — ${e.message}`);
      pending.push(t);
    }
  }

  if (pending.length > 0) {
    console.log(`\nWaiting for the explorer to confirm ${pending.length} submissions...\n`);
  }
  const failed = [];
  for (const t of pending) {
    process.stdout.write(`  ${t.label.padEnd(28)} `);
    if (await waitVerified(t.address)) console.log("verified");
    else {
      console.log("STILL UNVERIFIED");
      failed.push(t);
    }
  }

  console.log("\n═══════════════════════════════════════════════════════");
  console.log(`  verified: ${targets.length - failed.length} / ${targets.length}`);
  console.log("═══════════════════════════════════════════════════════");
  for (const t of targets) {
    console.log(`  ${t.label.padEnd(28)} ${EXPLORER}/address/${t.address}`);
  }
  console.log("");

  if (failed.length > 0) {
    console.error(`  ${failed.length} contract(s) are NOT verified on the explorer.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
