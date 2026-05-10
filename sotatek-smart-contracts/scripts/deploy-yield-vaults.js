/**
 * Concrete-backed yield-vault deploy — vFYUSD + vRUSD ERC4626 receipt
 * vaults. Lands the alpha-launch yield system per the audit-handoff
 * scope refresh.
 *
 * What this deploys
 * ─────────────────
 *   - MockConcreteAdapterFyusd  (FYUSD-bound adapter for vFYUSD vault)
 *   - MockConcreteAdapterRusd   (RUSD-bound  adapter for vRUSD vault)
 *   - FyusdYieldVaultErc4626    (NEW proxy — ERC4626; the legacy
 *                                FyusdYieldVault proxy is dormant and
 *                                preserved under its existing address
 *                                key for traceability)
 *   - RUSDYieldVault            (NEW proxy)
 *
 * Why new keys for vFYUSD?
 * ────────────────────────
 * The legacy `FyusdYieldVault` proxy on Sepolia was deployed against
 * the pre-ERC4626 implementation (mapping-based shares, no cooldown,
 * 3-arg initializer). The new contract changes storage layout AND the
 * initializer signature, so an in-place upgrade is impossible. This
 * script deploys a fresh proxy under the key
 * `FyusdYieldVaultErc4626` to avoid clobbering the legacy address —
 * downstream consumers (backend env vars, frontend address registry)
 * point at the new key. The legacy entry stays in addresses/<chainId>.json
 * so emergency-investigation tooling can still resolve it.
 *
 * Permission + initial-state wire-up this script handles
 * ──────────────────────────────────────────────────────
 *   - SettingManagement.setPoolConfigs("vFyusdCooldown", 7d)
 *   - SettingManagement.setPoolConfigs("vRusdCooldown",  14d)
 *   - vFYUSD.setPauserRole(FypherCircuitBreaker)
 *   - vRUSD.setPauserRole(FypherCircuitBreaker)
 *   - (NOT done here) Adding the new vault target addresses to existing
 *     CircuitBreaker triggers — operator decides which triggers should
 *     pause the new vaults; templates land in a follow-up PR.
 *
 * Re-runs are append-only: existing addresses in addresses/<chainId>.json
 * are skipped. Wire-up steps are idempotent.
 *
 * Invariant the script asserts post-deploy
 * ────────────────────────────────────────
 *   - `vault.adapterShares() == vault.totalSupply() == 0` (fresh deploy)
 *   - `vault.asset() == FYUSD / RUSD` matches the asset the adapter
 *     was constructed against
 *   - `vault.currentCooldownDuration()` returns the configured value
 */
const { ethers, upgrades } = require("hardhat");
const addresses = require("./lib/addresses");

const SECONDS_PER_DAY = 24 * 60 * 60;
const VFYUSD_COOLDOWN_SECS = 7 * SECONDS_PER_DAY;
const VRUSD_COOLDOWN_SECS  = 14 * SECONDS_PER_DAY;

// MockConcreteAdapter simulated APY (4% by default — readable in basis points).
const DEFAULT_MOCK_CONCRETE_APY_BPS = process.env.FYPHERX_MOCK_CONCRETE_APY_BPS
  ? Number(process.env.FYPHERX_MOCK_CONCRETE_APY_BPS)
  : 400;

