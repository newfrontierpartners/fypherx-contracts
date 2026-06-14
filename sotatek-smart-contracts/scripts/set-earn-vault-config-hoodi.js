/**
 * set-earn-vault-config-hoodi.js — post-deploy admin config for FyusdEarnVault.
 *
 * Runs the three onlyAdmin txs the deploy script intentionally leaves to the
 * admin (the SettingManagement admin = the gas-relayer EOA), idempotently:
 *   1. FyusdEarnVault.setKeeper(keeper)                  — backend hot wallet
 *   2. SettingManagement.setPoolConfigs("vFyusdEarnCooldown", 14 days)
 *   3. FyusdEarnVault.setPauserRole(pauser)              — pause guardian
 *
 * The admin key is NEVER read from the project env by tooling — you supply it
 * explicitly via EARN_ADMIN_PRIVATE_KEY for this run (or run the equivalent
 * from the redesigned admin console with the admin wallet connected).
 *
 * Usage:
 *   EARN_ADMIN_PRIVATE_KEY=0x<SettingManagement admin / gas-relayer key> \
 *   KEEPER_ADDRESS=0x5fA4e48f27CfE353E077a78962e2b578f72B1b97 \
 *   PAUSER_ADDRESS=0x5fA4e48f27CfE353E077a78962e2b578f72B1b97 \
 *     npx hardhat run scripts/set-earn-vault-config-hoodi.js --network hoodi
 *
 * Optional: VAULT_ADDRESS (default addresses/560048.json FyusdEarnVault),
 *           COOLDOWN_SECONDS (default 1209600 = 14d).
 */
const { ethers } = require("hardhat");
const addresses = require("./lib/addresses");

const VAULT_ABI = [
  "function keeper() view returns (address)",
  "function pauserRole() view returns (address)",
  "function settingManagement() view returns (address)",
  "function setKeeper(address)",
  "function setPauserRole(address)",
];
const SETTING_ABI = [
  "function getPoolConfigs(string) view returns (uint256)",
  "function setPoolConfigs(string,uint256)",
  "function hasRole(bytes32,address) view returns (bool)",
];
const COOLDOWN_KEY = "vFyusdEarnCooldown";
const ADMIN_ROLE = ethers.ZeroHash;

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const addrs = addresses.load(chainId);
  const VAULT = process.env.VAULT_ADDRESS || addrs.FyusdEarnVault;
  if (!VAULT || !ethers.isAddress(VAULT)) throw new Error("FyusdEarnVault address missing — deploy first");

  const key = process.env.EARN_ADMIN_PRIVATE_KEY;
  if (!key) {
    throw new Error(
      "EARN_ADMIN_PRIVATE_KEY env is required (the SettingManagement admin key). " +
      "Supply it explicitly for this run; it is not read from the project env.");
  }
  const admin = new ethers.Wallet(key, ethers.provider);
  const cooldown = BigInt(process.env.COOLDOWN_SECONDS || "1209600"); // 14d
  const keeper = process.env.KEEPER_ADDRESS || admin.address;
  const pauser = process.env.PAUSER_ADDRESS || admin.address;

  const vault = new ethers.Contract(VAULT, VAULT_ABI, admin);
  const smAddr = await vault.settingManagement();
  const sm = new ethers.Contract(smAddr, SETTING_ABI, admin);

  console.log("Chain:        ", chainId);
  console.log("Admin:        ", admin.address);
  console.log("FyusdEarnVault:", VAULT);
  console.log("SettingManagement:", smAddr);
  console.log("Keeper →      ", keeper);
  console.log("Pauser →      ", pauser);
  console.log("Cooldown →    ", cooldown.toString(), "s");

  // Pre-flight: the supplied key MUST be the SettingManagement admin.
  if (!(await sm.hasRole(ADMIN_ROLE, admin.address))) {
    throw new Error(`Supplied key ${admin.address} is NOT the SettingManagement admin — wrong key.`);
  }
  console.log("✅ pre-flight: signer is the SettingManagement admin");

  // 1. Keeper (idempotent).
  if ((await vault.keeper()).toLowerCase() !== keeper.toLowerCase()) {
    const tx = await vault.setKeeper(keeper);
    await tx.wait();
    console.log("✅ setKeeper:", keeper, "tx:", tx.hash);
  } else {
    console.log("ℹ keeper already set — skip");
  }

  // 2. Cooldown pool config (idempotent).
  if ((await sm.getPoolConfigs(COOLDOWN_KEY)) !== cooldown) {
    const tx = await sm.setPoolConfigs(COOLDOWN_KEY, cooldown);
    await tx.wait();
    console.log(`✅ setPoolConfigs(${COOLDOWN_KEY}, ${cooldown}) tx:`, tx.hash);
  } else {
    console.log("ℹ cooldown already set — skip");
  }

  // 3. Pauser (idempotent).
  if ((await vault.pauserRole()).toLowerCase() !== pauser.toLowerCase()) {
    const tx = await vault.setPauserRole(pauser);
    await tx.wait();
    console.log("✅ setPauserRole:", pauser, "tx:", tx.hash);
  } else {
    console.log("ℹ pauser already set — skip");
  }

  console.log("\n✓ Earn vault admin config complete. Remaining: Concrete whitelists the");
  console.log("  adapter, then enable the keeper config flags per-env.");
}

main().catch((e) => { console.error(e); process.exit(1); });
