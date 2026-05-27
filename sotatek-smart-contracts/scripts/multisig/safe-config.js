/**
 * Per-network Gnosis Safe canonical addresses (v1.3.0 deterministic
 * deployment). These addresses are the same across most EVM chains
 * because the factory uses CREATE2 with a fixed salt — see
 * https://github.com/safe-global/safe-deployments/tree/main/src/assets
 * for authoritative per-chain addresses.
 *
 * Per ADR-010, Phase 1 ships across three networks. ADR-007 §"Signer
 * sets" defines the threshold per network:
 *
 *   - HOODI       (chainId 560048):    2-of-3 (testnet ops)
 *   - Sepolia      (chainId 11155111): 2-of-3 (pre-prod)
 *   - Mainnet      (chainId 1):   3-of-5 (production)
 *
 * The actual signer addresses live in `multisig-signers.<network>.json`
 * — a gitignored, per-environment file. Operators populate it before
 * running `deploy-safe.js`.
 */

const SAFE_DEPLOYMENTS_V1_3_0 = {
  // Ethereum HOODI — Safe v1.3.0 canonical CREATE2 addresses are the
  // same as Sepolia/Mainnet because the proxy factory uses a fixed salt.
  560048: {
    name: "Ethereum HOODI",
    proxyFactory: "0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2",
    singleton:    "0x3E5c63644E683549055b9Be8653de26E0B4CD36E", // GnosisSafeL2
    fallbackHandler: "0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4",
    threshold: 2,
    signerCount: 3,
  },
  // Ethereum Sepolia
  11155111: {
    name: "Ethereum Sepolia",
    proxyFactory: "0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2",
    singleton:    "0x3E5c63644E683549055b9Be8653de26E0B4CD36E",
    fallbackHandler: "0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4",
    threshold: 2,
    signerCount: 3,
  },
  // Ethereum Mainnet
  1: {
    name: "Ethereum Mainnet",
    proxyFactory: "0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2",
    singleton:    "0x3E5c63644E683549055b9Be8653de26E0B4CD36E",
    fallbackHandler: "0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4",
    threshold: 3,
    signerCount: 5,
  },
};

// ABI fragments — only the calls we actually use, to avoid pulling in
// the full Safe SDK (which has heavy peer dep chains).
const SAFE_PROXY_FACTORY_ABI = [
  "function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
  "event ProxyCreation(address proxy, address singleton)",
];

const SAFE_SINGLETON_ABI = [
  "function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
];

function getSafeConfig(chainId) {
  const cfg = SAFE_DEPLOYMENTS_V1_3_0[chainId];
  if (!cfg) {
    throw new Error(
      `No Gnosis Safe deployment configured for chainId ${chainId}. ` +
      `Add it to safe-config.js after verifying the address at ` +
      `https://github.com/safe-global/safe-deployments`,
    );
  }
  return cfg;
}

module.exports = {
  SAFE_DEPLOYMENTS_V1_3_0,
  SAFE_PROXY_FACTORY_ABI,
  SAFE_SINGLETON_ABI,
  getSafeConfig,
};
