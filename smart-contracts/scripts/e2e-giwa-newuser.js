/**
 * End-to-end GIWA journey from a BRAND NEW wallet.
 *
 * <p>Different from smoke-giwa-moneypath.js on purpose. The smoke runs as the
 * deployer, which already holds every role, every allowance, and a large token
 * balance: it proves the contracts are wired, but it cannot prove a stranger
 * can use them. This script generates a fresh EOA with zero history, funds it
 * with just enough gas, and walks the exact path a GASOK reviewer would:
 *
 *   fund gas -> faucet USDT -> approve -> mint FYUSD -> approve -> Earn deposit
 *
 * Every step prints an explorer link, so the run leaves behind a reviewable
 * trail of transactions from a non-privileged address.
 *
 * <p>Deliberately stops before redeem: the Earn vault has a 7-day cooldown, so
 * the exit leg cannot complete in one run on a real chain. The deposit is the
 * leg that proves the money path works for a new user.
 *
 * Usage:
 *   source .env.giwa-deployer
 *   npx hardhat run scripts/e2e-giwa-newuser.js --network giwaSepolia
 */
const { ethers } = require("hardhat");
const addresses = require("./lib/addresses");

const EXPECTED_CHAIN_ID = 91342;
const EXPLORER = "https://sepolia-explorer.giwa.io";
const ONE_USDT = 10n ** 6n;
const FAUCET_USDT = 1_000n * ONE_USDT;
// GIWA gas is ~0.001 gwei; this is several hundred transactions' worth.
const GAS_GRANT = ethers.parseEther("0.0005");

function tx(hash) {
  return `${EXPLORER}/tx/${hash}`;
}

async function step(label, sendFn) {
  process.stdout.write(`  ${label.padEnd(34)} `);
  const t = await sendFn();
  const receipt = await t.wait();
  console.log(`ok  ${tx(receipt.hash)}`);
  return receipt;
}

/**
 * Read until `predicate` holds. On GIWA (1s blocks, load-balanced public RPC) a
 * read issued right after a write routinely lands on a replica one block behind
 * and returns pre-state, which looks exactly like a failed transaction.
 */
async function readUntil(fn, predicate, label, tries = 25, delayMs = 700) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`Timed out waiting for ${label} (last: ${last})`);
}

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== EXPECTED_CHAIN_ID) {
    console.error(`Requires chainId ${EXPECTED_CHAIN_ID}, got ${chainId}.`);
    process.exit(1);
  }

  const a = addresses.load(chainId);
  const [funder] = await ethers.getSigners();

  // A wallet with no history: nobody has granted it a role, seeded it, or
  // pre-approved anything.
  const user = ethers.Wallet.createRandom().connect(ethers.provider);

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  GIWA new-user journey");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  new wallet : ${user.address}`);
  console.log(`               ${EXPLORER}/address/${user.address}`);
  console.log("");

  const usdt = await ethers.getContractAt("MockERC20", a.USDT);
  const fyusd = await ethers.getContractAt("FYUSD", a.FYUSD);
  const teller = await ethers.getContractAt("FyusdTeller", a.FyusdTeller);
  const vault = await ethers.getContractAt("FyusdYieldVault", a.FyusdYieldVaultErc4626);

  await step("0. fund gas", () =>
    funder.sendTransaction({ to: user.address, value: GAS_GRANT }),
  );
  await readUntil(
    () => ethers.provider.getBalance(user.address),
    (v) => v > 0n,
    "gas to land",
  );

  // The faucet IS the token: MockERC20.mint is open, so a reviewer needs no
  // allowlist, no form, and no contact with us to obtain test funds.
  await step("1. faucet 1,000 USDT", () =>
    usdt.connect(user).mint(user.address, FAUCET_USDT),
  );
  const usdtBal = await readUntil(
    () => usdt.balanceOf(user.address),
    (v) => v >= FAUCET_USDT,
    "USDT balance",
  );

  await step("2. approve teller", () =>
    usdt.connect(user).approve(a.FyusdTeller, FAUCET_USDT),
  );
  await step("3. mint FYUSD 1:1", () =>
    teller.connect(user).mint(a.USDT, FAUCET_USDT),
  );
  const fyusdBal = await readUntil(
    () => fyusd.balanceOf(user.address),
    (v) => v > 0n,
    "FYUSD balance",
  );

  await step("4. approve Earn vault", () =>
    fyusd.connect(user).approve(a.FyusdYieldVaultErc4626, fyusdBal),
  );
  await step("5. deposit to Earn", () =>
    vault.connect(user).deposit(fyusdBal, user.address),
  );
  const shares = await readUntil(
    () => vault.balanceOf(user.address),
    (v) => v > 0n,
    "vFYUSD shares",
  );

  console.log("");
  console.log("  final balances");
  console.log(`    USDT   ${ethers.formatUnits(await usdt.balanceOf(user.address), 6)}`);
  console.log(`    FYUSD  ${ethers.formatEther(await fyusd.balanceOf(user.address))}`);
  console.log(`    vFYUSD ${ethers.formatEther(shares)}`);
  console.log(`    (started from ${ethers.formatUnits(usdtBal, 6)} USDT)`);
  console.log("");
  console.log("  reserve backing (teller holds this against every FYUSD minted)");
  console.log(`    ${ethers.formatUnits(await teller.reserveOf(a.USDT), 6)} USDT`);
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  PASSED — a wallet with no history completed the money path");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  ${EXPLORER}/address/${user.address}`);
  console.log("");
  // The key is intentionally NOT printed: this wallet exists only to leave a
  // reviewable trail, and nothing of value should ever be sent to it.
}

main().catch((e) => {
  console.error(`\nFAILED: ${e.message}\n`);
  process.exit(1);
});
