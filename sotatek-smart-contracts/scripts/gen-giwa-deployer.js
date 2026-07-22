/**
 * Generate a fresh deployer EOA for GIWA Sepolia (chainId 91342).
 *
 * <p>Mirrors {@code gen-hoodi-deployer.js}. GIWA is a separate L2 with its
 * own environment ({@code giwa.fypherfi.com}); it gets its own deployer key
 * so the blast radius stays contained — losing this key affects GIWA Sepolia
 * only and never bleeds into HOODI, Sepolia, or mainnet ops.
 *
 * <p>This script is a one-shot setup utility. Run it once; the resulting
 * mnemonic + private key go into {@code .env.giwa-deployer} (gitignored).
 * The public address is what you share with whoever funds it.
 *
 * Funding GIWA Sepolia ETH:
 *   1. Get Sepolia ETH from any Sepolia faucet, then bridge L1 -> L2 via
 *      the OptimismPortal at 0x956962C34687A954e611A83619ABaA37Ce6bC78A, or
 *   2. Use the GIWA faucet at https://faucet.giwa.io/
 *
 * Usage:
 *   node scripts/gen-giwa-deployer.js
 *
 * Output:
 *   address:    0x...
 *   privateKey: 0x...      <- copy into .env.giwa-deployer as GIWA_DEPLOYER_PRIVATE_KEY
 *   mnemonic:   word word word ...   <- back up out-of-band
 */
const { ethers } = require("ethers");

const wallet = ethers.Wallet.createRandom();
console.log("address:    ", wallet.address);
console.log("privateKey: ", wallet.privateKey);
console.log("mnemonic:   ", wallet.mnemonic.phrase);
