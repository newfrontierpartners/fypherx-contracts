/**
 * Per-network deploy entrypoint — BSC Testnet (chainId 97).
 *
 * Per ADR-010 §"Cross-network code factoring", the Solidity codebase is
 * single-tree; per-network differences live in these thin wrappers.
 * This script gates the actual {scripts/deploy.js} on chainId == 97 so
 * a misconfigured `--network` flag fails-loud instead of silently
 * deploying mainnet bytecode to a test environment (or vice-versa).
 *
 * Usage:
 *   npx hardhat run scripts/deploy-bsc-testnet.js --network bscTestnet
 */
const { ethers } = require("hardhat");

const EXPECTED_CHAIN_ID = 97;

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== EXPECTED_CHAIN_ID) {
    console.error(
      `\nERROR: deploy-bsc-testnet.js requires chainId ${EXPECTED_CHAIN_ID}, ` +
      `got ${chainId}. Re-run with --network bscTestnet (or whichever ` +
      `Hardhat network alias points at BSC Testnet).\n`
    );
    process.exit(1);
  }
  console.log(`\n[deploy-bsc-testnet] chainId ${chainId} confirmed — handing off to scripts/deploy.js\n`);
  // deploy.js exports its main function for awaitable invocation; the
  // require-main guard inside it prevents double-execution.
  const deployMain = require("./deploy");
  await deployMain();
}

main().catch((err) => { console.error(err); process.exit(1); });
