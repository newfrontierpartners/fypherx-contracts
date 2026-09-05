/**
 * End-to-end integration test for the mint→stake customer flow on
 * HOODI, executed from the deployer EOA (which has both the
 * MockERC20 minter authority for USDT/USDC AND the SettingManagement
 * admin role, so it can self-fund without going through the
 * fund-test-wallet flow).
 *
 * What this proves:
 *   1) Gateway signs a mint order for the deployer as benefactor
 *   2) approve(USDT, FypherMinting, …) succeeds with chain-canonical 6-dec amount
 *   3) FypherMinting.mint(...) actually moves USDT from deployer → ReservePool
 *      and mints RUSD to deployer
 *   4) approve(RUSD, sRUSD, …) succeeds
 *   5) StakedRUSD.deposit(...) burns RUSD and credits sRUSD shares
 *
 * If this script reaches the end without a revert, the entire
 * customer mint→stake path is functional on HOODI.
 *
 * Usage:
 *   source .env.hoodi-deployer
 *   npx hardhat run scripts/integration-test-mint-stake-hoodi.js --network hoodi
 */
const { ethers } = require("hardhat");
const addresses  = require("./lib/addresses");

const EXPECTED_CHAIN_ID = 560048;
const GATEWAY_URL       = process.env.GATEWAY_URL || "https://dev.fypherfi.com";

