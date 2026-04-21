require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-verify");
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
    bscTestnet: {
      url: process.env.BSC_TESTNET_RPC || "https://data-seed-prebsc-1-s1.binance.org:8545",
      chainId: 97,
      accounts
    }
  },
  etherscan: {
    apiKey: process.env.BSCSCAN_API_KEY || "",
    customChains: [
      {
        network: "bscTestnet",
        chainId: 97,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api?chainid=97",
          browserURL: "https://testnet.bscscan.com"
        }
      }
    ]
  },
  sourcify: {
    enabled: false
  }
};
