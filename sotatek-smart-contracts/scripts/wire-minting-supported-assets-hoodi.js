/**
 * One-shot wiring for HOODI {@code FypherMinting}:
 *
 *   1. {@code addSupportedAsset(USDT/USDC)} — every mint() gates on
 *      {@code supportedAssets[order.collateral_asset]}; missing rows
 *      revert with {@code UnsupportedAsset()} (selector 0x24a01144).
 *      The original Phase-1 wiring script forgot to do this on the
 *      mint engine (it only wired BurnQueue + EpochSettlement).
 *
 *   2. {@code setBackendSigner(GATEWAY_SIGNER)} — FypherMinting's
 *      EIP-712 verifier checks that the order signature came from
 *      {@code backendSigner}. The HOODI proxy was initialized with
 *      the deployer EOA as the signer, but the Spring gateway signs
 *      with {@code BACKEND_SIGNER_PRIVATE_KEY}
 *      (EOA {@code 0x31B60b11…cb4}) — same key for every chain. Without
 *      this fix every HOODI mint reverts with
 *      {@code InvalidSignature()} (selector 0x8baa579f).
 *
 * <p>Both steps are idempotent: the script reads current state and
 * skips if it already matches the target.
 *
 * Usage:
 *   source .env.hoodi-deployer
 *   GATEWAY_SIGNER=0x31B60b11533c97b5ED7b1B650D31855F3754Acb4 \
 *     npx hardhat run scripts/wire-minting-supported-assets-hoodi.js --network hoodi
 *
 * GATEWAY_SIGNER defaults to the dev cluster gateway's EOA; override
 * if rotating the key.
 */
const { ethers } = require("hardhat");
const addresses = require("./lib/addresses");

const EXPECTED_CHAIN_ID = 560048;

const ABI = [
  "function supportedAssets(address) view returns (bool)",
  "function addSupportedAsset(address asset) external",
  "function backendSigner() view returns (address)",
  "function setBackendSigner(address signer) external",
  "function custodianAddresses(address) view returns (bool)",
  "function addCustodianAddress(address custodian) external",
];

// Gateway EOA derived from BACKEND_SIGNER_PRIVATE_KEY in the Spring
// `fypherx-gateway-backend` env. Same key on every chain, so this is
// the address every FypherMinting deploy needs to register.
const DEFAULT_GATEWAY_SIGNER = "0x31B60b11533c97b5ED7b1B650D31855F3754Acb4";

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`requires chainId ${EXPECTED_CHAIN_ID}, got ${chainId}`);
  }

  const [deployer] = await ethers.getSigners();
  const addrs = addresses.load(chainId);

  console.log("════════════════════════════════════════════════════════");
  console.log("  HOODI: FypherMinting.addSupportedAsset(USDT/USDC)");
  console.log("════════════════════════════════════════════════════════");
  console.log(`  Deployer:       ${deployer.address}`);
  console.log(`  FypherMinting:  ${addrs.FypherMinting}`);
  console.log(`  USDT:           ${addrs.USDT}`);
  console.log(`  USDC:           ${addrs.USDC}`);
  console.log("");

  const minting = new ethers.Contract(addrs.FypherMinting, ABI, deployer);

  for (const [sym, asset] of [["USDT", addrs.USDT], ["USDC", addrs.USDC]]) {
    const already = await minting.supportedAssets(asset);
    if (already) {
      console.log(`  ✓ ${sym} (${asset}) already supported — skip`);
      continue;
    }
    console.log(`── addSupportedAsset(${sym}) ──`);
    const tx = await minting.addSupportedAsset(asset);
    console.log(`     tx: ${tx.hash}`);
    await tx.wait();
    // Public RPCs (publicnode et al.) propagate state with a small lag
    // — an eth_call immediately after tx.wait() can hit a node that
    // hasn't applied the receipt yet. Poll up to ~10s before failing.
    let after = false;
    for (let i = 0; i < 5; i++) {
      after = await minting.supportedAssets(asset);
      if (after) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!after) throw new Error(`POST-CHECK FAIL: ${sym} still not supported after retries`);
    console.log(`     ✓ ${sym} now supported`);
  }

  // ── 2. Backend signer ─────────────────────────────────────────
  const targetSigner = process.env.GATEWAY_SIGNER || DEFAULT_GATEWAY_SIGNER;
  const currentSigner = await minting.backendSigner();
  console.log(`\n── backendSigner check ──`);
  console.log(`     current : ${currentSigner}`);
  console.log(`     target  : ${targetSigner}`);
  if (currentSigner.toLowerCase() === targetSigner.toLowerCase()) {
    console.log(`     ✓ already matches — skip`);
  } else {
    console.log(`── setBackendSigner(${targetSigner}) ──`);
    const tx = await minting.setBackendSigner(targetSigner);
    console.log(`     tx: ${tx.hash}`);
    await tx.wait();
    let after = currentSigner;
    for (let i = 0; i < 5; i++) {
      after = await minting.backendSigner();
      if (after.toLowerCase() === targetSigner.toLowerCase()) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (after.toLowerCase() !== targetSigner.toLowerCase()) {
      throw new Error(`POST-CHECK FAIL: backendSigner is ${after}, expected ${targetSigner}`);
    }
    console.log(`     ✓ backendSigner now = ${after}`);
  }

  // ── 3. Custodian registration ─────────────────────────────────
  // The mint() route must transfer collateral to a registered
  // custodian. Sepolia uses ReservePool (0xec104708…7e8c) as its
  // custodian; HOODI doesn't have ReservePool deployed, so for the
  // dev-cluster integration we register the deployer EOA. Production
  // mainnet deploy will register a real ReservePool address instead
  // (and update the gateway ConfigMap to match).
  const targetCustodian = process.env.GATEWAY_CUSTODIAN || deployer.address;
  const isCustodian = await minting.custodianAddresses(targetCustodian);
  console.log(`\n── custodian check ──`);
  console.log(`     target custodian: ${targetCustodian}`);
  if (isCustodian) {
    console.log(`     ✓ already registered — skip`);
  } else {
    console.log(`── addCustodianAddress(${targetCustodian}) ──`);
    const tx = await minting.addCustodianAddress(targetCustodian);
    console.log(`     tx: ${tx.hash}`);
    await tx.wait();
    let after = false;
    for (let i = 0; i < 5; i++) {
      after = await minting.custodianAddresses(targetCustodian);
      if (after) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!after) throw new Error(`POST-CHECK FAIL: ${targetCustodian} not registered as custodian`);
    console.log(`     ✓ ${targetCustodian} now registered as custodian`);
  }

  console.log("");
  console.log("✓ Done. Next:");
  console.log(`    - update fypherx-chain-config ConfigMap: FYPHERX_RESERVE_POOL_ADDRESS=${targetCustodian}`);
  console.log("    - kubectl rollout restart deployment fypherx-gateway-backend");
  console.log("    - re-run /api/v1/defi/mint/sign and submit the mint() — should succeed");
}

main().catch((e) => { console.error(e); process.exit(1); });
