/**
 * dev-redeploy-vfyusd-soulbound.js — DEV (HOODI) ONLY
 *
 * Reverts the Earn receipt from the transferable "sFYUSD" back to a
 * NON-TRANSFERABLE (soulbound) "vFYUSD":
 *   1. Deploy the (now soulbound) StakedFYUSD as name/symbol "vFYUSD".
 *   2. Grant the keeper MINTER/BURNER/LOCKER/PAUSER + grant the deployer
 *      MINTER/LOCKER (so this migration can mint + seed locks).
 *   3. Enumerate every holder of the OLD sFYUSD (via a getLogs-capable RPC) and,
 *      per holder, mirror the balance 1:1 onto NEW and carry the redeem-maturity
 *      lock (userUnlockAt). Then zero the OLD balance (grant deployer BURNER on
 *      OLD first). Idempotent difference-mint — safe to re-run.
 *
 * Signed by the HOODI deployer (admin on both tokens). Dry-run by default; set
 * EXECUTE=true to send txs.
 *
 *   OLD_SFYUSD=0x15f7... RELAYER_ADDRESS=0x5fA4e48f... \
 *     [EXECUTE=true] npx hardhat run scripts/dev-redeploy-vfyusd-soulbound.js --network hoodi
 */
const { ethers } = require("hardhat");

const LOGS_RPC = process.env.LOGS_RPC || "https://hoodi.drpc.org"; // publicnode 403s getLogs
const SCAN_BACK = Number(process.env.SCAN_BACK || 60000);          // ~8 days of hoodi blocks
const STEP = 9000;

const OLD_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function userUnlockAt(address) view returns (uint64)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function BURNER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function grantRole(bytes32,address)",
  "function burnByKeeper(address,uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

function fmt(x) { return ethers.formatUnits(x, 6); }

async function enumerateHolders(oldAddr) {
  const p = new ethers.JsonRpcProvider(LOGS_RPC);
  const c = new ethers.Contract(oldAddr, OLD_ABI, p);
  const latest = await p.getBlockNumber();
  const from = Math.max(0, latest - SCAN_BACK);
  const seen = new Set();
  for (let b = from; b <= latest; b += STEP + 1) {
    const to = Math.min(b + STEP, latest);
    const logs = await c.queryFilter(c.filters.Transfer(), b, to);
    for (const l of logs) {
      if (l.args.to !== ethers.ZeroAddress) seen.add(ethers.getAddress(l.args.to));
      if (l.args.from !== ethers.ZeroAddress) seen.add(ethers.getAddress(l.args.from));
    }
  }
  return [...seen];
}

async function main() {
  const EXECUTE = process.env.EXECUTE === "true";
  const OLD = ethers.getAddress(process.env.OLD_SFYUSD);
  const keeper = process.env.RELAYER_ADDRESS && ethers.isAddress(process.env.RELAYER_ADDRESS)
    ? ethers.getAddress(process.env.RELAYER_ADDRESS) : null;
  if (!keeper) throw new Error("RELAYER_ADDRESS (keeper) required");

  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  if (net.chainId !== 560048n) throw new Error(`this script is HOODI-only (got chainId ${net.chainId})`);
  console.log(`[vfyusd] chainId=${net.chainId} deployer=${deployer.address} keeper=${keeper} EXECUTE=${EXECUTE}`);

  // ── enumerate OLD holders + snapshot balances/locks ──
  const old = new ethers.Contract(OLD, OLD_ABI, ethers.provider);
  const oldSupply = await old.totalSupply();
  console.log(`[vfyusd] OLD sFYUSD ${OLD} totalSupply=${fmt(oldSupply)}`);
  const holders = await enumerateHolders(OLD);
  const plan = [];
  let sum = 0n;
  for (const h of holders) {
    const bal = await old.balanceOf(h);
    if (bal === 0n) continue;
    const unlock = await old.userUnlockAt(h);
    plan.push({ holder: h, bal, unlock });
    sum += bal;
  }
  plan.sort((a, b) => (b.bal > a.bal ? 1 : -1));
  console.log(`[vfyusd] ${plan.length} holders with non-zero balance, Σ=${fmt(sum)}`);
  for (const p of plan) console.log(`   ${p.holder}  ${fmt(p.bal)}  unlockAt=${p.unlock}`);
  const recon = sum === oldSupply ? "OK (Σ == totalSupply)" : `⚠️ MISMATCH Σ=${fmt(sum)} vs supply=${fmt(oldSupply)} — widen SCAN_BACK`;
  console.log(`[vfyusd] reconciliation: ${recon}`);

  if (!EXECUTE) {
    console.log("\n[vfyusd] DRY-RUN — no txs. Re-run with EXECUTE=true to deploy + migrate.");
    return;
  }
  if (sum !== oldSupply) throw new Error("refusing to migrate: holder set does not reconcile to totalSupply");

  // ── 1. deploy NEW soulbound vFYUSD ──
  const SF = await ethers.getContractFactory("StakedFYUSD");
  const nf = await SF.deploy("Vault FYUSD", "vFYUSD", 6, deployer.address);
  await nf.waitForDeployment();
  const NEW = await nf.getAddress();
  console.log(`[vfyusd] NEW vFYUSD deployed at ${NEW}`);

  // ── 2. roles ──
  for (const role of ["MINTER_ROLE", "BURNER_ROLE", "LOCKER_ROLE", "PAUSER_ROLE"]) {
    await (await nf.grantRole(await nf[role](), keeper)).wait();
    console.log(`[vfyusd] NEW granted ${role} → keeper`);
  }
  for (const role of ["MINTER_ROLE", "LOCKER_ROLE"]) { // deployer needs these for migration
    await (await nf.grantRole(await nf[role](), deployer.address)).wait();
  }
  // deployer BURNER on OLD (to zero balances); deployer is OLD admin
  const oldW = new ethers.Contract(OLD, OLD_ABI, deployer);
  const BURN = await oldW.BURNER_ROLE();
  if (!(await oldW.hasRole(BURN, deployer.address))) {
    await (await oldW.grantRole(BURN, deployer.address)).wait();
    console.log("[vfyusd] OLD granted BURNER → deployer");
  }

  // ── 3. per-holder migrate ──
  const addrs = plan.map((p) => p.holder);
  const unlocks = plan.map((p) => p.unlock);
  for (const p of plan) {
    const have = await nf.balanceOf(p.holder);
    if (have < p.bal) {
      await (await nf.mint(p.holder, p.bal - have)).wait();
    }
    const oldBal = await old.balanceOf(p.holder);
    if (oldBal > 0n) await (await oldW.burnByKeeper(p.holder, oldBal)).wait();
    console.log(`[vfyusd] migrated ${p.holder}: NEW=${fmt(p.bal)} OLD→0`);
  }
  // seed redeem-maturity locks in one batch
  await (await nf.setLockBatch(addrs, unlocks)).wait();
  console.log(`[vfyusd] seeded ${addrs.length} redeem-maturity locks`);

  const newSupply = await nf.totalSupply();
  console.log(`\n[vfyusd] DONE. NEW vFYUSD=${NEW} totalSupply=${fmt(newSupply)} (was ${fmt(oldSupply)})`);
  console.log(`  → set FYPHERX_EARN_DEV_VFYUSD_ADDRESS = ${NEW}`);
  console.log(`  → frontend addresses.ts EarnHybridVfyusd (560048) = ${NEW}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
