/**
 * deploy-concrete-adapter-hoodi.js — deploy the REAL Concrete adapter on HOODI.
 *
 * Closes the gap flagged in deploy-hoodi.js:48 ("ConcreteAdapterV1 — once
 * Concrete shares the test vault address. Single script (TBD)."). The Solidity
 * (ConcreteAdapterV1.sol) is implemented + tested; the only missing inputs were
 * (a) a real Concrete Earn V2 ERC-4626 vault address and (b) this script.
 *
 * What it does
 * ────────────
 *   1. Pre-flight: assert the supplied Concrete vault's asset() == our FYUSD
 *      (same check ConcreteAdapterV1's constructor enforces — caught here so a
 *      wrong vault fails BEFORE spending deploy gas).
 *   2. Deploy ConcreteAdapterV1(FYUSD, concreteVault, FyusdYieldVaultErc4626).
 *   3. Record ConcreteAdapterV1 + ConcreteTestVault in addresses/560048.json.
 *
 * What it deliberately does NOT do (these are separate, gated steps — see the
 * runbook this prints at the end):
 *   - It does NOT call FyusdYieldVault.setAdapter(). That is onlyAdmin AND
 *     reverts AdapterStillHoldsShares unless the CURRENT (mock) adapter holds
 *     zero vault shares — i.e. every existing depositor must first exit through
 *     the 7-day cooldown. Flipping the adapter under live deposits is an
 *     operational decision, not a deploy step.
 *   - It does NOT whitelist the adapter in Concrete's Earn V2 Hook system. The
 *     address that must be whitelisted is THIS adapter (not the vault); that is
 *     a Concrete-side coordination step.
 *
 * Usage:
 *   source .env.hoodi-deployer
 *   CONCRETE_VAULT_ADDRESS=0x<real Concrete Earn V2 FYUSD vault> \
 *     npx hardhat run scripts/deploy-concrete-adapter-hoodi.js --network hoodi
 *
 * Optional overrides:
 *   FYUSD_ADDRESS / YIELD_VAULT_ADDRESS  (default: from addresses/560048.json)
 */
const { ethers } = require("hardhat");
const addresses = require("./lib/addresses");

const EXPECTED_CHAIN_ID = 560048;

const ERC4626_ABI = [
  "function asset() view returns (address)",
];

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`requires chainId ${EXPECTED_CHAIN_ID} (HOODI), got ${chainId}`);
  }
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No signer — `source .env.hoodi-deployer` first?");

  const addrs = addresses.load(chainId);
  const FYUSD      = process.env.FYUSD_ADDRESS       || addrs.FYUSD;
  const YIELD_VAULT = process.env.YIELD_VAULT_ADDRESS || addrs.FyusdYieldVaultErc4626;
  const CONCRETE   = process.env.CONCRETE_VAULT_ADDRESS;

  if (!CONCRETE || !ethers.isAddress(CONCRETE)) {
    throw new Error(
      "CONCRETE_VAULT_ADDRESS env must be the real Concrete Earn V2 ERC-4626 FYUSD vault. " +
      "This is the one input you must obtain from Concrete (the slot in 560048.json is blank).");
  }
  if (!FYUSD || !ethers.isAddress(FYUSD)) throw new Error("FYUSD address missing/invalid");
  if (!YIELD_VAULT || !ethers.isAddress(YIELD_VAULT)) {
    throw new Error("FyusdYieldVaultErc4626 address missing/invalid in addresses/560048.json");
  }

  console.log("Deployer:            ", deployer.address);
  console.log("FYUSD:               ", FYUSD);
  console.log("Concrete vault:      ", CONCRETE);
  console.log("FyusdYieldVault (vault arg):", YIELD_VAULT);

  // ── Pre-flight: asset() must equal FYUSD (constructor enforces this; fail
  //    here BEFORE spending deploy gas, with a clearer message). ──
  const concrete = new ethers.Contract(CONCRETE, ERC4626_ABI, deployer);
  let concreteAsset;
  try {
    concreteAsset = await concrete.asset();
  } catch (e) {
    throw new Error(
      `Could not read asset() on the Concrete vault ${CONCRETE} — is it a standard ERC-4626? (${e.message})`);
  }
  if (concreteAsset.toLowerCase() !== FYUSD.toLowerCase()) {
    throw new Error(
      `Concrete vault asset() = ${concreteAsset} but our FYUSD = ${FYUSD}. ` +
      `The adapter constructor would revert AdapterAssetMismatch. Confirm Concrete deployed the vault against OUR FYUSD.`);
  }
  console.log("✅ pre-flight: Concrete vault asset() == FYUSD");

  // ── Deploy ──
  const Adapter = await ethers.getContractFactory("ConcreteAdapterV1");
  const adapter = await Adapter.deploy(FYUSD, CONCRETE, YIELD_VAULT);
  await adapter.waitForDeployment();
  const adapterAddr = await adapter.getAddress();
  console.log("✅ ConcreteAdapterV1 deployed:", adapterAddr);

  addrs.ConcreteAdapterV1 = adapterAddr;
  addrs.ConcreteTestVault = CONCRETE;
  addresses.save(chainId, addrs);
  console.log(`✓ Wrote addresses/${chainId}.json (ConcreteAdapterV1 + ConcreteTestVault)`);

  console.log("\n──────────────── NEXT (NOT done by this script) ────────────────");
  console.log("1. Concrete whitelists THIS adapter address in their Earn V2 Hook:");
  console.log(`     ${adapterAddr}`);
  console.log("2. Drain the CURRENT (mock) adapter to zero vault shares — every");
  console.log("   existing vFYUSD depositor must exit through the 7-day cooldown,");
  console.log("   else FyusdYieldVault.setAdapter reverts AdapterStillHoldsShares.");
  console.log("3. Admin flips the adapter (onlyAdmin / Safe in safe-propose mode):");
  console.log("     POST /api/admin/defi/vaults/fyusd/set-adapter  { adapter: \"" + adapterAddr + "\" }");
  console.log("   (or call FyusdYieldVault.setAdapter directly from the admin/Safe).");
  console.log("4. Confirm Concrete is STANDARD (atomic) withdrawal mode, not async/");
  console.log("   epoch-batched — the adapter assumes atomic withdraw.");
  console.log("────────────────────────────────────────────────────────────────");
}

main().catch((e) => { console.error(e); process.exit(1); });
