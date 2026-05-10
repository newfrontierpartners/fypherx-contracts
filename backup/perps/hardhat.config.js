require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-verify");
require("dotenv").config();

const path = require("path");
const fs = require("fs");
const { subtask } = require("hardhat/config");
const {
  TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS
} = require("hardhat/builtin-tasks/task-names");

const privateKey = process.env.DEPLOYER_PRIVATE_KEY || "";
const accounts = privateKey ? [privateKey] : [];

// Production sources live in ./src, but Hardhat also needs to compile the
// test-only mocks under ./test/mocks so getContractFactory("MockERC20") /
// ("MockPriceOracle") works in test fixtures. The mocks are deliberately kept
// out of ./src so production Solidity can never `import` them.
function collectSolFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSolFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".sol")) {
      out.push(full);
    }
  }
  return out;
}

subtask(TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS, async (_args, _hre, runSuper) => {
  const srcPaths = await runSuper();
  const testMockPaths = collectSolFiles(path.join(__dirname, "test", "mocks"));
  return [...srcPaths, ...testMockPaths];
});

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
    hoodi: {
      url: process.env.HOODI_RPC_URL || "https://ethereum-hoodi-rpc.publicnode.com",
      chainId: 560048,
      accounts
    }
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || "",
    customChains: [
      {
        network: "hoodi",
        chainId: 560048,
        urls: {
          apiURL: "https://api-hoodi.etherscan.io/api",
          browserURL: "https://hoodi.etherscan.io"
        }
      }
    ]
  },
  sourcify: {
    enabled: false
  }
};
