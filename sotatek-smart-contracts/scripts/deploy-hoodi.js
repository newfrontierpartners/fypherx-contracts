/**
 * Per-network deploy entrypoint — Ethereum HOODI testnet (chainId 560048).
 *
 * Per ADR-010 §"Cross-network code factoring", the Solidity codebase is
 * single-tree; per-network differences live in these thin wrappers.
 * This script gates the actual {scripts/deploy.js} on chainId == 560048 so
 * a misconfigured `--network` flag fails-loud instead of silently
 * deploying mainnet bytecode to a test environment (or vice-versa).
 *
 * Usage:
 *   npx hardhat run scripts/deploy-hoodi.js --network hoodi
 */
const { ethers } = require("hardhat");

const EXPECTED_CHAIN_ID = 560048;

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== EXPECTED_CHAIN_ID) {
    console.error(
      `\nERROR: deploy-hoodi.js requires chainId ${EXPECTED_CHAIN_ID}, ` +
      `got ${chainId}. Re-run with --network hoodi (or whichever ` +
      `Hardhat network alias points at Ethereum HOODI testnet).\n`
    );
    process.exit(1);
  }
  console.log(`\n[deploy-hoodi] chainId ${chainId} confirmed — handing off to scripts/deploy.js\n`);
  const deployMain = require("./deploy");
  await deployMain();
}

main().catch((err) => { console.error(err); process.exit(1); });
