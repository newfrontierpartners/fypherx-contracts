/**
 * Per-network deploy entrypoint — Ethereum Sepolia (chainId 11155111).
 *
 * Per ADR-010 §"Promotion criteria (1.0 → 1.1)" Sepolia is the
 * pre-production stage where Bitgo Sandbox + (where available) the real
 * Concrete contracts come online. The script gates on chainId so a
 * misconfigured `--network` doesn't deploy mainnet bytecode here or
 * vice-versa.
 *
 * Note: deploy.js currently allows MockERC20 deployment only on
 * hardhat / localhost / sepolia (see ALLOWED_MOCK_NETWORKS). On
 * Sepolia those mocks are disabled — the deploy script must be wired
 * against real (or already-deployed sandbox) USDT/USDC/etc. Wire that
 * before running this entrypoint.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-sepolia.js --network sepolia
 */
const { ethers } = require("hardhat");

const EXPECTED_CHAIN_ID = 11155111;

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== EXPECTED_CHAIN_ID) {
    console.error(
      `\nERROR: deploy-sepolia.js requires chainId ${EXPECTED_CHAIN_ID}, ` +
      `got ${chainId}. Re-run with --network sepolia.\n`
    );
    process.exit(1);
  }
  console.log(`\n[deploy-sepolia] chainId ${chainId} confirmed — handing off to scripts/deploy.js\n`);
  const deployMain = require("./deploy");
  await deployMain();
}

main().catch((err) => { console.error(err); process.exit(1); });
