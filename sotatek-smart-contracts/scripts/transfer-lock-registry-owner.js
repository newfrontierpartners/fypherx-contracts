/**
 * transfer-lock-registry-owner.js — hand the EarnLockRegistry owner role to
 * the Operator Safe, so the temp deployer EOA retains no governance over the
 * on-chain Earn lock-up registry.
 *
 * EarnLockRegistry (contracts/Fypher/EarnLockRegistry.sol) is non-upgradeable
 * and Ownable-ish with an `address public owner` + `setOwner(address newOwner)`
 * (onlyOwner). The deployer is set as `owner` in the constructor at deploy
 * (deploy-earn-lock-registry.js). This script moves that ownership to the Safe.
 *
 * IMPORTANT: this moves ONLY ownership/governance — it does NOT touch the
 * `locker` set. The backend gas-relayer keeps its `locker` role (granted at
 * deploy via setLocker / RELAYER_ADDRESS), so the Earn deposit path that
 * records locks is NOT disrupted by this transfer. Owner governs the locker
 * set + future setOwner; existing locks are immutable regardless.
 *
 * Behaviour:
 *   - owner == Safe already → skip (idempotent).
 *   - owner == deployer    → setOwner(Safe).
 *   - owner == neither      → ABORT (never blindly send against an
 *                             unexpected owner).
 *
 * Required env:
 *   PRIVATE_KEY             deployer EOA (current registry owner).
 *   OPERATOR_SAFE_ADDRESS   the Operator Safe (new owner).
 *
 * ⚠ IRREVERSIBLE from the deployer side: after this, only the Safe can call
 *   setOwner / setLocker on the registry.
 *
 * Usage:
 *   OPERATOR_SAFE_ADDRESS=0x<safe> \
 *     npx hardhat run scripts/transfer-lock-registry-owner.js --network mainnet
 */
const { ethers } = require("hardhat");
const addresses = require("./lib/addresses");

// EarnLockRegistry ownership surface (verified against the .sol):
//   address public owner;                          → owner() getter
//   function setOwner(address newOwner) external onlyOwner;
const LOCK_REGISTRY_ABI = [
  "function owner() view returns (address)",
  "function setOwner(address newOwner)",
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

  const addrs = addresses.load(chainId);
  const registryAddr = addrs.EarnLockRegistry;
  if (!registryAddr || !ethers.isAddress(registryAddr)) {
    throw new Error(
      `EarnLockRegistry missing/invalid in addresses/${chainId}.json: ${registryAddr}. ` +
      `Deploy it first (scripts/deploy-earn-lock-registry.js).`,
    );
  }

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Transfer EarnLockRegistry owner → Operator Safe");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`Chain id:           ${chainId}`);
  console.log(`Deployer:           ${deployer.address}`);
  console.log(`Safe:               ${safe}`);
  console.log(`EarnLockRegistry:   ${registryAddr}`);
  console.log("");

  const registry = new ethers.Contract(registryAddr, LOCK_REGISTRY_ABI, deployer);
  let currentOwner;
  try {
    currentOwner = await registry.owner();
  } catch (e) {
    throw new Error(`Could not read owner() on ${registryAddr} — is it the EarnLockRegistry? (${e.message})`);
  }
  console.log(`Current owner:      ${currentOwner}`);

  if (currentOwner.toLowerCase() === safe.toLowerCase()) {
    console.log("ℹ owner already = Safe — nothing to do.");
    console.log("\n  Note: the backend relayer keeps its `locker` role — unaffected.");
    return;
  }

  if (currentOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(
      `EarnLockRegistry owner is ${currentOwner}, which is NEITHER the deployer ` +
      `(${deployer.address}) NOR the Safe (${safe}). Refusing to send setOwner against ` +
      `an unexpected owner. Investigate before proceeding.`,
    );
  }

  console.log(`\n→ setOwner(${safe})…`);
  const tx = await registry.setOwner(safe);
  await tx.wait();
  console.log(`  ✓ EarnLockRegistry owner → ${safe} (tx ${tx.hash})`);

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  EarnLockRegistry ownership transferred");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  owner: ${safe}`);
  console.log("  The backend relayer's `locker` role is UNCHANGED — lock recording");
  console.log("  on Earn deposits is not disrupted.");
  console.log("  ⚠ IRREVERSIBLE from the deployer side: only the Safe can now call");
  console.log("    setOwner / setLocker on the registry.");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
