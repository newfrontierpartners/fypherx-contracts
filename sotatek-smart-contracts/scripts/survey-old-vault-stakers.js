/**
 * Survey existing stakers in the legacy StakedRUSD + stAUSD vaults
 * to plan the migration into FypherStakingHub (S1.4) per
 * ADR-003 §"Migration mechanics".
 *
 * Why this is read-only
 * ─────────────────────
 * StakedRUSD + stAUSD are standard ERC4626-style vaults; they do
 * NOT expose an admin-driven "migrate everyone out" function. The
 * ADR-003 B-4-A path described an idealised flow with a
 * `migrationLocked` flag + admin redeem helper — those would
 * require a contract upgrade on the legacy vaults, which is out
 * of Phase 1 scope.
 *
 * What's left as the practical operator path:
 *   1. Survey current stakers (this script — outputs CSV)
 *   2. Announce deprecation of /staking/{stake} on the customer UI
 *      pointing legacy stakers at /staking/withdraw to redeem
 *      their old shares for the underlying RUSD/FYUSD
 *   3. Once legacy TVL drops below dust threshold, stake the
 *      remaining underlying out via admin (using the existing
 *      ERC4626 redeem path with admin's own shares — which
 *      requires admin to actually hold those shares; if not,
 *      legacy positions stay until the user manually exits)
 *   4. New FypherStakingHub goes live in parallel — stakers move
 *      naturally on their own cadence
 *
 * Output
 * ──────
 * Prints a CSV-like table to stdout (one row per staker) and a
 * summary tile (total shares, total assets, holder count). Pipe to
 * a file for ops review:
 *
 *   npx hardhat run scripts/survey-old-vault-stakers.js \
 *     --network bscTestnet > stakers.csv
 *
 * Implementation
 * ──────────────
 * Uses an event-log scan over Transfer events to enumerate
 * historical share-holders, then filters to current non-zero
 * balances. Block scan window starts at SCAN_FROM_BLOCK_DEFAULT
 * (env-overridable) — pre-Stage-4 deploys started ~22M blocks ago
 * on BSC Testnet, so the default window is generous. RPC pages
 * the eth_getLogs in 4500-block chunks to stay under public
 * BSC-Testnet limits.
 */
const { ethers } = require("hardhat");
const addresses = require("./lib/addresses");

const SCAN_FROM_BLOCK_DEFAULT = process.env.FYPHERX_VAULT_SURVEY_FROM_BLOCK
  ? Number(process.env.FYPHERX_VAULT_SURVEY_FROM_BLOCK)
  : 0;
const LOG_PAGE_SIZE = 4_500;

// ABI fragments — the only reads we need.
const ERC4626_ABI = [
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function asset() view returns (address)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const addrs = addresses.load(chainId);

  console.error(`# Vault staker survey — chainId ${chainId}`);
  console.error(`# Generated: ${new Date().toISOString()}`);
  console.error("");

  for (const [label, key] of [
    ["StakedRUSD", "StakedRUSD"],
    ["stAUSD",     "stAUSD"],
  ]) {
    const addr = addrs[key];
    if (!addr) {
      console.error(`# ${label} — address missing from addresses/${chainId}.json (skipped)`);
      continue;
    }
    await surveyOne(label, addr);
    console.error("");
  }

  console.error("# Operator runbook");
  console.error("# ─────────────────");
  console.error("# 1. Review the CSV above + decide:");
  console.error("#    - migrate small TVL: announce deprecation, let users self-withdraw");
  console.error("#    - migrate large TVL: deploy a one-off MigrationHelper contract");
  console.error("#      that holds admin role on the legacy vaults + can redeem on");
  console.error("#      behalf of named addresses (out of Phase 1 scope, separate PR).");
  console.error("# 2. New FypherStakingHub goes live in parallel — admin can announce");
  console.error("#    /staking on the customer UI now points at the new hub.");
  console.error("# 3. After cutover, periodically re-run this script to track legacy");
  console.error("#    TVL drift; close the loop when it falls below the dust threshold.");
}

async function surveyOne(label, vaultAddr) {
  const v = await ethers.getContractAt(ERC4626_ABI, vaultAddr);
  let totalShares, totalAssetsRaw, dec;
  try {
    [totalShares, totalAssetsRaw, dec] = await Promise.all([
      v.totalSupply(),
      v.totalAssets(),
      v.decimals(),
    ]);
  } catch (e) {
    console.error(`# ${label} (${vaultAddr}) — read failed: ${e.shortMessage || e.message}`);
    return;
  }

  console.error(`# ── ${label} (${vaultAddr}) ──`);
  console.error(`# totalShares:  ${ethers.formatUnits(totalShares, dec)}`);
  console.error(`# totalAssets:  ${ethers.formatUnits(totalAssetsRaw, dec)}`);

  if (totalShares === 0n) {
    console.error("# (no holders — nothing to migrate)");
    return;
  }

  // Scan Transfer events to enumerate historical share-holders.
  const provider = ethers.provider;
  const head = await provider.getBlockNumber();
  const transferTopic = ethers.id("Transfer(address,address,uint256)");
  const ZERO_TOPIC = "0x" + "0".repeat(64);

  const candidates = new Set();
  for (let from = SCAN_FROM_BLOCK_DEFAULT; from <= head; from += LOG_PAGE_SIZE) {
    const to = Math.min(from + LOG_PAGE_SIZE - 1, head);
    let logs = [];
    try {
      logs = await provider.getLogs({
        address: vaultAddr,
        topics: [transferTopic],
        fromBlock: from,
        toBlock: to,
      });
    } catch (e) {
      console.error(`#   eth_getLogs ${from}..${to} failed (${e.shortMessage || e.message}) — skipping page`);
      continue;
    }
    for (const log of logs) {
      // Mint = from(0x0) -> to(holder); Burn = to(0x0); Transfer = both real.
      const fromAddr = "0x" + log.topics[1].slice(26);
      const toAddr   = "0x" + log.topics[2].slice(26);
      if (log.topics[1] !== ZERO_TOPIC) candidates.add(ethers.getAddress(fromAddr));
      if (log.topics[2] !== ZERO_TOPIC) candidates.add(ethers.getAddress(toAddr));
    }
  }

  // Filter to current non-zero holders + emit CSV row.
  console.error(`# scanned ${candidates.size} historical participant address(es)`);
  // Header row to stdout (CSV).
  console.log(`vault,holder,shares,assets`);
  let liveHolders = 0;
  let totalShareSum = 0n;
  for (const addr of candidates) {
    let bal;
    try { bal = await v.balanceOf(addr); } catch { continue; }
    if (bal === 0n) continue;
    let assets = 0n;
    try { assets = await v.convertToAssets(bal); } catch {}
    console.log([
      label,
      addr,
      ethers.formatUnits(bal, dec),
      ethers.formatUnits(assets, dec),
    ].join(","));
    liveHolders += 1;
    totalShareSum += bal;
  }
  console.error(`# ${liveHolders} live holder(s); aggregate shares ${ethers.formatUnits(totalShareSum, dec)} (sanity vs totalSupply ${ethers.formatUnits(totalShares, dec)})`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
