/**
 * estimate-deploy-gas.js — measure the REAL gas of the PROD deploy pipeline
 * by executing the exact deploy graph on the in-memory hardhat EVM and summing
 * each transaction's gasUsed. Gas is deterministic per bytecode/calldata, so
 * these numbers match mainnet (only the gas PRICE differs).
 *
 * Collateral (USDC/USDT) + Concrete vaults are real contracts on mainnet, so we
 * stand up mocks for them but EXCLUDE their gas (checkpoint resets after mocks).
 *
 *   npx hardhat run scripts/estimate-deploy-gas.js
 */
const { ethers, upgrades } = require("hardhat");

async function main() {
  const provider = ethers.provider;
  const [deployer, safe, watchdog, relayer] = await ethers.getSigners();

  // ── gas accounting: sum gasUsed of every tx mined since the last checkpoint
  let last = await provider.getBlockNumber();
  async function gasSince() {
    const now = await provider.getBlockNumber();
    let sum = 0n;
    for (let b = last + 1; b <= now; b++) {
      const blk = await provider.getBlock(b);
      for (const h of blk.transactions) {
        const r = await provider.getTransactionReceipt(h);
        sum += r.gasUsed;
      }
    }
    last = now;
    return sum;
  }

  // ── mocks for collateral + Concrete vaults (EXCLUDED from the total) ──
  const ERC20 = await ethers.getContractFactory("MockERC20");
  const V4626 = await ethers.getContractFactory("MockERC4626Vault");
  const usdc = await (await ERC20.deploy("USD Coin", "USDC", 6)).waitForDeployment();
  const usdt = await (await ERC20.deploy("Tether USD", "USDT", 6)).waitForDeployment();
  const concreteUsdc = await (await V4626.deploy(await usdc.getAddress(), "ct USDC", "ctUSDC")).waitForDeployment();
  const concreteUsdt = await (await V4626.deploy(await usdt.getAddress(), "ct USDT", "ctUSDT")).waitForDeployment();
  await gasSince(); // reset checkpoint — mock gas not counted

  const rows = [];
  const push = async (label) => rows.push([label, await gasSince()]);

  // ── STEP 1: core (SettingManagement + ReservePool + CircuitBreaker + wire) ──
  const Setting = await ethers.getContractFactory("SettingManagement");
  const sm = await upgrades.deployProxy(Setting, [deployer.address], { initializer: "initialize", kind: "transparent" });
  await sm.waitForDeployment();
  const smAddr = await sm.getAddress();
  const Reserve = await ethers.getContractFactory("ReservePool");
  const reserve = await (await Reserve.deploy(smAddr)).waitForDeployment();
  const Breaker = await ethers.getContractFactory("FypherCircuitBreaker");
  const breaker = await upgrades.deployProxy(Breaker, [smAddr, watchdog.address], { initializer: "initialize", kind: "transparent" });
  await breaker.waitForDeployment();
  await (await sm.setReservePool(await reserve.getAddress())).wait();
  await push("1. Core: SettingManagement + ReservePool + CircuitBreaker + setReservePool");

  // ── STEP 2 & 3: Earn vault + adapter, per asset ──
  const Vault = await ethers.getContractFactory("FyusdEarnVault");
  const Adapter = await ethers.getContractFactory("ConcreteStableAdapter");
  const vaultProxies = [];
  for (const [label, stable, concrete] of [
    ["2. Earn vault + adapter (USDC)", usdc, concreteUsdc],
    ["3. Earn vault + adapter (USDT)", usdt, concreteUsdt],
  ]) {
    const vault = await upgrades.deployProxy(Vault, [], { initializer: false, kind: "transparent" });
    await vault.waitForDeployment();
    const vAddr = await vault.getAddress();
    vaultProxies.push(vAddr);
    const adapter = await (await Adapter.deploy(await stable.getAddress(), await concrete.getAddress(), vAddr)).waitForDeployment();
    await (await vault.initialize(smAddr, await stable.getAddress(), await adapter.getAddress(), deployer.address)).wait();
    await push(label);
  }

  // ── STEP 4: Lock Registry + grant relayer locker ──
  const Registry = await ethers.getContractFactory("EarnLockRegistry");
  const registry = await (await Registry.deploy()).waitForDeployment();
  await (await registry.setLocker(relayer.address, true)).wait();
  await push("4. EarnLockRegistry + setLocker(relayer)");

  // ── STEP 5: admin transfer (transferAdmin + acceptAdmin) ──
  await (await sm.transferAdmin(safe.address)).wait();
  await (await sm.connect(safe).acceptAdmin()).wait();
  await push("5. SettingManagement transferAdmin + acceptAdmin(Safe)");

  // ── STEP 6: ProxyAdmin ownership → Safe (SM, CircuitBreaker, vault x2) ──
  const proxies = [smAddr, await breaker.getAddress(), ...vaultProxies];
  const seen = new Set();
  for (const p of proxies) {
    const pa = await upgrades.erc1967.getAdminAddress(p);
    if (seen.has(pa.toLowerCase())) continue;
    seen.add(pa.toLowerCase());
    const admin = new ethers.Contract(pa, ["function transferOwnership(address) external"], deployer);
    await (await admin.transferOwnership(safe.address)).wait();
  }
  await push(`6. ProxyAdmin transferOwnership → Safe (${seen.size} ProxyAdmins)`);

  // ── STEP 7: Lock Registry owner → Safe ──
  await (await registry.setOwner(safe.address)).wait();
  await push("7. EarnLockRegistry setOwner(Safe)");

  // ── report ──
  const total = rows.reduce((a, [, g]) => a + g, 0n);
  const fmt = (n) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  console.log("\n  PROD deploy — measured gas (in-memory EVM, == mainnet gas)\n");
  for (const [label, g] of rows) {
    console.log(`  ${String(fmt(g)).padStart(11)}  ${label}`);
  }
  console.log(`  ${"-".repeat(11)}`);
  console.log(`  ${String(fmt(total)).padStart(11)}  TOTAL gas\n`);

  console.log("  Cost @ gas price (ETH = gas × gwei × 1e-9):\n");
  for (const gwei of [5, 10, 15, 20, 30, 50]) {
    const eth = (Number(total) * gwei) / 1e9;
    console.log(`    ${String(gwei).padStart(2)} gwei  →  ${eth.toFixed(4)} ETH`);
  }
  console.log(`\n  (gas total: ${fmt(total)} ; excludes the one manual Safe acceptAdmin if executed from the Safe UI)`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
