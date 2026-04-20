require("@nomicfoundation/hardhat-ethers");
require("dotenv").config();

const privateKey = process.env.DEPLOYER_PRIVATE_KEY || "";
const accounts = privateKey ? [privateKey] : [];

module.exports = {
  solidity: "0.8.20",
  paths: {
    sources: "./src",
    cache: "./cache",
    artifacts: "./artifacts"
  },
  networks: {
    localhost: {
      url: process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545",
      accounts
    },
    sepolia: {
      url: process.env.TESTNET_RPC_URL || "",
      accounts
    },
    // BSC Testnet — the chain FypherX dev/demo targets. chainId 97.
    // Set DEPLOYER_PRIVATE_KEY in .env and fund the wallet with testnet BNB
    // (https://testnet.bnbchain.org/faucet-smart) before running the deploy
    // script.
    bscTestnet: {
      url: process.env.BSC_TESTNET_RPC || "https://data-seed-prebsc-1-s1.binance.org:8545",
      chainId: 97,
      accounts
    }
  }
};
