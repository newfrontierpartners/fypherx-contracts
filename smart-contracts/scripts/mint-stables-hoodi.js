/**
 * Mint USDT + USDC on HOODI testnet to the deployer.
 *
 * Usage:
 *   npx hardhat run scripts/mint-stables-hoodi.js --network hoodi
 *
 * Override recipient + amount via env:
 *   MINT_TO=0x...   (default: deployer)
 *   MINT_AMOUNT=10000  (default: 100000, 18-decimal units)
 */
const { ethers } = require("hardhat");
const addresses = require("./lib/addresses");

const EXPECTED_CHAIN_ID = 560048;

async function main() {
  const net = await ethers.provider.getNetwork();
  if (Number(net.chainId) !== EXPECTED_CHAIN_ID) {
    throw new Error(`requires chainId ${EXPECTED_CHAIN_ID}, got ${net.chainId}`);
  }
  const [deployer] = await ethers.getSigners();
  const map = addresses.load(EXPECTED_CHAIN_ID);

  const to = process.env.MINT_TO || deployer.address;
  const amountUnits = process.env.MINT_AMOUNT || "100000";
  const amount = ethers.parseUnits(amountUnits, 18);

  console.log(`[mint] chainId ${net.chainId} signer ${deployer.address}`);
  console.log(`[mint] recipient ${to}`);
  console.log(`[mint] amount    ${amountUnits} per token (18 dec)\n`);

  const tokens = [
    { name: "USDT", address: map.USDT },
    { name: "USDC", address: map.USDC },
  ];

  const abi = [
    "function mint(address to, uint256 amount) external",
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
  ];

  for (const t of tokens) {
    if (!t.address) {
      console.log(`${t.name}: SKIP — address not in registry`);
      continue;
    }
    try {
      const c = await ethers.getContractAt(abi, t.address);
      const tx = await c.mint(to, amount);
      const rcpt = await tx.wait();
      const bal = await c.balanceOf(to);
      console.log(`${t.name} (${t.address}): minted ${amountUnits} → balance ${ethers.formatUnits(bal, 18)} (tx ${rcpt.hash})`);
    } catch (e) {
      console.log(`${t.name}: FAILED — ${e.shortMessage || e.message.slice(0, 120)}`);
    }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
