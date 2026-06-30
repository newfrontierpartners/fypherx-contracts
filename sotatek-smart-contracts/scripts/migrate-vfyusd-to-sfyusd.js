/**
 * migrate-vfyusd-to-sfyusd.js — 1:1 migrate every vFYUSD holder to the new
 * sFYUSD (StakedFYUSD), preserving each holder's original lock-up.
 *
 * Per holder: top up NEW.balanceOf(holder) to OLD.balanceOf(holder) (mint the
 * difference), then burn ALL of OLD from the holder. End state: OLD=0,
 * NEW=originalOldBalance. The order + difference-mint make it IDEMPOTENT — a
 * re-run after a crash converges without double-minting.
 *
 * Locks: seed NEW.setLockBatch(address, unlockAt) from LOCKS_FILE so existing
 * lock-ups carry over EXACTLY (setLock is monotonic — never shortens/extends
 * beyond the provided value).
 *
 * SAFETY: dry-run by default. It prints the full plan and reconciliation and
 * sends NO transactions unless EXECUTE=true. Run dry first, eyeball it, then
 * EXECUTE. The signer (network PRIVATE_KEY) must hold BURNER_ROLE on OLD and
 * MINTER_ROLE + LOCKER_ROLE on NEW.
 *
 *   OLD_VFYUSD=0x.. NEW_SFYUSD=0x.. \
 *   HOLDERS_FILE=./migration/holders.json \   # JSON array of addresses (from backend earn_positions)
 *   LOCKS_FILE=./migration/locks.json \       # { "0xaddr": <unlock unix seconds>, ... }  (optional)
 *   FROM_BLOCK=<old deploy block> \           # only used if HOLDERS_FILE is absent (event scan)
 *   npx hardhat run scripts/migrate-vfyusd-to-sfyusd.js --network hoodi
 *
 *   # then, once the plan looks right:
 *   EXECUTE=true OLD_VFYUSD=.. NEW_SFYUSD=.. HOLDERS_FILE=.. LOCKS_FILE=.. \
 *   npx hardhat run scripts/migrate-vfyusd-to-sfyusd.js --network hoodi
 */
const fs = require("fs");
const { ethers } = require("hardhat");

