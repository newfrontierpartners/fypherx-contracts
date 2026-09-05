require("@nomicfoundation/hardhat-toolbox");
require("@openzeppelin/hardhat-upgrades");
require("dotenv").config();
// GIWA gets its own deployer key in a separate dotenv file (same pattern as
// HOODI). `override: false` so an already-exported GIWA_DEPLOYER_PRIVATE_KEY
// (e.g. `source .env.giwa-deployer`) still wins.
require("dotenv").config({ path: ".env.giwa-deployer", override: false });

// Which network is this invocation targeting? Hardhat exposes it via
// HARDHAT_NETWORK when running scripts in a subprocess, but a direct
// `npx hardhat verify --network giwaSepolia` only has it in argv — check both.
//
// This matters because `hardhat verify` runs EVERY enabled verification
// provider and exits 1 if ANY of them errors (see hardhat-verify index.ts).
// GIWA has no Etherscan deployment, so leaving the Etherscan provider on
// would fail the run even when the Blockscout verification succeeded.
const TARGET_NETWORK =
  process.env.HARDHAT_NETWORK ||
  (() => {
    const i = process.argv.indexOf("--network");
    return i !== -1 ? process.argv[i + 1] : undefined;
  })();
const IS_GIWA = TARGET_NETWORK === "giwaSepolia";

module.exports = {
  solidity: {
    version: "0.8.22",
    settings: {
      optimizer: { enabled: true, runs: 1 },
    },
  },
  networks: {
    hardhat: {
      // The GIWA deploy scripts gate on chainId 91342 so a misrouted run can
      // never write GIWA addresses against another chain. That gate also makes
      // them un-runnable locally, which is exactly when you want to rehearse a
      // multi-stage deploy. `GIWA_DRYRUN=1 npx hardhat node` makes the
      // in-memory chain claim 91342 so the whole sequence can be exercised
      // end-to-end against `--network localhost` before touching the real L2.
      // Unset (the default) leaves the standard 31337 for the test suite.
      chainId: process.env.GIWA_DRYRUN === "1" ? 91342 : 31337,
    },
    // Target for that rehearsal. Port 8546 rather than the default 8545 so a
    // dry run cannot collide with an unrelated hardhat node someone already
    // has open — and, more importantly, so a script that gates on chainId
    // 91342 can never silently attach to a plain 31337 node.
    //   GIWA_DRYRUN=1 npx hardhat node --port 8546
    //   npx hardhat run scripts/deploy-giwa-phase0.js --network giwaLocal
    giwaLocal: {
      url: "http://127.0.0.1:8546",
      chainId: 91342,
    },
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
    // GIWA Sepolia — Dunamu/Upbit's OP-Stack L2 testnet (chainId 91342).
    //
    // This is the network behind the `giwa` environment (giwa.fypherfi.com).
    // GIWA has no BitGo custody and no Concrete vault, so the GIWA deploy is
    // the fully self-contained on-chain variant: test stables + FYUSD + the
    // Earn vault backed by MockConcreteAdapter instead of the real Concrete
    // integration. See scripts/deploy-giwa.js for the runbook.
    //
    // Like HOODI, it uses a dedicated deployer key (.env.giwa-deployer,
    // gitignored) so a leaked testnet key never bleeds into Sepolia/mainnet.
    // Native gas is bridged Sepolia ETH — there is no separate GIWA token.
    giwaSepolia: {
      url: process.env.GIWA_RPC_URL || "https://sepolia-rpc.giwa.io",
      chainId: 91342,
      accounts: process.env.GIWA_DEPLOYER_PRIVATE_KEY
        ? [process.env.GIWA_DEPLOYER_PRIVATE_KEY]
        : [],
    },
  },
  etherscan: {
    // Off for GIWA: there is no Etherscan instance for chainId 91342, and an
    // enabled-but-unsupported provider fails the whole `verify` run.
    enabled: !IS_GIWA,
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
  // GIWA's explorer is Blockscout (v11), which speaks the Etherscan-compatible
  // verification API at /api and needs NO API key. hardhat-verify ships a
  // dedicated Blockscout provider — enable it only for the GIWA network so the
  // Etherscan-based flows for hoodi/sepolia/mainnet are untouched.
  //
  //   npx hardhat verify --network giwaSepolia <address> [ctor args...]
  blockscout: {
    enabled: IS_GIWA,
    customChains: [
      {
        network: "giwaSepolia",
        chainId: 91342,
        urls: {
          apiURL: "https://sepolia-explorer.giwa.io/api",
          browserURL: "https://sepolia-explorer.giwa.io",
        },
      },
    ],
  },
};
