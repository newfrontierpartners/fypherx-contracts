/**
 * Per-network deploy entrypoint — GIWA Sepolia (chainId 91342).
 *
 * <p>GIWA is Dunamu/Upbit's OP-Stack L2. It backs the `giwa` environment
 * (giwa.fypherfi.com), which sits alongside dev and prod rather than
 * replacing either.
 *
 * <p><b>What makes GIWA different from HOODI and mainnet</b>: neither
 * BitGo (custody) nor Concrete (yield venue) supports the chain. Rather
 * than stubbing those integrations behind flags and shipping a product
 * that quietly does nothing, the GIWA deployment is fully self-contained:
 *
 * <pre>
 *   MockERC20 USDT/USDC        open mint == faucet, no custody
 *        │
 *        ├─ FyusdTeller ──────> FYUSD          1:1, reserves on-chain
 *        │                        │
 *        │                        └─ FyusdYieldVault (vFYUSD, ERC-4626)
 *        │                                │
 *        │                          MockConcreteAdapter  4% simulated APY
 *        └─ FypherMinting ─────> RUSD
 * </pre>
 *
 * Every leg is a real transaction against a verified contract, so the whole
 * money path is reviewable from the block explorer alone.
 *
 * <p>This script is a <b>preflight gate</b> + <b>runbook</b>, matching the
 * deploy-hoodi.js convention — it does not deploy anything itself, so a
 * half-finished run can never leave the address registry inconsistent.
 *
 * <p><b>Pre-flight checklist</b>:
 * <ol>
 *   <li>{@code .env.giwa-deployer} populated with
 *       {@code GIWA_DEPLOYER_PRIVATE_KEY} (gitignored — generate via
 *       {@code node scripts/gen-giwa-deployer.js})</li>
 *   <li>Deployer funded with GIWA Sepolia ETH — https://faucet.giwa.io/,
 *       or bridge Sepolia ETH through the OptimismPortal at
 *       {@code 0x956962C34687A954e611A83619ABaA37Ce6bC78A}. GIWA gas is
 *       ~0.001 gwei so 0.05 ETH is already generous.</li>
 *   <li>{@code addresses/91342.json} present (committed as a seed file)</li>
 * </ol>
 *
 * <p><b>Deploy order</b> (run each separately; every step is idempotent):
 * <pre>
 *   source .env.giwa-deployer
 *
 *   # 0. Preflight — chainId + signer + balance
 *   npx hardhat run scripts/probe-giwa.js          --network giwaSepolia
 *
 *   # 1. Base layer: SettingManagement, RUSD, FYP, FYUSD, USDT, USDC,
 *   #    FypherMinting. NOTE: unlike HOODI, FYUSD is OURS on GIWA.
 *   npx hardhat run scripts/deploy-giwa-phase0.js  --network giwaSepolia
 *
 *   # 2. Phase 1 (chain-generic, shared with HOODI): BurnQueue,
 *   #    EpochSettlement, StakingHub, YieldVault, CircuitBreaker.
 *   npx hardhat run scripts/deploy-phase1.js       --network giwaSepolia
 *
 *   # 3. Yield vaults (chain-generic): vFYUSD/vRUSD ERC-4626 +
 *   #    MockConcreteAdapter instances that stand in for Concrete.
 *   npx hardhat run scripts/deploy-yield-vaults.js --network giwaSepolia
 *
 *   # 4. GIWA-specific: FyusdTeller + reclaim FYUSD.minter + seed the
 *   #    Earn yield buffer. MUST run after step 2, which points the
 *   #    minter at FyusdEpochSettlement (correct on HOODI/mainnet, a
 *   #    dead end here).
 *   npx hardhat run scripts/deploy-giwa-teller.js  --network giwaSepolia
 *
 *   # 5. Verify everything on Blockscout (GASOK reviews the explorer).
 *   npx hardhat run scripts/verify-giwa.js         --network giwaSepolia
 * </pre>
 *
 * Usage of this entrypoint:
 *   npx hardhat run scripts/deploy-giwa.js --network giwaSepolia
 */
const { ethers } = require("hardhat");

const EXPECTED_CHAIN_ID = 91342;
/**
 * 0.001 ETH.
 *
 * Measured, not guessed: scripts/estimate-giwa-deploy-cost.js prices the full
 * sequence (18 contract deploys + ~40 wiring txs, L2 execution AND the OP Stack
 * L1 data fee) at ~0.000056 ETH on 2026-07-22. This floor is ~18x that, which
 * absorbs an L1 base-fee spike without demanding a faucet run the chain cannot
 * satisfy — the GIWA faucet dispenses 0.005 ETH, so an L1-sized threshold like
 * HOODI's 0.05 would block a deploy that is actually 89x funded.
 *
 * The point of the check is to catch "the faucet never landed" before a run
 * dies halfway and leaves the address registry half-written.
 */
const MIN_DEPLOYER_BALANCE_WEI = 1_000_000_000_000_000n;

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== EXPECTED_CHAIN_ID) {
    console.error(
      `\nERROR: deploy-giwa.js requires chainId ${EXPECTED_CHAIN_ID}, ` +
      `got ${chainId}. Re-run with --network giwaSepolia.\n`,
    );
    process.exit(1);
  }

  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    console.error(
      "\nERROR: no signer available. Set GIWA_DEPLOYER_PRIVATE_KEY in " +
      ".env.giwa-deployer (gitignored) — generate one with " +
      "`node scripts/gen-giwa-deployer.js`.\n",
    );
    process.exit(1);
  }
  const balance = await ethers.provider.getBalance(deployer.address);
  if (balance < MIN_DEPLOYER_BALANCE_WEI) {
    console.error(
      `\nERROR: deployer ${deployer.address} balance ${ethers.formatEther(balance)} ETH ` +
      `is below the ${ethers.formatEther(MIN_DEPLOYER_BALANCE_WEI)} ETH minimum.\n` +
      `Fund it at https://faucet.giwa.io/ or bridge Sepolia ETH via the\n` +
      `OptimismPortal 0x956962C34687A954e611A83619ABaA37Ce6bC78A, then re-run.\n`,
    );
    process.exit(1);
  }

  console.log("\n[deploy-giwa] preflight passed");
  console.log(`  chainId:  ${chainId} (GIWA Sepolia)`);
  console.log(`  deployer: ${deployer.address}`);
  console.log(`  balance:  ${ethers.formatEther(balance)} ETH`);
  console.log(`  explorer: https://sepolia-explorer.giwa.io/address/${deployer.address}`);
  console.log("");
  console.log("Next: run the stages in order. See the file header for the");
  console.log("full runbook. Quick reference:");
  console.log("");
  console.log("  npx hardhat run scripts/deploy-giwa-phase0.js  --network giwaSepolia");
  console.log("  npx hardhat run scripts/deploy-phase1.js       --network giwaSepolia");
  console.log("  npx hardhat run scripts/deploy-yield-vaults.js --network giwaSepolia");
  console.log("  npx hardhat run scripts/deploy-giwa-teller.js  --network giwaSepolia");
  console.log("  npx hardhat run scripts/verify-giwa.js         --network giwaSepolia");
  console.log("");
  console.log("GIWA has no BitGo and no Concrete — FYUSD is issued by our own");
  console.log("on-chain FyusdTeller and Earn yield comes from MockConcreteAdapter.");
  console.log("");
}

main().catch((err) => { console.error(err); process.exit(1); });
