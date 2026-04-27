/**
 * Per-network deploy entrypoint — Ethereum Mainnet (chainId 1).
 *
 * Per ADR-010 §"Promotion criteria (1.1 → 1.2)" mainnet deploy requires:
 *   - external audit on contracts complete
 *   - Bitgo Prime mainnet account onboarded
 *   - Concrete mainnet adapter signature verified (ConcreteAdapterV1
 *     stub replaced with the real implementation, see ADR-006)
 *   - Cold-storage signers physically distributed
 *   - Multisig 3-of-5 (per ADR-007) ready
 *
 * The script REFUSES to run if MockERC20 would land on mainnet — that
 * guard is enforced by deploy.js's ALLOWED_MOCK_NETWORKS check, which
 * does not include mainnet.
 *
 * Additional pre-flight: the script asserts
 *   process.env.FYPHER_MAINNET_DEPLOY_CONFIRMED == "I have read ADR-010"
 * to make accidental invocation impossible. Set the env var explicitly
 * before running.
 *
 * Usage:
 *   FYPHER_MAINNET_DEPLOY_CONFIRMED="I have read ADR-010" \
 *     npx hardhat run scripts/deploy-mainnet.js --network mainnet
 */
const { ethers } = require("hardhat");

const EXPECTED_CHAIN_ID = 1;
const CONFIRMATION_REQUIRED = "I have read ADR-010";

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== EXPECTED_CHAIN_ID) {
    console.error(
      `\nERROR: deploy-mainnet.js requires chainId ${EXPECTED_CHAIN_ID}, ` +
      `got ${chainId}. Re-run with --network mainnet (or whichever ` +
      `Hardhat network alias points at Ethereum Mainnet).\n`
    );
    process.exit(1);
  }
  if (process.env.FYPHER_MAINNET_DEPLOY_CONFIRMED !== CONFIRMATION_REQUIRED) {
    console.error(
      `\nERROR: mainnet deploy requires explicit confirmation.\n` +
      `Set FYPHER_MAINNET_DEPLOY_CONFIRMED="${CONFIRMATION_REQUIRED}" ` +
      `before re-running.\n` +
      `Re-read docs/decisions/ADR-010-network-rollout-* and the §"Promotion ` +
      `criteria (1.1 → 1.2)" checklist FIRST.\n`
    );
    process.exit(1);
  }
  console.log(`\n[deploy-mainnet] chainId ${chainId} + confirmation OK — handing off to scripts/deploy.js\n`);
  const deployMain = require("./deploy");
  await deployMain();
}

main().catch((err) => { console.error(err); process.exit(1); });
