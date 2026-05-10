/**
 * Promote the new HOODI ReservePool to be a registered custodian on
 * FypherMinting. The dev-cluster bootstrap originally registered the
 * deployer EOA as a stand-in (because no ReservePool existed yet);
 * now that one is deployed we add the real address as a custodian
 * too. Both stay registered — the gateway picks one via
 * fypherx-chain-config.FYPHERX_RESERVE_POOL_ADDRESS, and keeping the
 * EOA custodian around is harmless idempotency.
 *
 * Idempotent: skips the call if ReservePool is already a custodian.
 *
 * Usage:
 *   source .env.hoodi-deployer
 *   npx hardhat run scripts/wire-reserve-pool-custodian-hoodi.js --network hoodi
 */
const { ethers } = require("hardhat");
const addresses = require("./lib/addresses");

const EXPECTED_CHAIN_ID = 560048;

const ABI = [
  "function custodianAddresses(address) view returns (bool)",
  "function addCustodianAddress(address custodian) external",
];

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`requires chainId ${EXPECTED_CHAIN_ID}, got ${chainId}`);
  }

  const [deployer] = await ethers.getSigners();
  const addrs = addresses.load(chainId);

  if (!addrs.ReservePool) {
    throw new Error("ReservePool address missing — run deploy-staking-vaults-hoodi.js first");
  }
  if (!addrs.FypherMinting) {
    throw new Error("FypherMinting address missing");
  }

  const minting = new ethers.Contract(addrs.FypherMinting, ABI, deployer);
  const already = await minting.custodianAddresses(addrs.ReservePool);

  console.log(`FypherMinting:  ${addrs.FypherMinting}`);
  console.log(`ReservePool:    ${addrs.ReservePool}`);
  console.log(`already?        ${already}`);

  if (already) {
    console.log("✓ ReservePool already registered as custodian — skip");
    return;
  }

  const tx = await minting.addCustodianAddress(addrs.ReservePool);
  console.log(`tx: ${tx.hash}`);
  await tx.wait();
  // Public RPCs (publicnode et al.) lag a beat after tx.wait() — poll.
  let after = false;
  for (let i = 0; i < 5; i++) {
    after = await minting.custodianAddresses(addrs.ReservePool);
    if (after) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!after) throw new Error("POST-CHECK FAIL: ReservePool not registered after retries");
  console.log("✓ ReservePool now registered as custodian");
}

main().catch((e) => { console.error(e); process.exit(1); });
