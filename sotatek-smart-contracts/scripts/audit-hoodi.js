/**
 * Read-only state audit for the HOODI deploy. Reports the
 * end-to-end wiring that the customer mint / burn / epoch / yield
 * paths depend on, so we can see exactly which rows still need
 * follow-up before the full {@code /earn} flow works.
 *
 * Usage:
 *   npx hardhat run scripts/audit-hoodi.js --network hoodi
 *
 * Output: a checklist with ✓ / ✗ per row. No state writes.
 */
const { ethers } = require("hardhat");
const addresses = require("./lib/addresses");

const EXPECTED_CHAIN_ID = 560048;

// Gateway-side EOAs that the on-chain wiring must match. The signer
// is what BACKEND_SIGNER_PRIVATE_KEY in the gateway derives to; the
// custodian is whatever fypherx-chain-config currently points
// FYPHERX_RESERVE_POOL_ADDRESS at. Both are dev-cluster values.
const GATEWAY_SIGNER    = "0x31B60b11533c97b5ED7b1B650D31855F3754Acb4";
const GATEWAY_CUSTODIAN = "0x570B0F5D005d14a477B5FEacC450e8f002063cc7";

function chk(label, ok, detail) {
  const mark = ok ? "✓" : "✗";
  console.log(`  ${mark} ${label}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`requires chainId ${EXPECTED_CHAIN_ID}, got ${chainId}`);
  }
  const addrs = addresses.load(chainId);

  console.log("════════════════════════════════════════════════════════");
  console.log(`  HOODI audit @ chainId ${chainId}`);
  console.log("════════════════════════════════════════════════════════");
  console.log(`  FypherMinting       : ${addrs.FypherMinting}`);
  console.log(`  FypherBurnQueue     : ${addrs.FypherBurnQueue}`);
  console.log(`  FyusdEpochSettlement: ${addrs.FyusdEpochSettlement}`);
  console.log(`  FyusdEpochRedemption: ${addrs.FyusdEpochRedemption}`);
  console.log(`  FyusdYieldVault     : ${addrs.FyusdYieldVault}`);
  console.log(`  RusdYieldVault      : ${addrs.RusdYieldVault}`);
  console.log(`  FypherStakingHub    : ${addrs.FypherStakingHub}`);
  console.log("");

  let pass = 0, fail = 0;
  function tick(ok) { ok ? pass++ : fail++; }

  // ── 1. FypherMinting ────────────────────────────────────────────
  console.log("── FypherMinting ──");
  const minting = await ethers.getContractAt("FypherMinting", addrs.FypherMinting);
  tick(chk("supportedAssets[USDT]", await minting.supportedAssets(addrs.USDT)));
  tick(chk("supportedAssets[USDC]", await minting.supportedAssets(addrs.USDC)));
  const signer = await minting.backendSigner();
  tick(chk(`backendSigner == ${GATEWAY_SIGNER}`, signer.toLowerCase() === GATEWAY_SIGNER.toLowerCase(), `actual ${signer}`));
  tick(chk(`custodianAddresses[${GATEWAY_CUSTODIAN}]`, await minting.custodianAddresses(GATEWAY_CUSTODIAN)));

  // ── 2. FypherBurnQueue ──────────────────────────────────────────
  console.log("\n── FypherBurnQueue ──");
  const burnQ = await ethers.getContractAt("FypherBurnQueue", addrs.FypherBurnQueue);
  tick(chk("supportedAssets[USDT]", await burnQ.supportedAssets(addrs.USDT)));
  tick(chk("supportedAssets[USDC]", await burnQ.supportedAssets(addrs.USDC)));
  // Custodian source for the burn payout — burnQ doesn't have its own
  // custodian list; it pulls from FypherMinting's custodianAddresses
  // map via shared SettingManagement, so the FypherMinting check
  // above covers it.

  // ── 3. FyusdEpochSettlement ─────────────────────────────────────
  console.log("\n── FyusdEpochSettlement ──");
  const epochSettle = await ethers.getContractAt("FyusdEpochSettlement", addrs.FyusdEpochSettlement);
  tick(chk("supportedAssets[USDT]", await epochSettle.supportedAssets(addrs.USDT)));
  tick(chk("supportedAssets[USDC]", await epochSettle.supportedAssets(addrs.USDC)));

  // ── 4. FyusdEpochRedemption ─────────────────────────────────────
  // The redemption mirror — same shape, separate proxy.
  if (addrs.FyusdEpochRedemption && addrs.FyusdEpochRedemption !== ethers.ZeroAddress) {
    console.log("\n── FyusdEpochRedemption ──");
    try {
      const epochRedeem = await ethers.getContractAt("FyusdEpochRedemption", addrs.FyusdEpochRedemption);
      tick(chk("supportedAssets[USDT]", await epochRedeem.supportedAssets(addrs.USDT)));
      tick(chk("supportedAssets[USDC]", await epochRedeem.supportedAssets(addrs.USDC)));
    } catch (e) {
      console.log(`  ✗ FyusdEpochRedemption read failed: ${e.message?.slice(0,80)}`);
      fail++;
    }
  }

  // ── 5. FyusdYieldVault (vFYUSD) ─────────────────────────────────
  if (addrs.FyusdYieldVault && addrs.FyusdYieldVault !== ethers.ZeroAddress) {
    console.log("\n── FyusdYieldVault (vFYUSD) ──");
    try {
      const vault = new ethers.Contract(addrs.FyusdYieldVault, [
        "function asset() view returns (address)",
        "function adapter() view returns (address)",
        "function paused() view returns (bool)",
      ], ethers.provider);
      const asset = await vault.asset();
      tick(chk(`asset() == FYUSD`, asset.toLowerCase() === addrs.FYUSD.toLowerCase(), `actual ${asset}`));
      try {
        const adapter = await vault.adapter();
        tick(chk(`adapter() != 0`, adapter !== ethers.ZeroAddress, `${adapter}`));
      } catch { console.log(`  ? adapter() — getter not present (older impl?)`); }
    } catch (e) {
      console.log(`  ✗ FyusdYieldVault read failed: ${e.message?.slice(0,80)}`);
      fail++;
    }
  }

  // ── 6. RusdYieldVault (vRUSD) ───────────────────────────────────
  if (addrs.RusdYieldVault && addrs.RusdYieldVault !== ethers.ZeroAddress) {
    console.log("\n── RusdYieldVault (vRUSD) ──");
    try {
      const vault = new ethers.Contract(addrs.RusdYieldVault, [
        "function asset() view returns (address)",
        "function adapter() view returns (address)",
      ], ethers.provider);
      const asset = await vault.asset();
      tick(chk(`asset() == RUSD`, asset.toLowerCase() === addrs.RUSD.toLowerCase(), `actual ${asset}`));
      try {
        const adapter = await vault.adapter();
        tick(chk(`adapter() != 0`, adapter !== ethers.ZeroAddress, `${adapter}`));
      } catch { console.log(`  ? adapter() — getter not present`); }
    } catch (e) {
      console.log(`  ✗ RusdYieldVault read failed: ${e.message?.slice(0,80)}`);
      fail++;
    }
  }

  // ── 7. Cooldown vaults (sRUSD / stAUSD / StakedFYP) ────────────
  const cooldownVaults = [
    { name: "StakedRUSD (sRUSD)", addr: addrs.StakedRUSD, expectedAsset: addrs.RUSD,  expectedSiloAddr: addrs.RUSDSilo  },
    { name: "StakedAUSD (stAUSD)", addr: addrs.stAUSD,    expectedAsset: addrs.FYUSD, expectedSiloAddr: addrs.stAUSDSilo },
    { name: "StakedFYP (sFYP)",    addr: addrs.StakedFYP, expectedAsset: addrs.FYP,   expectedSiloAddr: addrs.FYPSilo    },
  ];
  for (const v of cooldownVaults) {
    if (!v.addr || v.addr === ethers.ZeroAddress || v.addr === "") continue;
    console.log(`\n── ${v.name} (${v.addr}) ──`);
    const vault = new ethers.Contract(v.addr, [
      "function asset() view returns (address)",
      "function silo() view returns (address)",
      "function totalAssets() view returns (uint256)",
      "function totalSupply() view returns (uint256)",
    ], ethers.provider);
    try {
      const asset = await vault.asset();
      tick(chk(`asset() == ${v.expectedAsset}`,
              asset.toLowerCase() === v.expectedAsset.toLowerCase(),
              `actual ${asset}`));
    } catch (e) { console.log(`  ✗ asset() failed: ${e.message?.slice(0,80)}`); fail++; }
    try {
      const silo = await vault.silo();
      const expected = v.expectedSiloAddr || "<unset>";
      const okSilo = !!silo && silo !== ethers.ZeroAddress
                   && (!v.expectedSiloAddr || silo.toLowerCase() === v.expectedSiloAddr.toLowerCase());
      tick(chk(`silo() != 0 (expected ${expected})`, okSilo, `actual ${silo}`));
    } catch { console.log(`  ? silo() not present (older impl?)`); }
    try {
      console.log(`  totalAssets: ${await vault.totalAssets()}`);
      console.log(`  totalSupply: ${await vault.totalSupply()}`);
    } catch { /* irrelevant for audit */ }
  }

  // ── 8. FypherStakingHub ─────────────────────────────────────────
  if (addrs.FypherStakingHub && addrs.FypherStakingHub !== ethers.ZeroAddress) {
    console.log("\n── FypherStakingHub ──");
    try {
      const hub = await ethers.getContractAt("FypherStakingHub", addrs.FypherStakingHub);
      const len = Number(await hub.poolsLength());
      console.log(`  pools registered: ${len}`);
      for (let i = 0; i < len; i++) {
        const info = await hub.poolInfo(i);
        console.log(`    [${i}] underlying=${info.underlying}  weight=${info.weight}`);
      }
    } catch (e) {
      console.log(`  ? StakingHub read failed: ${e.message?.slice(0,80)}`);
    }
  }

  console.log("");
  console.log("════════════════════════════════════════════════════════");
  console.log(`  Pass: ${pass}    Fail: ${fail}`);
  console.log("════════════════════════════════════════════════════════");
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
