/**
 * Bootstrap the FypherStakingHub FPY treasury so claim() doesn't
 * revert InsufficientFpy on day one.
 *
 * What this does
 * ──────────────
 *   1. Read deployer's current FYP balance.
 *   2. If less than the bootstrap target, log a hint about the FYP
 *      mint path (FYP token's own minter operation, separate from
 *      this script — operator decision who holds it).
 *   3. Approve StakingHub to pull `targetWei` FYP from the deployer.
 *   4. Call `hub.fundFpy(targetWei)` which safeTransferFrom's into
 *      the hub and emits FpyFunded.
 *
 * Re-run safe — calling fundFpy multiple times just stacks the
 * treasury. To sanity-check post-deploy, the script prints the hub's
 * resulting FYP balance.
 *
 * Sizing rationale (default 100,000 FYP @ 18 decimals)
 * ────────────────────────────────────────────────────
 * fpyPerBlock default in deploy-phase1.js is 0.01 FYP/block. BSC
 * block time ~3s → 28,800 blocks/day → 288 FYP/day emission across
 * both pools combined. 100k FYP covers ~347 days of solo emission;
 * with 50% claim cadence it covers ~2 years. Plenty of runway for
 * Phase 1 testnet.
 *
 * Mainnet should use a much smaller bootstrap (or fund from the
 * tokenomics treasury directly via Safe), since real FYP supply
 * decisions are governance-controlled, not operator-controlled.
 *
 * Usage
 * ─────
 *   npx hardhat run scripts/bootstrap-fpy-treasury.js --network bscTestnet
 *
 * Optional env:
 *   FYPHERX_FPY_BOOTSTRAP_WEI  override the default 100_000 * 1e18
 */
const { ethers } = require("hardhat");
const addresses = require("./lib/addresses");

const ONE = 10n ** 18n;
const DEFAULT_TARGET = (process.env.FYPHERX_FPY_BOOTSTRAP_WEI
  ? BigInt(process.env.FYPHERX_FPY_BOOTSTRAP_WEI)
  : 100_000n * ONE);

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  console.log("═══════════════════════════════════════════════════════");
  console.log(`  StakingHub FPY treasury bootstrap — chainId ${chainId}`);
  console.log("═══════════════════════════════════════════════════════");
  console.log(`Deployer:        ${deployer.address}`);
  console.log(`Target funding:  ${ethers.formatUnits(DEFAULT_TARGET, 18)} FYP`);

  const addrs = addresses.load(chainId);
  if (!addrs.FypherStakingHub) throw new Error(`addresses/${chainId}.json missing FypherStakingHub`);
  if (!addrs.FYP)              throw new Error(`addresses/${chainId}.json missing FYP`);
  console.log(`Hub:             ${addrs.FypherStakingHub}`);
  console.log(`FYP:             ${addrs.FYP}\n`);

  const fyp = await ethers.getContractAt(
    [
      "function balanceOf(address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)",
      "function allowance(address,address) view returns (uint256)",
      "function decimals() view returns (uint8)",
    ],
    addrs.FYP,
  );
  const hub = await ethers.getContractAt("FypherStakingHub", addrs.FypherStakingHub);

  const balance   = await fyp.balanceOf(deployer.address);
  const decimals  = await fyp.decimals();
  const hubBefore = await fyp.balanceOf(addrs.FypherStakingHub);

  console.log(`Deployer FYP balance:  ${ethers.formatUnits(balance, decimals)}`);
  console.log(`Hub FYP balance:       ${ethers.formatUnits(hubBefore, decimals)}\n`);

  if (balance < DEFAULT_TARGET) {
    console.log(`⚠ Deployer doesn't hold enough FYP to fund target.`);
    console.log(`  Need ${ethers.formatUnits(DEFAULT_TARGET, decimals)}, have ${ethers.formatUnits(balance, decimals)}.`);
    console.log(`  Mint or transfer FYP to ${deployer.address} first, then re-run.`);
    console.log(`  (FYP minter is set in the FYP contract owner; check current setup.)`);
    process.exit(1);
  }

  // ── Approve hub for the target amount ──
  const allowance = await fyp.allowance(deployer.address, addrs.FypherStakingHub);
  if (allowance < DEFAULT_TARGET) {
    console.log(`── approve(StakingHub, ${ethers.formatUnits(DEFAULT_TARGET, decimals)} FYP) ──`);
    const tx = await fyp.approve(addrs.FypherStakingHub, DEFAULT_TARGET);
    await tx.wait();
    console.log(`  ✓ approved (tx: ${tx.hash})`);
  } else {
    console.log(`  ✓ allowance already sufficient (${ethers.formatUnits(allowance, decimals)} FYP)`);
  }

  // ── fundFpy ──
  console.log("");
  console.log(`── hub.fundFpy(${ethers.formatUnits(DEFAULT_TARGET, decimals)} FYP) ──`);
  const fundTx = await hub.fundFpy(DEFAULT_TARGET);
  await fundTx.wait();
  console.log(`  ✓ funded (tx: ${fundTx.hash})`);

  const hubAfter = await fyp.balanceOf(addrs.FypherStakingHub);
  console.log(`  ✓ Hub FYP balance now:  ${ethers.formatUnits(hubAfter, decimals)}`);
  console.log(`  ✓ Delta:                +${ethers.formatUnits(hubAfter - hubBefore, decimals)}`);

  console.log("");
  console.log("═══════════════════════════════════════════════════════");
  console.log("  DONE");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Hub FYP treasury:  ${ethers.formatUnits(hubAfter, decimals)} FYP`);
  console.log("");
  console.log("Next steps");
  console.log("──────────");
  console.log("- Stakers can now call hub.claim(poolId) without InsufficientFpy.");
  console.log("- Periodic top-ups: re-run this script as needed; the hub's");
  console.log("  outstandingLiability isn't a hard accounting figure (no on-chain");
  console.log("  enforcement of treasury-vs-emission ratio yet — that lands when");
  console.log("  the FPY emission treasury contract per spec §4.1 ships).");
  console.log("");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
