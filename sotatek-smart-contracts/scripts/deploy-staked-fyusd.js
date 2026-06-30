/**
 * deploy-staked-fyusd.js — deploy the renamed Earn receipt token sFYUSD
 * (StakedFYUSD: controlled-mint ERC-20 + lock-gated transfers + pause) and
 * grant the backend keeper the operational roles.
 *
 * Replaces vFYUSD (VFyusd). The keeper mints sFYUSD on an Earn deposit, records
 * the holder's lock-up (LOCKER_ROLE), and burns on redeem. DEFAULT_ADMIN_ROLE
 * starts on the deployer and is transferred to the Operator Safe with the rest.
 *
 *   RELAYER_ADDRESS=0x<keeper hot wallet> \
 *   npx hardhat run scripts/deploy-staked-fyusd.js --network hoodi   # dev
 *   ... --network mainnet                                            # prod
 */
const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No signer — is PRIVATE_KEY set for this network?");

  const keeper = process.env.RELAYER_ADDRESS && ethers.isAddress(process.env.RELAYER_ADDRESS)
    ? ethers.getAddress(process.env.RELAYER_ADDRESS)
    : deployer.address;

  const net = await ethers.provider.getNetwork();
  console.log(`[sfyusd] chainId=${net.chainId} deployer=${deployer.address} keeper=${keeper}`);

  const SF = await ethers.getContractFactory("StakedFYUSD");
  const sf = await SF.deploy("Staked FYUSD", "sFYUSD", 6, deployer.address);
  await sf.waitForDeployment();
  const addr = await sf.getAddress();
  console.log(`[sfyusd] deployed at ${addr} (admin=${deployer.address})`);

  for (const role of ["MINTER_ROLE", "BURNER_ROLE", "LOCKER_ROLE", "PAUSER_ROLE"]) {
    const r = await sf[role]();
    await (await sf.grantRole(r, keeper)).wait();
    console.log(`[sfyusd] granted ${role} → ${keeper}`);
  }

  console.log("\n  sFYUSD:", addr);
  console.log("  → set FYPHERX_EARN_DEV_VFYUSD_ADDRESS (and prod equivalent) =", addr);
  console.log("  → frontend addresses.ts EarnHybridVfyusd (this chain) =", addr);
  console.log("  → admin (DEFAULT_ADMIN_ROLE) = deployer; transfer to the Operator Safe with the rest.");
  console.log("  → keeper holds MINTER+BURNER+LOCKER+PAUSER. Keep MINTER/BURNER/LOCKER (funds + lock path).");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
