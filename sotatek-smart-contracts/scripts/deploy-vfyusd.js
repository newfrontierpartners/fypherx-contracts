/**
 * deploy-vfyusd.js — deploy the model-A prod vFYUSD receipt token (single
 * controlled-mint ERC-20) and grant the backend keeper MINTER + BURNER roles.
 *
 * Model A (hybrid, single vFYUSD): the keeper mints vFYUSD to the user on an
 * Earn deposit and burns it on redeem. DEFAULT_ADMIN_ROLE starts on the
 * deployer and is transferred to the Operator Safe with the other contracts.
 *
 *   RELAYER_ADDRESS=0x<keeper hot wallet> \
 *   npx hardhat run scripts/deploy-vfyusd.js --network mainnet
 */
const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No signer — is PRIVATE_KEY set for this network?");

  const minter = process.env.RELAYER_ADDRESS && ethers.isAddress(process.env.RELAYER_ADDRESS)
    ? ethers.getAddress(process.env.RELAYER_ADDRESS)
    : deployer.address;

  console.log(`[vfyusd] deployer=${deployer.address} minter/burner=${minter}`);

  const VFyusd = await ethers.getContractFactory("VFyusd");
  const v = await VFyusd.deploy("Fypher vFYUSD", "vFYUSD", 6, deployer.address);
  await v.waitForDeployment();
  const addr = await v.getAddress();
  console.log(`[vfyusd] deployed at ${addr} (admin=${deployer.address})`);

  const MINTER = await v.MINTER_ROLE();
  const BURNER = await v.BURNER_ROLE();
  await (await v.grantRole(MINTER, minter)).wait();
  await (await v.grantRole(BURNER, minter)).wait();
  console.log(`[vfyusd] granted MINTER + BURNER → ${minter}`);

  console.log("\n  vFYUSD:", addr);
  console.log("  → set FYPHERX_EARN_DEV_VFYUSD_ADDRESS =", addr);
  console.log("  → admin (DEFAULT_ADMIN_ROLE) = deployer; transfer to the Operator Safe with the rest.");
  console.log("  → keeper (RELAYER) holds MINTER + BURNER; keep it (funds path).");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
