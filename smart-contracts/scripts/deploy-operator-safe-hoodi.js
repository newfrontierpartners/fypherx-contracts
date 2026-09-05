/**
 * Deploy a 2-of-3 operator Safe on HOODI.
 *
 * Mirrors {@link scripts/deploy-operator-safe.js} (Sepolia variant)
 * but defaults the three owners to the three EOAs already provisioned
 * on the dev cluster:
 *
 *   - HOODI deployer EOA          (.env.hoodi-deployer)
 *   - Gateway BACKEND_SIGNER      (gateway pod env)
 *   - Gateway BACKEND_GAS_RELAYER (gateway pod env)
 *
 * That gives us a realistic multisig topology (no single key can act
 * unilaterally) without dragging multi-operator coordination into the
 * dev workflow — any two of the dev keys can co-sign. Override via
 * OWNER_1_ADDRESS / OWNER_2_ADDRESS / OWNER_3_ADDRESS / THRESHOLD env
 * for ad-hoc deploys (e.g. a 1-of-1 Safe owned by a single operator
 * for quick smoke tests).
 *
 * The canonical Safe v1.4.1 deployments are already on HOODI
 * (verified 2026-05-09: SafeProxyFactory, Singleton, fallback handler
 * all present at the deterministic addresses), so this script just
 * calls {createProxyWithNonce} on the existing factory — no Safe
 * infra deploys needed.
 *
 * Idempotent via deterministic salt (sorted owners + threshold). Re-
 * running without changing inputs returns the SAME Safe address; pass
 * SALT_NONCE to force a fresh deploy.
 *
 * Usage:
 *   source .env.hoodi-deployer
 *   npx hardhat run scripts/deploy-operator-safe-hoodi.js --network hoodi
 */
const hre = require('hardhat');
const { ethers } = hre;

const EXPECTED_CHAIN_ID = 560048;

// Safe v1.4.1 canonical addresses — same on every chain.
const SAFE_PROXY_FACTORY = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67';
const SAFE_SINGLETON     = '0x41675C099F32341bf84BFc5382aF534df5C7461a';
const FALLBACK_HANDLER   = '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99';

const SAFE_PROXY_FACTORY_ABI = [
  'function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)',
  'event ProxyCreation(address indexed proxy, address singleton)',
];
const SAFE_SINGLETON_ABI = [
  'function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address payable paymentReceiver)',
];

// Default dev-cluster owners — pre-2026-05-09 these were the only
// three keys with funded HOODI ETH and known addresses, so any
// 2-of-3 they co-sign is realistic for our dev tests.
const DEFAULT_OWNERS = [
  '0x570B0F5D005d14a477B5FEacC450e8f002063cc7', // HOODI deployer EOA
  '0x31B60b11533c97b5ED7b1B650D31855F3754Acb4', // gateway BACKEND_SIGNER
  '0x5fA4e48f27CfE353E077a78962e2b578f72B1b97', // gateway BACKEND_GAS_RELAYER
];
const DEFAULT_THRESHOLD = 2;

async function main() {
  const network  = await ethers.provider.getNetwork();
  const chainId  = Number(network.chainId);
  if (chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`requires chainId ${EXPECTED_CHAIN_ID}, got ${chainId}`);
  }
  const [deployer] = await ethers.getSigners();

  const owners = [
    process.env.OWNER_1_ADDRESS ?? DEFAULT_OWNERS[0],
    process.env.OWNER_2_ADDRESS ?? DEFAULT_OWNERS[1],
    process.env.OWNER_3_ADDRESS ?? DEFAULT_OWNERS[2],
  ];
  for (const [i, addr] of owners.entries()) {
    if (!addr || !ethers.isAddress(addr)) {
      throw new Error(`OWNER_${i + 1}_ADDRESS invalid: ${addr}`);
    }
  }
  const threshold = process.env.THRESHOLD ? Number(process.env.THRESHOLD) : DEFAULT_THRESHOLD;
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > owners.length) {
    throw new Error(`THRESHOLD ${threshold} must be 1..${owners.length}`);
  }

  // Deterministic salt — same owners + threshold yields the same address.
  const ownersSorted = [...owners]
    .map((a) => ethers.getAddress(a))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const saltNonce = process.env.SALT_NONCE
    ? BigInt(process.env.SALT_NONCE)
    : BigInt(ethers.keccak256(ethers.toUtf8Bytes(
        `fypherx-hoodi-operator-safe-v1|${ownersSorted.join(',')}|t=${threshold}`,
      )));

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  HOODI operator Safe — Phase A surface');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Network        : HOODI (${chainId})`);
  console.log(`  Deployer       : ${deployer.address}`);
  console.log(`  Owners (sorted):`);
  for (const o of ownersSorted) console.log(`                   ${o}`);
  console.log(`  Threshold      : ${threshold}-of-${ownersSorted.length}`);
  console.log(`  Salt nonce     : ${saltNonce.toString().slice(0, 24)}…  ${process.env.SALT_NONCE ? '(override)' : '(deterministic)'}`);
  console.log('');

  // Encode Safe.setup(...) — fired against the new proxy by the factory.
  const safeIface  = new ethers.Interface(SAFE_SINGLETON_ABI);
  const initializer = safeIface.encodeFunctionData('setup', [
    ownersSorted,
    threshold,
    ethers.ZeroAddress,
    '0x',
    FALLBACK_HANDLER,
    ethers.ZeroAddress,
    0,
    ethers.ZeroAddress,
  ]);

  const factory = new ethers.Contract(SAFE_PROXY_FACTORY, SAFE_PROXY_FACTORY_ABI, deployer);

  console.log('→ submitting createProxyWithNonce(...)');
  const tx = await factory.createProxyWithNonce(SAFE_SINGLETON, initializer, saltNonce);
  console.log(`  tx hash      : ${tx.hash}`);
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
      if (parsed && parsed.name === 'ProxyCreation') { proxyAddress = parsed.args.proxy; break; }
    } catch { /* ignore non-matching */ }
  }
  if (!proxyAddress) throw new Error('ProxyCreation event not in receipt');

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  ✓ Safe deployed');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Address      : ${proxyAddress}`);
  console.log(`  Etherscan    : https://hoodi.etherscan.io/address/${proxyAddress}`);
  // Safe Wallet UI is a curated chain list; HOODI may or may not be
  // present. The deeplink uses chain shortname "hoodi" — Safe will
  // show "chain not supported" if HOODI isn't yet indexed by their
  // public Tx Service. The contract is still usable directly via
  // {execTransaction}; the UI link is informational only.
  console.log(`  Safe UI link : https://app.safe.global/home?safe=hoodi:${proxyAddress}`);
  console.log('');
  console.log('  Next steps:');
  console.log(`    1. Patch fypherx-chain-config ConfigMap:`);
  console.log(`         FYPHERX_OPERATOR_SAFE_ADDRESS=${proxyAddress}`);
  console.log(`    2. (Optional) Set FYPHERX_SAFE_TX_SERVICE_URL when HOODI`);
  console.log(`       Safe Tx Service is available; until then leave empty so`);
  console.log(`       the gateway falls back to direct on-chain tx mode.`);
  console.log(`    3. kubectl rollout restart deployment fypherx-gateway-backend`);
  console.log('');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