const ERC20_MIN = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function burnByKeeper(address,uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

function req(name) {
  const v = process.env[name];
  if (!v || !ethers.isAddress(v)) throw new Error(`env ${name} must be a valid address`);
  return ethers.getAddress(v);
}

async function holdersFromEvents(old, fromBlock) {
  const latest = await ethers.provider.getBlockNumber();
  const seen = new Set();
  const STEP = 9000;
  for (let b = fromBlock; b <= latest; b += STEP + 1) {
    const to = Math.min(b + STEP, latest);
    const logs = await old.queryFilter(old.filters.Transfer(), b, to);
    for (const l of logs) {
      if (l.args.from !== ethers.ZeroAddress) seen.add(ethers.getAddress(l.args.from));
      if (l.args.to !== ethers.ZeroAddress) seen.add(ethers.getAddress(l.args.to));
    }
  }
  return [...seen];
}

async function main() {
  const EXECUTE = process.env.EXECUTE === "true";
  const oldAddr = req("OLD_VFYUSD");
  const newAddr = req("NEW_SFYUSD");
  const [signer] = await ethers.getSigners();

  const old = new ethers.Contract(oldAddr, ERC20_MIN, signer);
  const sf = await ethers.getContractAt("StakedFYUSD", newAddr, signer);

  console.log(`[migrate] ${EXECUTE ? "EXECUTE" : "DRY-RUN"}  signer=${signer.address}`);
  console.log(`[migrate] OLD vFYUSD=${oldAddr}  NEW sFYUSD=${newAddr}`);

  // Role preflight
  const hasBurnOld = true; // BURNER on OLD is keeper-granted; we surface failures at tx time
  const MINTER = await sf.MINTER_ROLE();
  const LOCKER = await sf.LOCKER_ROLE();
  const canMint = await sf.hasRole(MINTER, signer.address);
  const canLock = await sf.hasRole(LOCKER, signer.address);
  if (!canMint || !canLock) {
    throw new Error(`signer lacks MINTER(${canMint})/LOCKER(${canLock}) on sFYUSD — grant them first`);
  }
  void hasBurnOld;

  // Holder list: prefer the backend export; fall back to on-chain event scan.
  let holders;
  if (process.env.HOLDERS_FILE && fs.existsSync(process.env.HOLDERS_FILE)) {
    holders = JSON.parse(fs.readFileSync(process.env.HOLDERS_FILE, "utf8")).map(ethers.getAddress);
    console.log(`[migrate] ${holders.length} holders from ${process.env.HOLDERS_FILE}`);
  } else {
    const fromBlock = Number(process.env.FROM_BLOCK || 0);
    holders = await holdersFromEvents(old, fromBlock);
    console.log(`[migrate] ${holders.length} holders from Transfer events (from block ${fromBlock})`);
  }

  // Plan + reconcile
  let totalOld = 0n, toMint = 0n, toBurn = 0n, moves = 0;
  const plan = [];
  for (const h of holders) {
    const oldBal = await old.balanceOf(h);
    if (oldBal === 0n) continue;
    const newBal = await sf.balanceOf(h);
    const mintAmt = newBal < oldBal ? oldBal - newBal : 0n;
    plan.push({ h, oldBal, newBal, mintAmt });
    totalOld += oldBal; toMint += mintAmt; toBurn += oldBal; moves++;
  }
  console.log(`[migrate] ${moves} holders to migrate | old supply ${totalOld} | mint ${toMint} | burn ${toBurn}`);
  for (const p of plan) {
    console.log(`   ${p.h}  old=${p.oldBal}  new=${p.newBal}  +mint=${p.mintAmt}`);
  }

  // Locks
  let lockPairs = [];
  if (process.env.LOCKS_FILE && fs.existsSync(process.env.LOCKS_FILE)) {
    const raw = JSON.parse(fs.readFileSync(process.env.LOCKS_FILE, "utf8"));
    lockPairs = Object.entries(raw).map(([a, u]) => [ethers.getAddress(a), BigInt(u)]).filter(([, u]) => u > 0n);
    console.log(`[migrate] ${lockPairs.length} locks to seed from ${process.env.LOCKS_FILE}`);
  } else {
    console.log("[migrate] no LOCKS_FILE — NO locks seeded (holders would be immediately transferable!)");
  }

  if (!EXECUTE) {
    console.log("\n[migrate] DRY-RUN complete. Re-run with EXECUTE=true to send transactions.");
    return;
  }

  // Execute: per holder, top up NEW then burn OLD (idempotent).
  for (const p of plan) {
    if (p.mintAmt > 0n) await (await sf.mint(p.h, p.mintAmt)).wait();
    await (await old.burnByKeeper(p.h, p.oldBal)).wait();
    console.log(`   migrated ${p.h} (${p.oldBal})`);
  }

  // Seed locks in chunks.
  const CHUNK = 100;
  for (let i = 0; i < lockPairs.length; i += CHUNK) {
    const slice = lockPairs.slice(i, i + CHUNK);
    await (await sf.setLockBatch(slice.map((x) => x[0]), slice.map((x) => x[1]))).wait();
    console.log(`   seeded locks ${i}..${i + slice.length}`);
  }

  // Reconcile.
  let ok = true;
  for (const p of plan) {
    const oldBal = await old.balanceOf(p.h);
    const newBal = await sf.balanceOf(p.h);
    if (oldBal !== 0n || newBal !== p.oldBal) {
      ok = false;
      console.error(`   MISMATCH ${p.h}: old=${oldBal} new=${newBal} expected new=${p.oldBal}`);
    }
  }
  console.log(ok ? "\n[migrate] ✅ reconciled — all holders migrated 1:1." : "\n[migrate] ❌ reconciliation FAILED — investigate before unpausing.");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
