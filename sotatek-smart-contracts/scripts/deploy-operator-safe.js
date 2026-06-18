/**
 * Phase 1 of ADR-012 — deploy the operator Gnosis Safe on Sepolia.
 *
 * Direct call against the canonical Safe v1.4.1 Proxy Factory at
 * 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67 (deterministic across
 * every chain Safe is deployed on). No external deps — just ethers
 * v6 (already in this repo via Hardhat).
 *
 * Inputs (env from `.env.dev-multisig`):
 *   OWNER_1_ADDRESS, OWNER_2_ADDRESS, OWNER_3_ADDRESS  — Safe owners
 * Threshold is hardcoded to 2-of-3 per ADR-012 §2.
 *
 * Outputs:
 *   - Submits one tx (deployer signs, deployer pays gas).
 *   - Prints the deployed Safe address.
 *   - Prints the Etherscan URL + the Safe Wallet UI URL for verification.
 *
 * Idempotency:
 *   - The script uses a deterministic saltNonce derived from the sorted
 *     owner addresses + threshold so re-running it without changing
 *     owners produces the SAME Safe address on the same factory. This
 *     means a re-run after a transient RPC failure resolves to the
 *     existing proxy rather than deploying a second Safe.
 *   - If you want a fresh Safe (e.g. rotating dev owners), pass an
 *     explicit SALT_NONCE env var with a new value.
 *
 * ADR reference: docs/decisions/ADR-012-operator-multisig-and-gas-relayer.md
 *
 * Usage:
 *   cd sotatek-smart-contracts
 *   npx hardhat run scripts/deploy-operator-safe.js --network sepolia
 */

const hre = require('hardhat');
const { ethers } = hre;
const path = require('path');

// Load the dev multisig keys (gitignored). Hardhat already loads `.env`
// for the deployer key; we layer the multisig file on top of that.
require('dotenv').config({ path: path.join(__dirname, '..', '.env.dev-multisig') });

// ── Safe v1.4.1 canonical addresses on every chain (incl. Sepolia) ──────
// Reference: https://github.com/safe-global/safe-deployments/tree/main/src/assets/v1.4.1
const SAFE_PROXY_FACTORY  = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67';
const SAFE_SINGLETON      = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762';
const FALLBACK_HANDLER    = '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99';

const SAFE_PROXY_FACTORY_ABI = [
  'function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)',
  'event ProxyCreation(address indexed proxy, address singleton)',
];

const SAFE_SINGLETON_ABI = [
  'function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address payable paymentReceiver)',
];

// Signature threshold. Defaults to 2 (the dev 2-of-3 per ADR-012 §2);
// override with SAFE_THRESHOLD for prod (ADR-007 calls for 3-of-5 on
// mainnet). The owner count comes from the OWNER_*_ADDRESS env vars below;
// THRESHOLD must be <= that count or Safe.setup reverts.
const THRESHOLD = process.env.SAFE_THRESHOLD
  ? Number(process.env.SAFE_THRESHOLD)
  : 2;