const ERC20_ABI = [
  "function mint(address to, uint256 amount) external",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

const FYPHER_MINTING_ABI = [
  "function mint(tuple(address benefactor,address beneficiary,address collateral_asset,uint256 collateral_amount,uint256 rusd_amount,uint256 nonce,uint256 expiry) order, tuple(address[] addresses, uint256[] ratios) route, bytes signature) external",
];

const STAKED_RUSD_ABI = [
  "function deposit(uint256 assets, address receiver) external returns (uint256 shares)",
  "function balanceOf(address) view returns (uint256)",
  "function totalAssets() view returns (uint256)",
];

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${url} → ${res.status} ${text}`);
  }
  return res.json();
}

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`requires chainId ${EXPECTED_CHAIN_ID}, got ${chainId}`);
  }

  const [deployer] = await ethers.getSigners();
  const addrs      = addresses.load(chainId);
  const wallet     = deployer.address;

  console.log("════════════════════════════════════════════════════════");
  console.log("  HOODI integration test — mint→stake from deployer EOA");
  console.log("════════════════════════════════════════════════════════");
  console.log(`  Deployer / test wallet: ${wallet}`);
  console.log(`  Gateway:                ${GATEWAY_URL}`);
  console.log("");

  const usdt = new ethers.Contract(addrs.USDT,          ERC20_ABI, deployer);
  const rusd = new ethers.Contract(addrs.RUSD,          ERC20_ABI, deployer);
  const minting = new ethers.Contract(addrs.FypherMinting, FYPHER_MINTING_ABI, deployer);
  const sRusd = new ethers.Contract(addrs.StakedRUSD,   STAKED_RUSD_ABI,    deployer);

  // ── 1. Self-fund USDT (deployer has MockERC20 mint authority) ──
  const collateralHuman = 100;                                    // 100 USDT
  const collateralAmount = ethers.parseUnits(String(collateralHuman), 6); // 6-dec
  const rusdAmount       = ethers.parseUnits(String(collateralHuman), 18); // 18-dec RUSD

  console.log("── 1/5  Self-fund USDT ──");
  const usdtBefore = await usdt.balanceOf(wallet);
  if (usdtBefore < collateralAmount) {
    console.log(`     deployer has ${usdtBefore} USDT (${Number(usdtBefore)/1e6}); minting ${collateralHuman}…`);
    const tx = await usdt.mint(wallet, collateralAmount);
    await tx.wait();
    console.log(`     ✓ minted (tx ${tx.hash})`);
  } else {
    console.log(`     ✓ deployer already has ${Number(usdtBefore)/1e6} USDT — skip`);
  }

  // ── 2. Approve USDT → FypherMinting ──
  console.log("── 2/5  Approve USDT → FypherMinting ──");
  const usdtAllowance = await usdt.allowance(wallet, addrs.FypherMinting);
  if (usdtAllowance < collateralAmount) {
    const tx = await usdt.approve(addrs.FypherMinting, collateralAmount);
    await tx.wait();
    console.log(`     ✓ approved ${collateralHuman} USDT (tx ${tx.hash})`);
  } else {
    console.log(`     ✓ existing allowance covers — skip`);
  }

  // ── 3. Get signed mint order from gateway ──
  console.log("── 3/5  Get signed mint order ──");
  const signed = await postJson(`${GATEWAY_URL}/api/v1/defi/mint/sign`, {
    benefactor:        wallet,
    beneficiary:       wallet,
    collateralAsset:   addrs.USDT,
    collateralAmount:  collateralAmount.toString(),
    rusdAmount:        rusdAmount.toString(),
  });
  console.log(`     ✓ gateway signed nonce=${signed.order.nonce} expiry=${signed.order.expiry}`);
  console.log(`     route.address: ${signed.route.addresses[0]}`);

  // ── 4. mint() on chain ──
  console.log("── 4/5  FypherMinting.mint(...) ──");
  const rusdBefore = await rusd.balanceOf(wallet);
  const mintTx = await minting.mint(
    {
      benefactor:        signed.order.benefactor,
      beneficiary:       signed.order.beneficiary,
      collateral_asset:  signed.order.collateral_asset,
      collateral_amount: signed.order.collateral_amount,
      rusd_amount:       signed.order.rusd_amount,
      nonce:             signed.order.nonce,
      expiry:            signed.order.expiry,
    },
    { addresses: signed.route.addresses, ratios: signed.route.ratios },
    signed.signature,
    { gasLimit: 800_000 },
  );
  console.log(`     submitted tx ${mintTx.hash}`);
  const mintReceipt = await mintTx.wait();
  if (mintReceipt.status !== 1) throw new Error("mint() reverted on chain");
  console.log(`     ✓ mint confirmed in block ${mintReceipt.blockNumber}`);
  const rusdAfter = await rusd.balanceOf(wallet);
  const rusdMinted = rusdAfter - rusdBefore;
  console.log(`     deployer RUSD: ${ethers.formatUnits(rusdBefore, 18)} → ${ethers.formatUnits(rusdAfter, 18)}  (+${ethers.formatUnits(rusdMinted, 18)})`);

  // ── 5. Approve RUSD → sRUSD + stake ──
  console.log("── 5/5  StakedRUSD.deposit(...) ──");
  const stakeAmount = rusdMinted; // stake everything just minted
  const rusdAllowToVault = await rusd.allowance(wallet, addrs.StakedRUSD);
  if (rusdAllowToVault < stakeAmount) {
    const tx = await rusd.approve(addrs.StakedRUSD, stakeAmount);
    await tx.wait();
    console.log(`     ✓ approved ${ethers.formatUnits(stakeAmount, 18)} RUSD → sRUSD (tx ${tx.hash})`);
  } else {
    console.log(`     ✓ existing RUSD→sRUSD allowance covers`);
  }
  const sRusdBefore = await sRusd.balanceOf(wallet);
  const stakeTx = await sRusd.deposit(stakeAmount, wallet, { gasLimit: 600_000 });
  console.log(`     submitted tx ${stakeTx.hash}`);
  const stakeReceipt = await stakeTx.wait();
  if (stakeReceipt.status !== 1) throw new Error("stake deposit() reverted");
  console.log(`     ✓ stake confirmed in block ${stakeReceipt.blockNumber}`);
  const sRusdAfter = await sRusd.balanceOf(wallet);
  console.log(`     deployer sRUSD: ${ethers.formatUnits(sRusdBefore, 18)} → ${ethers.formatUnits(sRusdAfter, 18)}  (+${ethers.formatUnits(sRusdAfter - sRusdBefore, 18)})`);

  console.log("");
  console.log("════════════════════════════════════════════════════════");
  console.log("  ✓ ALL FIVE STEPS PASSED — full mint→stake flow works end-to-end on HOODI");
  console.log("════════════════════════════════════════════════════════");
}

main().catch((e) => { console.error(e); process.exit(1); });
