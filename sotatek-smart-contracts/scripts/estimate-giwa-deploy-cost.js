/**
 * Measure what the full GIWA deploy actually costs, before spending anything.
 *
 * <p>GIWA is an OP Stack rollup, so a transaction is billed twice:
 * <ul>
 *   <li><b>L2 execution</b> — gasUsed x L2 gas price. Cheap here (~0.001 gwei).</li>
 *   <li><b>L1 data fee</b> — the cost of posting the transaction's bytes to
 *       Ethereum, quoted by the {@code GasPriceOracle} predeploy at
 *       {@code 0x420...0F}. For contract <em>deployments</em> this usually
 *       DOMINATES, because the whole creation bytecode goes on L1.</li>
 * </ul>
 * A naive L1-style estimate (gasUsed x gasPrice) therefore understates a
 * rollup deploy badly, which is exactly the mistake that leaves a deploy
 * stranded halfway with a half-written address registry.
 *
 * <p>Reads compiled artifacts, so run {@code npx hardhat compile} first.
 * Sends nothing and needs no funded account.
 *
 * Usage:
 *   npx hardhat run scripts/estimate-giwa-deploy-cost.js --network giwaSepolia
 */
const { ethers } = require("hardhat");

const GAS_PRICE_ORACLE = "0x420000000000000000000000000000000000000F";
const ORACLE_ABI = [
  "function getL1Fee(bytes _data) view returns (uint256)",
  "function l1BaseFee() view returns (uint256)",
];

/**
 * Every contract the runbook deploys.
 *
 * `proxy: true` means OZ's upgrades plugin deploys an implementation PLUS a
 * TransparentUpgradeableProxy (and, once per chain, a ProxyAdmin) — so the
 * on-chain footprint is the implementation bytecode plus the proxy's, not just
 * the implementation's. Counting only the implementation is the easy way to
 * under-budget by ~40%.
 */
const PLAN = [
  // deploy-giwa-phase0.js
  { name: "SettingManagement", proxy: true },
  { name: "RUSD", proxy: true },
  { name: "FYP", proxy: true },
  { name: "FYUSD", proxy: true },
  { name: "MockERC20", proxy: false, label: "USDT" },
  { name: "MockERC20", proxy: false, label: "USDC" },
  { name: "FypherMinting", proxy: true },
  // deploy-phase1.js
  { name: "MockConcreteAdapter", proxy: false },
  { name: "FypherBurnQueue", proxy: true },
  { name: "FyusdEpochSettlement", proxy: true },
  { name: "FypherStakingHub", proxy: true },
  { name: "FyusdYieldVault", proxy: true, label: "FyusdYieldVault (phase1)" },
  { name: "FypherCircuitBreaker", proxy: true },
  // deploy-yield-vaults.js
  { name: "MockConcreteAdapter", proxy: false, label: "MockConcreteAdapterFyusd" },
  { name: "MockConcreteAdapter", proxy: false, label: "MockConcreteAdapterRusd" },
  { name: "FyusdYieldVault", proxy: true, label: "FyusdYieldVaultErc4626" },
  { name: "RUSDYieldVault", proxy: true },
  // deploy-giwa-teller.js
  { name: "FyusdTeller", proxy: false },
];

/** Rough count of the admin/wiring transactions the scripts send after deploys. */
const WIRING_TX_COUNT = 40;
/** A wiring call is a small setter: ~60k L2 gas, ~200 bytes of calldata. */
const WIRING_L2_GAS = 60_000n;
const WIRING_CALLDATA_BYTES = 200;

