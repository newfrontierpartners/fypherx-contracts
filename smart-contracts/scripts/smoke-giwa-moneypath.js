/**
 * GIWA end-to-end money-path smoke.
 *
 * Walks the entire self-contained GIWA flow as a real user would, against
 * whatever chain you point it at:
 *
 *   faucet USDT -> FyusdTeller.mint -> FYUSD
 *               -> FyusdYieldVault.deposit -> vFYUSD
 *               -> (time passes, adapter accrues)
 *               -> cooldownShares -> unstake -> FYUSD back, grown
 *               -> FyusdTeller.redeem -> USDT back
 *
 * <p>Why a script and not a unit test: the unit tests prove each contract
 * in isolation against fresh fixtures. This proves the <b>deployed and
 * wired</b> system — minter roles, supported-asset registries, adapter
 * bindings, cooldown config — which is exactly the layer a deploy script
 * can get wrong and a unit test can never catch.
 *
 * <p>Time travel (for the cooldown and yield accrual) only works on a
 * hardhat node, so against real GIWA the script performs the deposit and
 * then reports the cooldown deadline instead of fast-forwarding.
 *
 * Usage:
 *   # rehearsal against the in-memory chain
 *   GIWA_DRYRUN=1 npx hardhat node --port 8546
 *   npx hardhat run scripts/smoke-giwa-moneypath.js --network giwaLocal
 *
 *   # against the real L2 (deposit leg only; no time travel)
 *   npx hardhat run scripts/smoke-giwa-moneypath.js --network giwaSepolia
 */
const { ethers, network } = require("hardhat");
const addresses = require("./lib/addresses");

const EXPECTED_CHAIN_ID = 91342;
const ONE_USDT = 10n ** 6n;
const DEPOSIT_USDT = 1_000n * ONE_USDT;

function fmt(v, decimals = 18) {
  return ethers.formatUnits(v, decimals);
}

