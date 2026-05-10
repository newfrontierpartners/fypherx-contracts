require("@nomicfoundation/hardhat-toolbox");
require("@openzeppelin/hardhat-upgrades");
require("dotenv").config();

module.exports = {
  solidity: {
    version: "0.8.22",
    settings: {
      optimizer: { enabled: true, runs: 1 },
    },
  },
  networks: {
    bscTestnet: {
      url: "https://data-seed-prebsc-1-s1.binance.org:8545",
      chainId: 97,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
      chainId: 11155111,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    // HOODI — Ethereum testnet (chainId 560048).
    //
    // Selected because Concrete deployed FYUSD here and does not support
    // Sepolia for the partner stable-vault flow:
    //   https://hoodi.etherscan.io/token/0xd1bbd247be78c68cdeb8486744bd4513e62025e6
    //
    // Uses a dedicated HOODI_DEPLOYER_PRIVATE_KEY rather than the shared
    // PRIVATE_KEY so the testnet deployer's blast radius is contained —
    // losing this key affects HOODI only and never bleeds into Sepolia
    // or mainnet ops. The env file `.env.hoodi-deployer` is gitignored;
    // see `.env.example` for the variable name.
    hoodi: {
      url: process.env.HOODI_RPC_URL || "https://ethereum-hoodi-rpc.publicnode.com",
      chainId: 560048,
      accounts: process.env.HOODI_DEPLOYER_PRIVATE_KEY
        ? [process.env.HOODI_DEPLOYER_PRIVATE_KEY]
        : [],
    },
  },
  etherscan: {
    // Etherscan V2 unified key — one API key works across BSCScan, Etherscan, etc.
    // HOODI verification: covered by the same key per Etherscan's V2
    // multichain config. The customChains entry below tells Hardhat
    // which API + browser hosts to use for `hardhat verify --network hoodi`.
    apiKey: process.env.ETHERSCAN_API_KEY || process.env.BSCSCAN_API_KEY || "",
    customChains: [
      {
        network: "hoodi",
        chainId: 560048,
        urls: {
          apiURL: "https://api-hoodi.etherscan.io/api",
          browserURL: "https://hoodi.etherscan.io",
        },
      },
    ],
  },
};