function fmt(wei) {
  return `${ethers.formatEther(wei).padStart(12)} ETH`;
}

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== 91342) {
    console.error(`Requires chainId 91342 (GIWA Sepolia), got ${chainId}.`);
    process.exit(1);
  }

  const feeData = await ethers.provider.getFeeData();
  const l2GasPrice = feeData.gasPrice ?? 1_000_000n;
  const oracle = new ethers.Contract(GAS_PRICE_ORACLE, ORACLE_ABI, ethers.provider);

  let l1BaseFee = 0n;
  try {
    l1BaseFee = await oracle.l1BaseFee();
  } catch {
    /* informational only */
  }

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  GIWA Sepolia — full deploy cost estimate");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  L2 gas price : ${l2GasPrice} wei (${Number(l2GasPrice) / 1e9} gwei)`);
  if (l1BaseFee > 0n) {
    console.log(`  L1 base fee  : ${l1BaseFee} wei (${(Number(l1BaseFee) / 1e9).toFixed(3)} gwei)`);
  }
  console.log("");
  console.log(
    "  contract".padEnd(34) + "bytes".padStart(8) + "L2 cost".padStart(16) + "L1 cost".padStart(16),
  );
  console.log("  " + "─".repeat(72));

  // The proxy pair OZ deploys alongside each upgradeable implementation.
  // Sizes come from the compiled artifacts when present; the fallbacks are the
  // well-known OZ v5 sizes, used only so a missing artifact degrades to a
  // slightly-off number instead of crashing the estimate.
  let proxyBytes = 0;
  try {
    const proxyArtifact = await ethers.getContractFactory(
      "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy",
    );
    proxyBytes = ethers.getBytes(proxyArtifact.bytecode).length;
  } catch {
    proxyBytes = 4_500; // OZ v5 TransparentUpgradeableProxy + ProxyAdmin, approx
  }

  let totalL2 = 0n;
  let totalL1 = 0n;
  let totalBytes = 0;

  for (const item of PLAN) {
    let factory;
    try {
      factory = await ethers.getContractFactory(item.name);
    } catch (e) {
      console.log(`  ${(item.label || item.name).padEnd(32)}  [artifact missing — skipped]`);
      continue;
    }

    // Creation bytecode is what actually gets posted to L1. Constructor args
    // add a little; they are small relative to bytecode, so bytecode alone is
    // a good proxy and keeps this script free of per-contract arg wiring.
    const data = factory.bytecode;
    const bytes = ethers.getBytes(data).length + (item.proxy ? proxyBytes : 0);

    // L2 execution: deployment gas tracks bytecode size closely (200 gas per
    // stored byte plus execution), so approximate rather than eth_estimateGas
    // — several of these constructors revert without their real arguments,
    // which would abort the estimate for reasons unrelated to cost.
    const l2Gas = BigInt(bytes) * 210n + 100_000n;
    const l2Cost = l2Gas * l2GasPrice;

    let l1Cost = 0n;
    try {
      l1Cost = await oracle.getL1Fee(data);
      if (item.proxy) {
        // Charge the proxy's bytes too, scaled from the implementation's rate.
        l1Cost = (l1Cost * BigInt(bytes)) / BigInt(ethers.getBytes(data).length);
      }
    } catch {
      l1Cost = 0n;
    }

    totalL2 += l2Cost;
    totalL1 += l1Cost;
    totalBytes += bytes;

    console.log(
      "  " +
        (item.label || item.name).padEnd(32) +
        String(bytes).padStart(8) +
        ethers.formatEther(l2Cost).slice(0, 14).padStart(16) +
        ethers.formatEther(l1Cost).slice(0, 14).padStart(16),
    );
  }

  // Wiring transactions (setMinter, setSupportedAsset, addPool, ...).
  const wiringL2 = WIRING_L2_GAS * BigInt(WIRING_TX_COUNT) * l2GasPrice;
  let wiringL1 = 0n;
  try {
    const sample = "0x" + "ab".repeat(WIRING_CALLDATA_BYTES);
    wiringL1 = (await oracle.getL1Fee(sample)) * BigInt(WIRING_TX_COUNT);
  } catch {
    /* leave at 0 */
  }
  console.log("  " + "─".repeat(72));
  console.log(
    "  " +
      `wiring txs (x${WIRING_TX_COUNT})`.padEnd(32) +
      String(WIRING_CALLDATA_BYTES * WIRING_TX_COUNT).padStart(8) +
      ethers.formatEther(wiringL2).slice(0, 14).padStart(16) +
      ethers.formatEther(wiringL1).slice(0, 14).padStart(16),
  );

  totalL2 += wiringL2;
  totalL1 += wiringL1;

  const total = totalL2 + totalL1;
  // Deploys run over minutes; L1 base fee moves. 3x covers a spike without
  // pretending to be precise.
  const withMargin = total * 3n;

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  L2 execution total : ${fmt(totalL2)}`);
  console.log(`  L1 data fee total  : ${fmt(totalL1)}`);
  console.log(`  ESTIMATED TOTAL    : ${fmt(total)}`);
  console.log(`  with 3x margin     : ${fmt(withMargin)}`);
  console.log("═══════════════════════════════════════════════════════════════");

  const [signer] = await ethers.getSigners();
  if (signer) {
    const balance = await ethers.provider.getBalance(signer.address);
    console.log(`  deployer balance   : ${fmt(balance)}  (${signer.address})`);
    if (balance >= withMargin) {
      console.log(`\n  SUFFICIENT — ${(Number(balance) / Number(total)).toFixed(0)}x the estimate.\n`);
    } else if (balance >= total) {
      console.log(`\n  TIGHT — covers the estimate but not the 3x margin. Top up if you can.\n`);
    } else {
      console.log(`\n  INSUFFICIENT — need at least ${fmt(total)}.\n`);
      process.exit(1);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
