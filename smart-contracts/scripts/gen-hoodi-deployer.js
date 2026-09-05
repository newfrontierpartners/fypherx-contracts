/**
 * Generate a fresh deployer EOA for HOODI testnet.
 *
 * <p>Why a dedicated key per env: HOODI is the testnet for the FYUSD ↔
 * Concrete integration. Using the shared {@code PRIVATE_KEY} (which
 * fronts Sepolia / mainnet) here would couple testnet operations to
 * production keys — losing the HOODI key in a CI log or on a dev
 * laptop should never threaten Sepolia or mainnet ops.
 *
 * <p>This script is a one-shot setup utility. Run it once per fresh
 * cluster / per dev who needs to deploy on HOODI; the resulting
 * mnemonic + private key go into {@code .env.hoodi-deployer}
 * (gitignored). The public address is what you share with whoever
 * funds the faucet.
 *
 * Usage:
 *   node scripts/gen-hoodi-deployer.js
 *
 * Output:
 *   address:    0x...
 *   privateKey: 0x...      ← copy into .env.hoodi-deployer as HOODI_DEPLOYER_PRIVATE_KEY
 *   mnemonic:   word word word ...   ← back up out-of-band
 */
const { ethers } = require("ethers");

const wallet = ethers.Wallet.createRandom();
console.log("address:    ", wallet.address);
console.log("privateKey: ", wallet.privateKey);
console.log("mnemonic:   ", wallet.mnemonic.phrase);
