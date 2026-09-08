/**
 * accept-epoch-admin-hoodi.js — STEP 2 of 2 (run by the gateway EXECUTOR EOA).
 *
 * After transfer-epoch-admin-hoodi.js set the executor as pendingAdmin, the
 * executor must accept. The hoodi network signs with HOODI_DEPLOYER_PRIVATE_KEY,
 * so run this with that env set to the EXECUTOR's key (the gateway's
 * BACKEND_EXECUTOR_PRIVATE_KEY), NOT the deployer's:
 *
 *   # pull the executor key from the cluster (you have access), then:
 *   HOODI_DEPLOYER_PRIVATE_KEY=<gateway BACKEND_EXECUTOR_PRIVATE_KEY> \
 *     npx hardhat run scripts/accept-epoch-admin-hoodi.js --network hoodi
 *
 * After this, hasRole(DEFAULT_ADMIN_ROLE, executor) is true and
 * FyusdEpochSettlement.openEpoch will succeed from the gateway.
 */
const { ethers } = require("hardhat");

const SETTING_MANAGEMENT = process.env.SM_ADDRESS || "0xc18aa2f11773bca657a9575c8ee99205f3aec812";
const DEFAULT_ADMIN_ROLE = "0x" + "00".repeat(32);

const ABI = [
  "function pendingAdmin() view returns (address)",
  "function admin() view returns (address)",
  "function acceptAdmin()",
  "function hasRole(bytes32 role, address account) view returns (bool)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("No signer — set HOODI_DEPLOYER_PRIVATE_KEY to the executor key first?");
  const sm = new ethers.Contract(SETTING_MANAGEMENT, ABI, signer);

  const pending = await sm.pendingAdmin();
  console.log("Signer (must be pendingAdmin):", signer.address);
  console.log("pendingAdmin:", pending);
  if (signer.address.toLowerCase() !== pending.toLowerCase()) {
    throw new Error(`Signer is not the pendingAdmin (${pending}). Run with the executor key, after STEP 1.`);
  }

  const tx = await sm.acceptAdmin();
  console.log("acceptAdmin tx:", tx.hash);
  await tx.wait();

  console.log("new admin:", await sm.admin());
  console.log("hasRole(ADMIN, signer):", await sm.hasRole(DEFAULT_ADMIN_ROLE, signer.address));
  console.log("✅ Done — the gateway executor is now SM admin; openEpoch will succeed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