async function canTimeTravel() {
  try {
    await network.provider.send("evm_mine", []);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read `fn` until `predicate` holds.
 *
 * A receipt from `tx.wait()` only proves the transaction was mined — it does
 * NOT prove the node answering your next `eth_call` has that block yet. On
 * GIWA (1s blocks, load-balanced public RPC) a read issued immediately after a
 * write routinely lands on a replica one block behind and returns pre-state.
 * That is a property of the chain, not a bug in it, and a smoke test that
 * ignores it reports a perfectly good deployment as broken.
 */
async function readUntil(fn, predicate, { label = "state", tries = 25, delayMs = 700 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(
    `Timed out waiting for ${label} to settle (last value: ${last}). ` +
      `The transaction was mined, so this is either RPC lag beyond ` +
      `${((tries * delayMs) / 1000).toFixed(0)}s or a genuine wiring fault.`,
  );
}

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== EXPECTED_CHAIN_ID) {
    console.error(`ERROR: requires chainId ${EXPECTED_CHAIN_ID}, got ${chainId}.`);
    process.exit(1);
  }
  const [user] = await ethers.getSigners();
  const a = addresses.load(chainId);

  for (const key of ["USDT", "FYUSD", "FyusdTeller", "FyusdYieldVaultErc4626", "MockConcreteAdapterFyusd"]) {
    if (!a[key]) {
      console.error(`ERROR: addresses/${chainId}.json missing ${key} — finish the deploy runbook first.`);
      process.exit(1);
    }
  }

  const usdt = await ethers.getContractAt("MockERC20", a.USDT);
  const fyusd = await ethers.getContractAt("FYUSD", a.FYUSD);
  const teller = await ethers.getContractAt("FyusdTeller", a.FyusdTeller);
  const vault = await ethers.getContractAt("FyusdYieldVault", a.FyusdYieldVaultErc4626);

  console.log("═══════════════════════════════════════════════════════");
  console.log(`  GIWA money-path smoke — chainId ${chainId}`);
  console.log("═══════════════════════════════════════════════════════");
  console.log(`User: ${user.address}\n`);

  // ── Wiring assertions: fail loudly BEFORE moving value ────────────
  const minter = await fyusd.minter();
  if (minter.toLowerCase() !== a.FyusdTeller.toLowerCase()) {
    throw new Error(
      `FYUSD.minter is ${minter}, expected the teller ${a.FyusdTeller}. ` +
      `Run scripts/deploy-giwa-teller.js (it must run AFTER deploy-phase1.js).`,
    );
  }
  if (!(await teller.supported(a.USDT))) {
    throw new Error("FyusdTeller does not accept USDT — re-run deploy-giwa-teller.js.");
  }
  console.log("  ✓ FYUSD.minter == FyusdTeller");
  console.log("  ✓ FyusdTeller accepts USDT\n");

  // ── 1. Faucet ─────────────────────────────────────────────────────
  await (await usdt.mint(user.address, DEPOSIT_USDT)).wait();
  console.log(`1. faucet          +${fmt(DEPOSIT_USDT, 6)} USDT`);

  // ── 2. Mint FYUSD 1:1 ─────────────────────────────────────────────
  const fyusdBefore = await fyusd.balanceOf(user.address);
  await (await usdt.approve(a.FyusdTeller, DEPOSIT_USDT)).wait();
  await (await teller.mint(a.USDT, DEPOSIT_USDT)).wait();
  const fyusdAfter = await readUntil(
    () => fyusd.balanceOf(user.address),
    (v) => v > fyusdBefore,
    { label: "FYUSD balance after mint" },
  );
  const minted = fyusdAfter - fyusdBefore;
  console.log(`2. teller.mint      ${fmt(minted)} FYUSD   (reserve ${fmt(await teller.reserveOf(a.USDT), 6)} USDT)`);

  // ── 3. Earn deposit ───────────────────────────────────────────────
  const sharesBefore = await vault.balanceOf(user.address);
  await (await fyusd.approve(a.FyusdYieldVaultErc4626, minted)).wait();
  await (await vault.deposit(minted, user.address)).wait();
  const sharesAfter = await readUntil(
    () => vault.balanceOf(user.address),
    (v) => v > sharesBefore,
    { label: "vFYUSD share balance after deposit" },
  );
  const shares = sharesAfter - sharesBefore;
  console.log(`3. vault.deposit    ${fmt(shares)} vFYUSD  (vault assets ${fmt(await vault.totalAssets())} FYUSD)`);

  const cooldownSecs = 7 * 24 * 60 * 60;
  if (!(await canTimeTravel())) {
    console.log("\nRunning against a real chain — stopping after the deposit leg.");
    console.log(`Yield accrues continuously; the ${cooldownSecs / 86400}-day cooldown must elapse`);
    console.log("before cooldownShares -> unstake can complete. Re-run the tail");
    console.log("of this flow manually, or rehearse it on --network giwaLocal.");
    return;
  }

  // ── 4. Let the adapter accrue ─────────────────────────────────────
  // Measured as a delta on the vault's own total, not against this run's
  // deposit: the vault may already hold earlier positions, so `assets > minted`
  // would pass trivially on a chain with history.
  const assetsBefore = await vault.totalAssets();
  const ONE_YEAR = 365 * 24 * 60 * 60;
  await network.provider.send("evm_increaseTime", [ONE_YEAR]);
  await network.provider.send("evm_mine", []);
  const grown = await vault.totalAssets();
  console.log(`4. +1 year          vault assets ${fmt(grown)} FYUSD  (was ${fmt(assetsBefore)})`);
  if (grown <= assetsBefore) {
    throw new Error("Adapter did not accrue any yield — check MockConcreteAdapter wiring / apyBps.");
  }

  // ── 5. Cooldown + unstake ─────────────────────────────────────────
  const beforeUnstake = await fyusd.balanceOf(user.address);
  await (await vault.cooldownShares(shares)).wait();
  await network.provider.send("evm_increaseTime", [cooldownSecs + 1]);
  await network.provider.send("evm_mine", []);
  await (await vault.unstake(user.address)).wait();
  const afterUnstake = await fyusd.balanceOf(user.address);
  const back = afterUnstake - beforeUnstake;
  console.log(`5. unstake          ${fmt(back)} FYUSD returned  (+${fmt(back - minted)} yield)`);
  if (back <= minted) {
    throw new Error("Unstake returned no more than the principal — yield did not reach the user.");
  }

  // ── 6. Redeem back to USDT ────────────────────────────────────────
  // Only the principal is redeemable 1:1 — the yield is FYUSD minted by the
  // adapter's buffer and is not backed by escrowed USDT, which is the honest
  // shape of a simulated-yield testnet. Redeem the principal and keep the
  // rest as FYUSD so the reserve invariant stays exact.
  const redeemable = await teller.previewMint(a.USDT, await teller.reserveOf(a.USDT));
  const toRedeem = back < redeemable ? back : redeemable;
  await (await fyusd.approve(a.FyusdTeller, toRedeem)).wait();
  await (await teller.redeem(a.USDT, toRedeem)).wait();
  console.log(`6. teller.redeem    ${fmt(await usdt.balanceOf(user.address), 6)} USDT back`);

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  SMOKE PASSED — full GIWA money path works on-chain");
  console.log("═══════════════════════════════════════════════════════\n");
}

main().catch((err) => { console.error(`\nSMOKE FAILED: ${err.message}\n`); process.exit(1); });
