/**
 * Call SettingManagement.transferAdmin(<MultisigSafe>) from the current
 * EOA admin. After this transaction, the multisig MUST execute
 * SettingManagement.acceptAdmin() to complete the two-step transfer
 * (see SingleAdminAccessControl.transferAdmin / acceptAdmin).
 *
 * Until acceptAdmin lands, the EOA still holds admin — the protocol is
 * NOT broken if the multisig delays.
 *
 * Usage:
 *   npx hardhat run scripts/multisig/transfer-admin.js --network hoodi
 */
const { ethers, network } = require("hardhat");
const addresses = require("../lib/addresses");

async function main() {
  const [eoaAdmin] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  console.log("═══════════════════════════════════════════════════════");
  console.log(`  SettingManagement.transferAdmin(safe) — chainId ${chainId}`);
  console.log("═══════════════════════════════════════════════════════");
  console.log("Caller (current EOA admin):", eoaAdmin.address);

  const addrs = addresses.load(chainId);
  const settingMgmt = addrs.SettingManagement;
  const safe = addrs.MultisigSafe;
  if (!settingMgmt) throw new Error("SettingManagement address not in addresses file");
  if (!safe) throw new Error("MultisigSafe not in addresses file (run deploy-safe.js first)");

  console.log(`SettingManagement: ${settingMgmt}`);
  console.log(`MultisigSafe:      ${safe}`);

  const setting = new ethers.Contract(
    settingMgmt,
    [
      "function owner() view returns (address)",
      "function transferAdmin(address newAdmin)",
    ],
    eoaAdmin,
  );

  // Sanity: caller IS the current admin.
  const currentAdmin = await setting.owner();
  if (currentAdmin.toLowerCase() !== eoaAdmin.address.toLowerCase()) {
    throw new Error(
      `Caller ${eoaAdmin.address} is not the current admin (${currentAdmin}). ` +
      "Re-run from the deployer EOA."
    );
  }

  console.log("\nSubmitting transferAdmin tx...");
  const tx = await setting.transferAdmin(safe);
  const receipt = await tx.wait();
  console.log(`  tx: ${receipt.hash}`);

  console.log("\n✓ transferAdmin queued. Pending Safe acceptance.");
  console.log("\nNext step: the multisig signers must execute acceptAdmin().");
  console.log("Run scripts/multisig/print-accept-admin.js for the exact calldata to paste");
  console.log("into the Safe UI (https://app.safe.global -> New transaction -> Contract interaction).");
  console.log("");
}

main().catch((err) => { console.error(err); process.exit(1); });
