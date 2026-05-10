/**
 * Per-network deploy entrypoint — Ethereum HOODI testnet (chainId 560048).
 *
 * HOODI is the testnet selected for the FYUSD ↔ Concrete integration
 * because Concrete does not support Sepolia for partner stable-vault
 * deployments. Concrete has already deployed FYUSD on HOODI:
 *   https://hoodi.etherscan.io/token/0xd1bbd247be78c68cdeb8486744bd4513e62025e6
 *
 * <p>This script is a <b>preflight gate</b> + <b>operational runbook</b>.
 * It does NOT call into a single shared deploy.js (that file was removed
 * in commit 0965dd6c during the alpha audit-scope cleanup; the
 * pre-existing per-network wrappers — `deploy-sepolia.js` etc — that
 * still reference it are zombies). On HOODI we deploy in stages, each
 * with its own targeted script, so the runbook below is the source of
 * truth rather than a single entrypoint.
 *
 * <p><b>Pre-flight checklist</b>:
 * <ol>
 *   <li>{@code .env.hoodi-deployer} populated with
 *       {@code HOODI_DEPLOYER_PRIVATE_KEY} (gitignored — see
 *       {@code .env.example} block tagged HOODI)</li>
 *   <li>Deployer EOA funded with HOODI ETH from a public faucet (e.g.
 *       https://hoodi-faucet.pk910.de/). Recommended balance:
 *       ≥ 0.5 HOODI ETH for full Phase 1 deploy.</li>
 *   <li>{@code addresses/560048.json} present with the FYUSD entry
 *       pre-populated to Concrete's deployed instance — created by
 *       this PR.</li>
 * </ol>
 *
 * <p><b>Deploy order on HOODI</b> (run each separately):
 * <pre>
 *   # 1. Operator multisig (ADR-012). Same Safe contracts as Sepolia,
 *   #    different threshold/owners-per-env if desired.
 *   npx hardhat run scripts/multisig/deploy-safe.js --network hoodi
 *
 *   # 2. Phase-0 base tokens — RUSD, FYP — and SettingManagement.
 *   #    NOT FYUSD (use Concrete's). NOT USDT/USDC (use HOODI faucet
 *   #    canonical or deploy MockERC20 if Concrete's vault accepts it).
 *   #    Currently no single-shot Phase-0 script exists; mirror what
 *   #    `addresses/11155111.json` shows and run targeted deploy-*
 *   #    scripts as needed.
 *
 *   # 3. Phase-1 contracts (BurnQueue + EpochSettlement + StakingHub
 *   #    + YieldVault + CircuitBreaker). Reads the existing entries
 *   #    from addresses/560048.json and fills in the missing ones.
 *   npx hardhat run scripts/deploy-phase1.js --network hoodi
 *
 *   # 4. ConcreteAdapterV1 — once Concrete shares the test vault
 *   #    address. Single script (TBD in follow-up PR) wires
 *   #    FyusdYieldVault.setAdapter(ConcreteAdapterV1).
 * </pre>
 *
 * Usage of this entrypoint:
 *   npx hardhat run scripts/deploy-hoodi.js --network hoodi
 *
 * Output: chainId confirmation + deployer balance + the runbook above.
 * Exits non-zero if either chainId or deployer-balance preflights fail
 * so a misrouted run never silently no-ops.
 */
const { ethers } = require("hardhat");

const EXPECTED_CHAIN_ID = 560048;
/** 0.05 HOODI ETH — enough for ~5 deploy txs at HOODI's typical base fee.
 *  Below this we abort: a deploy that runs out of gas mid-sequence
 *  leaves the addresses file in a half-written state. Faucet first. */
const MIN_DEPLOYER_BALANCE_WEI = 50_000_000_000_000_000n;  // 0.05 ETH

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== EXPECTED_CHAIN_ID) {
    console.error(
      `\nERROR: deploy-hoodi.js requires chainId ${EXPECTED_CHAIN_ID}, ` +
      `got ${chainId}. Re-run with --network hoodi.\n`
    );
    process.exit(1);
  }

  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    console.error(
      "\nERROR: no signer available. Set HOODI_DEPLOYER_PRIVATE_KEY in " +
      ".env.hoodi-deployer (gitignored) or pass it inline before " +
      "running this script.\n"
    );
    process.exit(1);
  }
  const balance = await ethers.provider.getBalance(deployer.address);
  if (balance < MIN_DEPLOYER_BALANCE_WEI) {
    console.error(
      `\nERROR: deployer ${deployer.address} balance ${ethers.formatEther(balance)} ETH ` +
      `is below the ${ethers.formatEther(MIN_DEPLOYER_BALANCE_WEI)} ETH minimum. ` +
      `Faucet first, then re-run.\n`
    );
    process.exit(1);
  }

  console.log("\n[deploy-hoodi] preflight passed");
  console.log(`  chainId:  ${chainId} (HOODI)`);
  console.log(`  deployer: ${deployer.address}`);
  console.log(`  balance:  ${ethers.formatEther(balance)} ETH`);
  console.log("");
  console.log("Next: run targeted deploy scripts in order. See the file");
  console.log("header for the full runbook. Quick reference:");
  console.log("");
  console.log("  npx hardhat run scripts/multisig/deploy-safe.js --network hoodi");
  console.log("  npx hardhat run scripts/deploy-phase1.js        --network hoodi");
  console.log("");
  console.log("FYUSD on HOODI is Concrete-deployed; do not redeploy:");
  console.log("  https://hoodi.etherscan.io/token/0xd1bbd247be78c68cdeb8486744bd4513e62025e6");
  console.log("");
}

main().catch((err) => { console.error(err); process.exit(1); });
