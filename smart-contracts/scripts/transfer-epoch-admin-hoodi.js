/**
 * transfer-epoch-admin-hoodi.js — STEP 1 of 2 (run by the CURRENT SM admin).
 *
 * The live HOODI SettingManagement (0xc18aa2…) is SingleAdminAccessControl:
 * DEFAULT_ADMIN_ROLE == being the single `_admin`, changed only via the
 * two-step transferAdmin → acceptAdmin. grantRole is a no-op for the admin
 * role. So to let the gateway executor pass FyusdEpochSettlement.openEpoch
 * (onlyAdmin) in dev direct-mode, we move the single admin to the executor.
 *
 * STEP 1 (this script): current admin (HOODI deployer 0x570B…) calls
 *   transferAdmin(executor) → sets pendingAdmin.
 *   source .env.hoodi-deployer && \
 *   npx hardhat run scripts/transfer-epoch-admin-hoodi.js --network hoodi
 *
 * STEP 2: the executor accepts — see accept-epoch-admin-hoodi.js.
 *
 * Reversible: after the test, run the same two-step back to 0x570B….
 * NOTE: this moves SettingManagement admin away from the deployer, so
 * deployer-run SettingManagement.onlyAdmin ops (fees/signer/custodian
 * changes) would need the executor afterwards. Proxy upgrades use a
 * separate ProxyAdmin and are unaffected.
 */
const { ethers } = require("hardhat");

const SETTING_MANAGEMENT = process.env.SM_ADDRESS       || "0xc18aa2f11773bca657a9575c8ee99205f3aec812";
const EXECUTOR_EOA       = process.env.EXECUTOR_ADDRESS || "0x5fa4e48f27cfe353e077a78962e2b578f72b1b97";

const ABI = [
  "function admin() view returns (address)",
  "function pendingAdmin() view returns (address)",
  "function transferAdmin(address newAdmin)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("No signer — `source .env.hoodi-deployer` first?");
  const sm = new ethers.Contract(SETTING_MANAGEMENT, ABI, signer);

  const curAdmin = await sm.admin();
  console.log("Signer:        ", signer.address);
  console.log("Current admin: ", curAdmin);
  console.log("New admin (exec):", EXECUTOR_EOA);
  if (signer.address.toLowerCase() !== curAdmin.toLowerCase()) {
    throw new Error(`Signer is not the current admin (${curAdmin}). Run with that key.`);
  }

  const tx = await sm.transferAdmin(EXECUTOR_EOA);
  console.log("transferAdmin tx:", tx.hash);
  await tx.wait();
  console.log("pendingAdmin now:", await sm.pendingAdmin());
  console.log("✅ STEP 1 done. Now run STEP 2 (accept) with the EXECUTOR key.");
}

main().catch((e) => { console.error(e); process.exit(1); });