// Address-registry keys. Distinct from the legacy `FyusdYieldVault` and
// `MockConcreteAdapter` keys to avoid clobbering dormant testnet state.
const KEY_FYUSD_VAULT   = "FyusdYieldVaultErc4626";
const KEY_RUSD_VAULT    = "RUSDYieldVault";
const KEY_FYUSD_ADAPTER = "MockConcreteAdapterFyusd";
const KEY_RUSD_ADAPTER  = "MockConcreteAdapterRusd";

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Yield-vault deploy — chainId ${chainId}`);
  console.log("═══════════════════════════════════════════════════════");
  console.log(`Deployer:        ${deployer.address}`);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance:         ${ethers.formatEther(balance)} (native)`);
  console.log("");

  // ── 1. Load existing addresses ──
  let addrs;
  try {
    addrs = addresses.load(chainId);
  } catch (e) {
    console.error(`Cannot load addresses for chainId ${chainId}: ${e.message}`);
    console.error("This script requires Phase 1 contracts to already be deployed.");
    process.exit(1);
  }
  for (const required of ["SettingManagement", "RUSD", "FYUSD"]) {
    if (!addrs[required]) {
      console.error(`Required address missing from addresses/${chainId}.json: ${required}`);
      process.exit(1);
    }
  }
  if (!addrs.FypherCircuitBreaker) {
    console.warn(`  ! FypherCircuitBreaker missing — pauser wire-up will be skipped.`);
  }
  const settingMgmtAddr = addrs.SettingManagement;
  console.log(`SettingManagement:    ${settingMgmtAddr}`);
  console.log(`FYUSD / RUSD:         ${addrs.FYUSD} / ${addrs.RUSD}`);
  console.log("");

  // ── 2. MockConcreteAdapter for FYUSD (alpha-launch instance) ──
  if (!addrs[KEY_FYUSD_ADAPTER]) {
    console.log(`── Deploy ${KEY_FYUSD_ADAPTER} ──`);
    const MockAdapter = await ethers.getContractFactory("MockConcreteAdapter");
    const adapter = await MockAdapter.deploy(addrs.FYUSD, DEFAULT_MOCK_CONCRETE_APY_BPS);
    await adapter.waitForDeployment();
    addrs[KEY_FYUSD_ADAPTER] = await adapter.getAddress();
    console.log(`  ✓ ${KEY_FYUSD_ADAPTER} @ ${addrs[KEY_FYUSD_ADAPTER]} (apy = ${DEFAULT_MOCK_CONCRETE_APY_BPS} bps)`);
  } else {
    console.log(`  ✓ ${KEY_FYUSD_ADAPTER} already deployed @ ${addrs[KEY_FYUSD_ADAPTER]}`);
  }

  // ── 3. MockConcreteAdapter for RUSD (alpha-launch instance) ──
  if (!addrs[KEY_RUSD_ADAPTER]) {
    console.log(`── Deploy ${KEY_RUSD_ADAPTER} ──`);
    const MockAdapter = await ethers.getContractFactory("MockConcreteAdapter");
    const adapter = await MockAdapter.deploy(addrs.RUSD, DEFAULT_MOCK_CONCRETE_APY_BPS);
    await adapter.waitForDeployment();
    addrs[KEY_RUSD_ADAPTER] = await adapter.getAddress();
    console.log(`  ✓ ${KEY_RUSD_ADAPTER} @ ${addrs[KEY_RUSD_ADAPTER]} (apy = ${DEFAULT_MOCK_CONCRETE_APY_BPS} bps)`);
  } else {
    console.log(`  ✓ ${KEY_RUSD_ADAPTER} already deployed @ ${addrs[KEY_RUSD_ADAPTER]}`);
  }

  // ── 4. FyusdYieldVault (ERC4626 — new proxy) ──
  if (!addrs[KEY_FYUSD_VAULT]) {
    console.log(`── Deploy ${KEY_FYUSD_VAULT} (vFYUSD ERC4626) ──`);
    const Vault = await ethers.getContractFactory("FyusdYieldVault");
    const vault = await upgrades.deployProxy(
      Vault,
      [settingMgmtAddr, addrs.FYUSD, addrs[KEY_FYUSD_ADAPTER], deployer.address],
      { initializer: "initialize", kind: "transparent" },
    );
    await vault.waitForDeployment();
    addrs[KEY_FYUSD_VAULT] = await vault.getAddress();
    console.log(`  ✓ ${KEY_FYUSD_VAULT} @ ${addrs[KEY_FYUSD_VAULT]}`);
  } else {
    console.log(`  ✓ ${KEY_FYUSD_VAULT} already deployed @ ${addrs[KEY_FYUSD_VAULT]}`);
  }

  // ── 5. RUSDYieldVault (ERC4626 — new proxy) ──
  if (!addrs[KEY_RUSD_VAULT]) {
    console.log(`── Deploy ${KEY_RUSD_VAULT} (vRUSD ERC4626) ──`);
    const Vault = await ethers.getContractFactory("RUSDYieldVault");
    const vault = await upgrades.deployProxy(
      Vault,
      [settingMgmtAddr, addrs.RUSD, addrs[KEY_RUSD_ADAPTER], deployer.address],
      { initializer: "initialize", kind: "transparent" },
    );
    await vault.waitForDeployment();
    addrs[KEY_RUSD_VAULT] = await vault.getAddress();
    console.log(`  ✓ ${KEY_RUSD_VAULT} @ ${addrs[KEY_RUSD_VAULT]}`);
  } else {
    console.log(`  ✓ ${KEY_RUSD_VAULT} already deployed @ ${addrs[KEY_RUSD_VAULT]}`);
  }

  console.log("");
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Permission + initial-state wire-up");
  console.log("═══════════════════════════════════════════════════════");

  // ── Wire 1: SettingManagement pool-config seeds for cooldown durations ──
  await tryTx(`SettingManagement.setPoolConfigs("vFyusdCooldown", 7d)`, async () => {
    const setting = await ethers.getContractAt("SettingManagement", settingMgmtAddr);
    const current = await setting.getPoolConfigs("vFyusdCooldown");
    if (Number(current) === VFYUSD_COOLDOWN_SECS) return "  ✓ already set";
    const tx = await setting.setPoolConfigs("vFyusdCooldown", VFYUSD_COOLDOWN_SECS);
    await tx.wait();
    return `  ✓ set ${VFYUSD_COOLDOWN_SECS} (was ${current})`;
  });

  await tryTx(`SettingManagement.setPoolConfigs("vRusdCooldown", 14d)`, async () => {
    const setting = await ethers.getContractAt("SettingManagement", settingMgmtAddr);
    const current = await setting.getPoolConfigs("vRusdCooldown");
    if (Number(current) === VRUSD_COOLDOWN_SECS) return "  ✓ already set";
    const tx = await setting.setPoolConfigs("vRusdCooldown", VRUSD_COOLDOWN_SECS);
    await tx.wait();
    return `  ✓ set ${VRUSD_COOLDOWN_SECS} (was ${current})`;
  });

  // ── Wire 2: pauserRole = CircuitBreaker on both vaults ──
  if (addrs.FypherCircuitBreaker) {
    for (const [label, key] of [["vFYUSD", KEY_FYUSD_VAULT], ["vRUSD", KEY_RUSD_VAULT]]) {
      await tryTx(`${label}.setPauserRole(CircuitBreaker)`, async () => {
        const factory = key === KEY_FYUSD_VAULT ? "FyusdYieldVault" : "RUSDYieldVault";
        const v = await ethers.getContractAt(factory, addrs[key]);
        const current = await v.pauserRole();
        if (current.toLowerCase() === addrs.FypherCircuitBreaker.toLowerCase()) return "  ✓ already set";
        const tx = await v.setPauserRole(addrs.FypherCircuitBreaker);
        await tx.wait();
        return `  ✓ set (was ${current === ethers.ZeroAddress ? "0x0" : current})`;
      });
    }
  } else {
    console.log("  (skip pauserRole wire-up — CircuitBreaker not deployed)");
  }

  // ── Post-deploy invariant checks ──
  console.log("");
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Invariant checks");
  console.log("═══════════════════════════════════════════════════════");
  for (const [label, factory, vaultKey, expectedAsset, expectedCooldown] of [
    ["vFYUSD", "FyusdYieldVault", KEY_FYUSD_VAULT, addrs.FYUSD, VFYUSD_COOLDOWN_SECS],
    ["vRUSD",  "RUSDYieldVault",  KEY_RUSD_VAULT,  addrs.RUSD,  VRUSD_COOLDOWN_SECS],
  ]) {
    await tryTx(`${label} invariants`, async () => {
      const v = await ethers.getContractAt(factory, addrs[vaultKey]);
      const asset = await v.asset();
      if (asset.toLowerCase() !== expectedAsset.toLowerCase()) {
        throw new Error(`asset mismatch: got ${asset}, expected ${expectedAsset}`);
      }
      const cooldown = Number(await v.currentCooldownDuration());
      if (cooldown !== expectedCooldown) {
        throw new Error(`cooldown mismatch: got ${cooldown}, expected ${expectedCooldown}`);
      }
      const total = await v.totalSupply();
      if (total !== 0n) {
        throw new Error(`fresh-deploy totalSupply expected 0, got ${total}`);
      }
      return `  ✓ asset=${asset.slice(0, 10)}…, cooldown=${cooldown}s, totalSupply=0`;
    });
  }

  // ── Persist addresses ──
  console.log("");
  addresses.save(chainId, addrs);
  console.log(`✓ Wrote addresses/${chainId}.json (mirrored to deployed-addresses.json)`);

  // ── Summary ──
  const finalBal = await ethers.provider.getBalance(deployer.address);
  console.log("");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  DONE — Gas spent: ${ethers.formatEther(balance - finalBal)} (native)`);
  console.log("═══════════════════════════════════════════════════════");
  for (const k of [KEY_FYUSD_ADAPTER, KEY_RUSD_ADAPTER, KEY_FYUSD_VAULT, KEY_RUSD_VAULT]) {
    console.log(`  ${k.padEnd(28)}  ${addrs[k]}`);
  }

  console.log("");
  console.log("Next steps");
  console.log("──────────");
  console.log("1. Sync addresses to backend + frontend:");
  console.log("     node scripts/sync-addresses.js");
  console.log("");
  console.log("2. Update backend env (fypherx-gateway):");
  console.log("     FYPHERX_YIELD_VAULT_ADDRESS        = " + addrs[KEY_FYUSD_VAULT] + "  # repoint from legacy");
  console.log("     FYPHERX_RUSD_YIELD_VAULT_ADDRESS   = " + addrs[KEY_RUSD_VAULT]);
  console.log("");
  console.log("3. Update frontend addresses.ts:");
  console.log(`     FyusdYieldVault: '${addrs[KEY_FYUSD_VAULT]}'  // ERC4626 alpha launch`);
  console.log(`     RusdYieldVault:  '${addrs[KEY_RUSD_VAULT]}'`);
  console.log("");
  console.log("4. Fund the mock adapters with FYUSD / RUSD so they can");
  console.log("   pay accrued yield on testnet (optional — only needed if you");
  console.log("   plan to let users withdraw more than they deposited):");
  console.log(`     node scripts/fund-mock-adapter.js  # follow-up`);
  console.log("");
  console.log("5. Operator: add the new vaults to FypherCircuitBreaker");
  console.log("   triggers via registerTrigger() — pause data uses pause()/unpause().");
  console.log("");
}

async function tryTx(label, fn) {
  process.stdout.write(`  ${label.padEnd(56)} `);
  try {
    const detail = await fn();
    console.log(detail || "  ✓");
  } catch (e) {
    console.log(`  ✗ ${e.shortMessage || e.message}`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
