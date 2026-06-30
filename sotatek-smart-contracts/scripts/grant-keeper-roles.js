/**
 * grant-keeper-roles.js — grant the backend keeper its operational roles on an
 * already-deployed StakedFYUSD (sFYUSD). Idempotent: skips roles already held.
 *
 * Use after deploy-staked-fyusd.js when the keeper hot wallet differs from the
 * deployer (the normal case — the deployer keeps DEFAULT_ADMIN_ROLE only).
 *
 *   SFYUSD=0x<token> KEEPER=0x<keeper hot wallet> \
 *   npx hardhat run scripts/grant-keeper-roles.js --network hoodi
 */
const { ethers } = require("hardhat");

async function main() {
  const [admin] = await ethers.getSigners();
  if (!admin) throw new Error("No signer — is the deployer key set for this network?");

  const sfAddr = process.env.SFYUSD;
  const keeper = process.env.KEEPER;
  if (!sfAddr || !ethers.isAddress(sfAddr)) throw new Error("set SFYUSD=0x<token>");
  if (!keeper || !ethers.isAddress(keeper)) throw new Error("set KEEPER=0x<keeper>");

  const net = await ethers.provider.getNetwork();
  console.log(`[grant] chainId=${net.chainId} admin=${admin.address}`);
  console.log(`[grant] token=${sfAddr} keeper=${ethers.getAddress(keeper)}`);

  const sf = await ethers.getContractAt("StakedFYUSD", sfAddr);

  // The keeper needs mint (deposit), burn (redeem) and lock (lock-up gate).
  // PAUSER is optional but mirrors the deploy default; grant it too.
  for (const role of ["MINTER_ROLE", "BURNER_ROLE", "LOCKER_ROLE", "PAUSER_ROLE"]) {
    const r = await sf[role]();
    if (await sf.hasRole(r, keeper)) {
      console.log(`[grant] ${role} already held → skip`);
      continue;
    }
    await (await sf.grantRole(r, keeper)).wait();
    console.log(`[grant] granted ${role} → ${keeper}`);
  }

  console.log("\n[grant] verify:");
  for (const role of ["MINTER_ROLE", "BURNER_ROLE", "LOCKER_ROLE", "PAUSER_ROLE"]) {
    const r = await sf[role]();
    console.log(`  ${role.padEnd(12)} keeper=${await sf.hasRole(r, keeper)}`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
