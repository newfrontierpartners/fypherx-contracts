/**
 * Align backend signer / executor roles on every HOODI contract that
 * the gateway writes to. The Phase-0/1 deploy initialised every
 * contract with the deployer EOA in both slots, but the gateway in
 * production uses two SEPARATE keys:
 *
 *   - {@code BACKEND_SIGNER_PRIVATE_KEY}        → off-chain EIP-712 signing
 *     (mint orders, burn quotes, FYUSD epoch deposit quotes).
 *     Derived EOA: 0x31B60b11533c97b5ED7b1B650D31855F3754Acb4.
 *
 *   - {@code BACKEND_GAS_RELAYER_PRIVATE_KEY}   → on-chain admin tx
 *     submitter (gateway gas relayer). Derived EOA:
 *     0x5fA4e48f27CfE353E077a78962e2b578f72B1b97.
 *
 * Without this, every admin epoch lock/settle/distribute call from the
 * admin dashboard reverts with {@code NotExecutor()}, and the customer
 * mint/burn/epoch-deposit flows (which look up backendSigner during
 * EIP-712 verification) revert with {@code InvalidSignature()}.
 *
 * Idempotent: each setter is gated on a prior read.
 *
 * Usage:
 *   source .env.hoodi-deployer
 *   npx hardhat run scripts/wire-backend-roles-hoodi.js --network hoodi
 *
 * Override defaults (e.g. when the gateway rotates keys):
 *   GATEWAY_SIGNER=0x... GATEWAY_GAS_RELAYER=0x... npx hardhat run …
 */
const { ethers } = require("hardhat");
const addresses  = require("./lib/addresses");

const EXPECTED_CHAIN_ID = 560048;

const DEFAULT_SIGNER       = "0x31B60b11533c97b5ED7b1B650D31855F3754Acb4";
const DEFAULT_GAS_RELAYER  = "0x5fA4e48f27CfE353E077a78962e2b578f72B1b97";

const ABI = [
  "function backendSigner()    view    returns (address)",
  "function backendExecutor()  view    returns (address)",
  "function setBackendSigner(address)  external",
  "function setBackendExecutor(address) external",
];

async function alignRole(label, contract, getter, setter, target) {
  let current;
  try {
    current = await contract[getter]();
  } catch {
    console.log(`  ? ${label}: ${getter}() not present — skip`);
    return;
  }
  if (current.toLowerCase() === target.toLowerCase()) {
    console.log(`  ✓ ${label}: ${getter}() already = ${target}`);
    return;
  }
  console.log(`── ${label}: ${setter}(${target}) — was ${current} ──`);
  const tx = await contract[setter](target);
  console.log(`     tx: ${tx.hash}`);
  await tx.wait();
  // Public RPCs (publicnode et al.) lag — poll the read.
  for (let i = 0; i < 5; i++) {
    const after = await contract[getter]();
    if (after.toLowerCase() === target.toLowerCase()) {
      console.log(`     ✓ confirmed`);
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`${label}: ${getter} did not flip to target after retries`);
}

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`requires chainId ${EXPECTED_CHAIN_ID}, got ${chainId}`);
  }

  const SIGNER       = process.env.GATEWAY_SIGNER       || DEFAULT_SIGNER;
  const GAS_RELAYER  = process.env.GATEWAY_GAS_RELAYER  || DEFAULT_GAS_RELAYER;

  const [deployer] = await ethers.getSigners();
  const addrs      = addresses.load(chainId);

  console.log("════════════════════════════════════════════════════════");
  console.log("  HOODI: align backend signer / executor roles");
  console.log("════════════════════════════════════════════════════════");
  console.log(`  Deployer:           ${deployer.address}`);
  console.log(`  Target SIGNER:      ${SIGNER}`);
  console.log(`  Target GAS_RELAYER: ${GAS_RELAYER}`);
  console.log("");

  const targets = [
    { label: "FypherMinting",        addr: addrs.FypherMinting        },
    { label: "FypherBurnQueue",      addr: addrs.FypherBurnQueue      },
    { label: "FyusdEpochSettlement", addr: addrs.FyusdEpochSettlement },
    { label: "FyusdEpochRedemption", addr: addrs.FyusdEpochRedemption },
  ];

  for (const t of targets) {
    if (!t.addr) {
      console.log(`  ⚠ ${t.label}: no address — skip`);
      continue;
    }
    const c = new ethers.Contract(t.addr, ABI, deployer);
    console.log(`\n── ${t.label} (${t.addr}) ──`);
    await alignRole(t.label, c, "backendSigner",   "setBackendSigner",   SIGNER);
    await alignRole(t.label, c, "backendExecutor", "setBackendExecutor", GAS_RELAYER);
  }

  console.log("");
  console.log("════════════════════════════════════════════════════════");
  console.log("  ✓ All backend roles aligned");
  console.log("════════════════════════════════════════════════════════");
}

main().catch((e) => { console.error(e); process.exit(1); });
