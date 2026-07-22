/**
 * GIWA Sepolia preflight probe.
 *
 * Verifies, before any deploy, that:
 *   - the RPC answers and reports chainId 91342 (not a stale/misrouted URL),
 *   - the deployer key is loaded (.env.giwa-deployer -> GIWA_DEPLOYER_PRIVATE_KEY),
 *   - the deployer has enough gas.
 *
 * Usage:
 *   npx hardhat run scripts/probe-giwa.js --network giwaSepolia
 */
const { ethers } = require("hardhat");

const GIWA_SEPOLIA_CHAIN_ID = 91342n;
// Measured floor, matching deploy-giwa.js. The full sequence costs ~0.000056
// ETH including the OP Stack L1 data fee (see
// scripts/estimate-giwa-deploy-cost.js), so 0.001 is ~18x headroom. Sized to
// catch "the faucet never landed" without rejecting a wallet the GIWA faucet
// has actually funded (it dispenses 0.005 ETH).
const MIN_BALANCE_WEI = ethers.parseEther("0.001");

async function main() {
  const net = await ethers.provider.getNetwork();
  console.log("rpc chainId:", net.chainId.toString());
  if (net.chainId !== GIWA_SEPOLIA_CHAIN_ID) {
    throw new Error(
      `Expected chainId ${GIWA_SEPOLIA_CHAIN_ID} (GIWA Sepolia) but the RPC ` +
        `reported ${net.chainId}. Check GIWA_RPC_URL.`,
    );
  }

  const block = await ethers.provider.getBlockNumber();
  const feeData = await ethers.provider.getFeeData();
  console.log("block:      ", block);
  console.log("gasPrice:   ", feeData.gasPrice?.toString(), "wei");

  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    throw new Error(
      "No signer configured. Set GIWA_DEPLOYER_PRIVATE_KEY (see " +
        "scripts/gen-giwa-deployer.js and .env.giwa-deployer).",
    );
  }
  const deployer = signers[0];
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("deployer:   ", deployer.address);
  console.log("balance:    ", ethers.formatEther(balance), "ETH");

  if (balance < MIN_BALANCE_WEI) {
    throw new Error(
      `Deployer balance ${ethers.formatEther(balance)} ETH is below the ` +
        `${ethers.formatEther(MIN_BALANCE_WEI)} ETH preflight minimum. Fund ` +
        `${deployer.address} via https://faucet.giwa.io/ or by bridging ` +
        `Sepolia ETH through the OptimismPortal ` +
        `0x956962C34687A954e611A83619ABaA37Ce6bC78A.`,
    );
  }

  console.log("\nPreflight OK — ready to run scripts/deploy-giwa.js");
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
