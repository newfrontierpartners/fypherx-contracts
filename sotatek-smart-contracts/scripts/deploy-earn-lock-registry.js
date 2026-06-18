/**
 * deploy-earn-lock-registry.js — deploy the EarnLockRegistry that enforces
 * the Earn (vFYUSD) lock-up tenures (30/60/90 days) on-chain.
 *
 * The backend gas-relayer records each Earn position's unlock timestamp here
 * at deposit (setLock), and the Earn redeem keeper checks isUnlocked() before
 * processing a redemption — so a user who picked a 90-day lock cannot redeem
 * early, enforced on-chain (alongside the off-chain redeem gate).
 *
 * Usage (HOODI):
 *   source .env.hoodi-deployer
 *   RELAYER_ADDRESS=0x<backend hot wallet> \
 *     npx hardhat run scripts/deploy-earn-lock-registry.js --network hoodi
 *
 * RELAYER_ADDRESS (optional): granted the `locker` role so it can record
 * locks. If omitted, only the deployer is a locker (grant the relayer later
 * via setLocker). The deployer is always owner + locker.
 */
const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  console.log(`[earn-lock-registry] network chainId=${net.chainId} deployer=${deployer.address}`);

  const Factory = await ethers.getContractFactory("EarnLockRegistry");
  const registry = await Factory.deploy();
  await registry.waitForDeployment();
  const addr = await registry.getAddress();
  console.log(`[earn-lock-registry] deployed at ${addr}`);

  const relayer = process.env.RELAYER_ADDRESS;
  if (relayer && relayer.toLowerCase() !== deployer.address.toLowerCase()) {
    const tx = await registry.setLocker(relayer, true);
    await tx.wait();
    console.log(`[earn-lock-registry] granted locker → ${relayer} (tx ${tx.hash})`);
  }

  console.log("\n=== runbook ===");
  console.log(`EarnLockRegistry: ${addr}`);
  console.log(`owner / locker:   ${deployer.address}`);
  if (relayer) console.log(`extra locker:     ${relayer}`);
  console.log("\nBackend config (gateway):");
  console.log(`  FYPHERX_EARN_LOCK_REGISTRY=${addr}`);
  console.log("Add the registry to addresses/<chainId>.json as `EarnLockRegistry`.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
