/**
 * Seed a wallet with FYUSD + vFYUSD on HOODI (dev demo / QA fixture).
 *
 * The HOODI FYUSD (0xD1bbd2…, 6-dec, Concrete-deployed, AccessControl)
 * gates mint() behind MINTER_ROLE. Our sanctioned testnet deployer
 * (HOODI_DEPLOYER_PRIVATE_KEY = 0x570B…) does NOT hold that role, so
 * this script does, in order:
 *
 *   1. (optional) admin grants MINTER_ROLE to the deployer.
 *      Signed by the FYUSD DEFAULT_ADMIN_ROLE holder (0x8a93…0604).
 *      Provide that key via FYUSD_ADMIN_PRIVATE_KEY. Skipped if the
 *      deployer already holds MINTER_ROLE.
 *   2. deployer.mint(WALLET, HOLD)            → wallet holds FYUSD
 *   3. deployer.mint(deployer, INVEST)
 *      deployer.approve(VAULT, INVEST)
 *      VAULT.deposit(INVEST, WALLET)          → wallet holds vFYUSD shares
 *
 * Env:
 *   HOODI_DEPLOYER_PRIVATE_KEY   the gas-funded deployer/minter EOA (0x570B…)
 *   FYUSD_ADMIN_PRIVATE_KEY      FYUSD admin (0x8a93…); only needed for step 1
 *   WALLET                       recipient (default the QA wallet below)
 *   HOLD_FYUSD                   FYUSD to leave liquid in the wallet (default 1000)
 *   INVEST_FYUSD                 FYUSD to deposit into the vault as vFYUSD (default 1000)
 *
 * Usage:
 *   source .env.hoodi-deployer
 *   FYUSD_ADMIN_PRIVATE_KEY=0x… \
 *   npx hardhat run scripts/fund-wallet-fyusd-hoodi.js --network hoodi
 */
const { ethers } = require("hardhat");

const EXPECTED_CHAIN_ID = 560048;
const FYUSD  = "0xD1bbd247be78c68CDEB8486744Bd4513e62025E6";
const VAULT  = "0xA573D7868EB24bC008dCF40FEE6c2e7F46FdEbc3"; // FyusdYieldVault (asset = FYUSD)
const MINTER_ROLE = "0xf0887ba65ee2024ea881d91b74c2450ef19e1557f03bed3ea9f16b037cbe2dc9";
const DEFAULT_WALLET = "0x3C886D7C56Ca228FB575aAaa4890C5dbB716eC99";

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function mint(address to, uint256 amount) external",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function grantRole(bytes32 role, address account) external",
];
const VAULT_ABI = [
  "function deposit(uint256 assets, address receiver) external returns (uint256 shares)",
  "function balanceOf(address) view returns (uint256)",
];

async function main() {
  const net = await ethers.provider.getNetwork();
  if (Number(net.chainId) !== EXPECTED_CHAIN_ID) {
    throw new Error(`requires chainId ${EXPECTED_CHAIN_ID}, got ${net.chainId}`);
  }

  const [deployer] = await ethers.getSigners();
  const wallet = process.env.WALLET || DEFAULT_WALLET;
  if (!ethers.isAddress(wallet)) throw new Error(`bad WALLET: ${wallet}`);

  const fyusd = new ethers.Contract(FYUSD, ERC20_ABI, deployer);
  const dec = await fyusd.decimals();
  const hold   = ethers.parseUnits(process.env.HOLD_FYUSD   || "1000", dec);
  const invest = ethers.parseUnits(process.env.INVEST_FYUSD || "1000", dec);

  console.log(`Deployer (minter): ${deployer.address}`);
  console.log(`Wallet (recipient): ${wallet}`);
  console.log(`FYUSD decimals: ${dec}`);
  console.log(`Hold: ${ethers.formatUnits(hold, dec)}  Invest(vFYUSD): ${ethers.formatUnits(invest, dec)}\n`);

  // ── 1. ensure deployer holds MINTER_ROLE ──
  if (!(await fyusd.hasRole(MINTER_ROLE, deployer.address))) {
    const adminKey = process.env.FYUSD_ADMIN_PRIVATE_KEY;
    if (!adminKey) {
      throw new Error(
        "deployer lacks MINTER_ROLE and FYUSD_ADMIN_PRIVATE_KEY is unset — " +
        "provide the FYUSD admin (0x8a93…0604) key to grant it, or run with a key that already mints.");
    }
    const admin = new ethers.Wallet(adminKey.startsWith("0x") ? adminKey : "0x" + adminKey, ethers.provider);
    console.log(`Granting MINTER_ROLE to deployer (admin ${admin.address})…`);
    const g = await fyusd.connect(admin).grantRole(MINTER_ROLE, deployer.address);
    await g.wait();
    console.log(`  granted tx ${g.hash}`);
    if (!(await fyusd.hasRole(MINTER_ROLE, deployer.address))) {
      throw new Error("grantRole did not stick — is that key really the FYUSD admin?");
    }
  } else {
    console.log("deployer already holds MINTER_ROLE — skip grant");
  }

  // ── 2. mint the liquid FYUSD hold to the wallet ──
  if (hold > 0n) {
    const tx = await fyusd.mint(wallet, hold);
    await tx.wait();
    console.log(`minted ${ethers.formatUnits(hold, dec)} FYUSD → wallet (tx ${tx.hash})`);
  }

  // ── 3. mint + deposit into the vault, crediting vFYUSD shares to the wallet ──
  if (invest > 0n) {
    let tx = await fyusd.mint(deployer.address, invest);
    await tx.wait();
    tx = await fyusd.approve(VAULT, invest);
    await tx.wait();
    const vault = new ethers.Contract(VAULT, VAULT_ABI, deployer);
    tx = await vault.deposit(invest, wallet);
    const rcpt = await tx.wait();
    if (rcpt.status !== 1) throw new Error("vault.deposit reverted");
    console.log(`deposited ${ethers.formatUnits(invest, dec)} FYUSD → vFYUSD shares to wallet (tx ${tx.hash})`);
  }

  // ── report ──
  const fyusdBal = await fyusd.balanceOf(wallet);
  const vBal = await new ethers.Contract(VAULT, VAULT_ABI, ethers.provider).balanceOf(wallet);
  console.log(`\n✓ wallet ${wallet}`);
  console.log(`   FYUSD : ${ethers.formatUnits(fyusdBal, dec)}`);
  console.log(`   vFYUSD: ${ethers.formatUnits(vBal, dec)}`);
}

main().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