// Chain-aware explorer + Safe-app slug for the printed verification URLs.
function chainLinks(chainId) {
  switch (chainId) {
    case 1:        return { explorer: 'https://etherscan.io',          safeSlug: 'eth' };
    case 11155111: return { explorer: 'https://sepolia.etherscan.io',  safeSlug: 'sep' };
    case 560048:   return { explorer: 'https://hoodi.etherscan.io',    safeSlug: 'hoodi' };
    default:       return { explorer: 'https://etherscan.io',          safeSlug: String(chainId) };
  }
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const links   = chainLinks(Number(network.chainId));
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Phase 1 — deploy operator Safe (ADR-012)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Network        : ${network.name} (${network.chainId})`);
  console.log(`Deployer       : ${deployer.address}`);

  // Pull owner addresses from the dev multisig env file.
  const owners = [
    process.env.OWNER_1_ADDRESS,
    process.env.OWNER_2_ADDRESS,
    process.env.OWNER_3_ADDRESS,
  ];
  for (const [i, addr] of owners.entries()) {
    if (!addr || !ethers.isAddress(addr)) {
      throw new Error(
        `OWNER_${i + 1}_ADDRESS missing or invalid in .env.dev-multisig — value: ${addr}`,
      );
    }
  }

  // Safe expects owners in checksummed but ANY ORDER. Sorting them gives
  // us a deterministic saltNonce — see header comment about idempotency.
  const ownersSorted = [...owners]
    .map((a) => ethers.getAddress(a))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  // Fail fast on a misconfigured threshold rather than letting Safe.setup
  // revert opaquely on-chain (after paying gas). NOTE: this script wires
  // exactly three owners (OWNER_1/2/3_ADDRESS). A prod 3-of-5 needs the
  // owner list extended to 5 env vars first — see the runbook follow-ups.
  if (!Number.isInteger(THRESHOLD) || THRESHOLD < 1 || THRESHOLD > ownersSorted.length) {
    throw new Error(
      `SAFE_THRESHOLD must be an integer in [1, ${ownersSorted.length}] (owner count); got "${process.env.SAFE_THRESHOLD ?? THRESHOLD}". ` +
      `This script wires ${ownersSorted.length} owners; to raise the owner count, extend the OWNER_*_ADDRESS list.`,
    );
  }

  const saltNonceEnv = process.env.SALT_NONCE;
  const saltNonce = saltNonceEnv
    ? BigInt(saltNonceEnv)
    : BigInt(
        ethers.keccak256(
          ethers.toUtf8Bytes(`fypherx-dev-operator-safe-v1|${ownersSorted.join(',')}|t=${THRESHOLD}`),
        ),
      );

  console.log(`Owners         :`);
  for (const o of ownersSorted) console.log(`                   ${o}`);
  console.log(`Threshold      : ${THRESHOLD}-of-${ownersSorted.length}`);
  console.log(`Salt nonce     : ${saltNonce.toString().slice(0, 24)}…${saltNonceEnv ? ' (override)' : ' (deterministic)'}`);
  console.log('');

  // Encode Safe.setup(...) — fired against the new proxy by the factory
  // during construction.
  const safeIface = new ethers.Interface(SAFE_SINGLETON_ABI);
  const initializer = safeIface.encodeFunctionData('setup', [
    ownersSorted,                    // _owners
    THRESHOLD,                       // _threshold
    ethers.ZeroAddress,              // to (no module call)
    '0x',                            // data (no module call)
    FALLBACK_HANDLER,                // fallbackHandler
    ethers.ZeroAddress,              // paymentToken
    0,                               // payment
    ethers.ZeroAddress,              // paymentReceiver
  ]);

  const factory = new ethers.Contract(SAFE_PROXY_FACTORY, SAFE_PROXY_FACTORY_ABI, deployer);

  // Submit the deploy tx.
  console.log('→ submitting createProxyWithNonce(...)');
  const tx = await factory.createProxyWithNonce(SAFE_SINGLETON, initializer, saltNonce);
  console.log(`  tx hash      : ${tx.hash}`);
  console.log(`  waiting for confirmation…`);

  const receipt = await tx.wait();
  console.log(`  block        : ${receipt.blockNumber}`);
  console.log(`  gas used     : ${receipt.gasUsed.toString()}`);

  // Pull the proxy address from the ProxyCreation event.
  const factoryIface = new ethers.Interface(SAFE_PROXY_FACTORY_ABI);
  let proxyAddress = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== SAFE_PROXY_FACTORY.toLowerCase()) continue;
    try {
      const parsed = factoryIface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed && parsed.name === 'ProxyCreation') {
        proxyAddress = parsed.args.proxy;
        break;
      }
    } catch { /* not the event we want */ }
  }
  if (!proxyAddress) throw new Error('ProxyCreation event not found in receipt');

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  ✓ Safe deployed');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Address      : ${proxyAddress}`);
  console.log(`  Etherscan    : ${links.explorer}/address/${proxyAddress}`);
  console.log(`  Safe UI      : https://app.safe.global/home?safe=${links.safeSlug}:${proxyAddress}`);
  console.log('');
  console.log('  Next steps:');
  console.log('    1. Update OPERATOR_SAFE_ADDRESS in .env.dev-multisig');
  console.log(`    2. Record the Safe as OperatorSafe in addresses/${Number(network.chainId)}.json`);
  console.log('    3. Run scripts/grant-admin-to-safe.js to flip admin role');
  console.log('    4. Verify each owner can see the Safe in https://app.safe.global');
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
