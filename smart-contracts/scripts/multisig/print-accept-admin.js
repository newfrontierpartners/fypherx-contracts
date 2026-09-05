/**
 * Print the calldata that the multisig signers must execute on the Safe
 * UI to call SettingManagement.acceptAdmin(). This is the second leg of
 * the two-step admin transfer.
 *
 * Why a separate script (rather than executing the tx here): the Safe
 * needs `threshold` signatures collected off-chain (Safe Transaction
 * Service or local file-based collection). Hardhat scripts only have
 * the deployer key. The standard ops flow is:
 *
 *   1. Open https://app.safe.global, switch to the right chain + Safe.
 *   2. Click "New transaction" → "Contract interaction".
 *   3. Paste:
 *        Contract:  <SettingManagement address printed below>
 *        ABI:       (auto-fetched, or paste the snippet printed below)
 *        Method:    acceptAdmin
 *        Args:      (none)
 *   4. Collect threshold signatures from the configured signers.
 *   5. Execute.
 *
 * After that tx lands, SettingManagement.owner() == Safe address and
 * the deployer EOA is no longer admin.
 *
 * Usage:
 *   npx hardhat run scripts/multisig/print-accept-admin.js --network hoodi
 */
const { ethers, network } = require("hardhat");
const addresses = require("../lib/addresses");

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const addrs = addresses.load(chainId);
  const settingMgmt = addrs.SettingManagement;
  const safe = addrs.MultisigSafe;
  if (!settingMgmt) throw new Error("SettingManagement address not in addresses file");
  if (!safe) throw new Error("MultisigSafe not in addresses file");

  // Read pending admin to sanity-check that transferAdmin was actually called.
  const setting = new ethers.Contract(
    settingMgmt,
    [
      "function owner() view returns (address)",
      "function acceptAdmin()",
    ],
    ethers.provider,
  );
  const currentAdmin = await setting.owner();

  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Safe acceptAdmin payload — chainId ${chainId}`);
  console.log("═══════════════════════════════════════════════════════");
  console.log("");
  console.log(`SettingManagement: ${settingMgmt}`);
  console.log(`Current admin:     ${currentAdmin}`);
  console.log(`Multisig Safe:     ${safe}`);
  console.log("");

  if (currentAdmin.toLowerCase() === safe.toLowerCase()) {
    console.log("✓ Admin transfer already complete. Safe IS the admin.");
    console.log("  No further action needed.");
    return;
  }

  // Encode acceptAdmin().
  const calldata = setting.interface.encodeFunctionData("acceptAdmin", []);

  console.log("Safe UI inputs (https://app.safe.global → New transaction → Contract interaction):");
  console.log("");
  console.log(`  Contract address:  ${settingMgmt}`);
  console.log(`  Method:            acceptAdmin()`);
  console.log(`  Calldata (raw):    ${calldata}`);
  console.log(`  Value:             0`);
  console.log(`  ABI snippet:`);
  console.log(`    [{"type":"function","name":"acceptAdmin","stateMutability":"nonpayable","inputs":[],"outputs":[]}]`);
  console.log("");
  console.log("After the Safe tx executes, SettingManagement.owner() will return");
  console.log(`the Safe address (${safe}) and the deployer EOA loses admin authority.`);
  console.log("");
}

main().catch((err) => { console.error(err); process.exit(1); });
