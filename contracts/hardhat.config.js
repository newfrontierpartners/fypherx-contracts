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
    }
  }
};
