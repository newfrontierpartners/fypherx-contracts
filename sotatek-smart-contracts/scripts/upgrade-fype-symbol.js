/**
 * Re-symbolize FYP → FYPE and StakedFYP → sFYPE (Depth A).
 *
 * What this does
 * ──────────────
 * FYP and StakedFYP are upgradeable (TransparentProxy). Their on-chain
 * symbol()/name() were initialized as "FYP"/"sFYP". The new implementations
 * override name()/symbol() to return the product names "FYPE"/"sFYPE", so this
 * upgrade re-labels the LIVE proxies address-preservingly — no storage
 * migration, no holder/balance impact, same proxy addresses.
 *
 * Storage layout safety
 * ─────────────────────
 * The new impls add ONLY function overrides (no new/changed storage slots).
 * {OZ Upgrades} validates the layout against {.openzeppelin/<network>.json}
 * and aborts on any slot shift / type change / removal. Re-run safe.
 *
 * Scope
 * ─────
 * Testnet only — FYP is NOT deployed on Ethereum mainnet (addresses/1.json has
 * no FYP). Run on hoodi (the dev cluster's chain) and optionally sepolia.
 *
 * Usage
 * ─────
 *   npx hardhat run scripts/upgrade-fype-symbol.js --network hoodi
 *   npx hardhat run scripts/upgrade-fype-symbol.js --network sepolia
 */
const { ethers, upgrades } = require("hardhat");
const addresses = require("./lib/addresses");

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  console.log("═══════════════════════════════════════════════════════");
  console.log(`  FYP/sFYP → FYPE/sFYPE symbol upgrade — chainId ${chainId}`);
  console.log("═══════════════════════════════════════════════════════");
  console.log(`Deployer:  ${deployer.address}`);
  const balBefore = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance:   ${ethers.formatEther(balBefore)} (gas token)\n`);

  if (chainId === 1) throw new Error("FYP is not deployed on Ethereum mainnet — testnet only.");

  const addrs = addresses.load(chainId);

  await upgradeToken("FYP", addrs.FYP, "FYPE");
  await upgradeToken("StakedFYP", addrs.StakedFYP, "sFYPE");

  const balAfter = await ethers.provider.getBalance(deployer.address);
  console.log("");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  DONE — Gas spent: ${ethers.formatEther(balBefore - balAfter)} (gas token)`);
  console.log("═══════════════════════════════════════════════════════");
  console.log("Next steps");
  console.log("──────────");
  console.log("- /api/v1/tokens reads on-chain symbol() → now returns FYPE; the");
  console.log("  frontend FYP→FYPE display shim becomes a no-op (remove in Depth B).");
  console.log("- Repeat on sepolia if you want the audit/reference deploy re-labeled.");
}

async function upgradeToken(contractName, proxyAddr, expectedSymbol) {
  console.log(`── ${contractName} @ ${proxyAddr || "(missing)"} ──`);
  if (!proxyAddr) {
    console.log(`  ⚠ address registry has no ${contractName} on this chain — skipped\n`);
    return;
  }

  const before = await ethers.getContractAt(contractName, proxyAddr);
  const beforeSym = await before.symbol();
  const beforeName = await before.name();
  console.log(`  before:  name="${beforeName}" symbol="${beforeSym}"`);
  if (beforeSym === expectedSymbol) {
    console.log(`  ✓ already "${expectedSymbol}" — skipped\n`);
    return;
  }

  const Factory = await ethers.getContractFactory(contractName);
  const upgraded = await upgrades.upgradeProxy(proxyAddr, Factory);
  await upgraded.waitForDeployment();

  const afterSym = await upgraded.symbol();
  const afterName = await upgraded.name();
  if (afterSym !== expectedSymbol) {
    throw new Error(`${contractName} symbol is "${afterSym}", expected "${expectedSymbol}"`);
  }
  console.log(`  ✓ upgraded (proxy unchanged): name="${afterName}" symbol="${afterSym}"\n`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
