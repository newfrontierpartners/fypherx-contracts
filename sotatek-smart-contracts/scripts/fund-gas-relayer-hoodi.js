/**
 * Send a small ETH grub-stake to the gateway's gas-relayer EOA so it
 * can submit admin epoch / burn / settlement txs on HOODI.
 *
 * The gas relayer key is generated separately from the deployer
 * (lives in the gateway pod env as BACKEND_GAS_RELAYER_PRIVATE_KEY)
 * and was never funded on HOODI — admin epoch lock/settle calls fail
 * with insufficient funds before they ever reach the on-chain
 * executor check. This script bumps the balance to 0.1 HOODI ETH
 * which covers ~50 admin txs at 60-gwei.
 *
 * Idempotent: skips when balance ≥ 0.05 ETH already.
 *
 * Usage:
 *   source .env.hoodi-deployer
 *   npx hardhat run scripts/fund-gas-relayer-hoodi.js --network hoodi
 *
 * Override target (e.g. when keys rotate):
 *   GATEWAY_GAS_RELAYER=0x... npx hardhat run …
 */
const { ethers } = require("hardhat");

const EXPECTED_CHAIN_ID = 560048;
const DEFAULT_GAS_RELAYER = "0x5fA4e48f27CfE353E077a78962e2b578f72B1b97";
const TARGET_BALANCE = ethers.parseEther("0.1");
const REFILL_THRESHOLD = ethers.parseEther("0.05");

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`requires chainId ${EXPECTED_CHAIN_ID}, got ${chainId}`);
  }

  const target = process.env.GATEWAY_GAS_RELAYER || DEFAULT_GAS_RELAYER;
  if (!ethers.isAddress(target)) {
    throw new Error(`Invalid GATEWAY_GAS_RELAYER: ${target}`);
  }

  const [deployer] = await ethers.getSigners();
  const before = await ethers.provider.getBalance(target);

  console.log(`Deployer:  ${deployer.address}`);
  console.log(`Target:    ${target}`);
  console.log(`Balance:   ${ethers.formatEther(before)} ETH`);

  if (before >= REFILL_THRESHOLD) {
    console.log("✓ already funded above threshold — skip");
    return;
  }

  const topUp = TARGET_BALANCE - before;
  console.log(`Sending ${ethers.formatEther(topUp)} ETH…`);
  const tx = await deployer.sendTransaction({ to: target, value: topUp });
  console.log(`tx: ${tx.hash}`);
  await tx.wait();
  const after = await ethers.provider.getBalance(target);
  console.log(`✓ done. Target balance: ${ethers.formatEther(after)} ETH`);
}

main().catch((e) => { console.error(e); process.exit(1); });
