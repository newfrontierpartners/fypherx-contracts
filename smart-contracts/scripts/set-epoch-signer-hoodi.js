/**
 * set-epoch-signer-hoodi.js — align FyusdEpochSettlement.backendSigner with the
 * gateway's actual quote signer so user deposits stop reverting InvalidSignature().
 *
 * Diagnosis: the gateway signs epoch deposit quotes with 0x31b6…acb4
 * (EpochDepositService signer), but the epoch contract's backendSigner was set
 * to 0x570b… (deployer) at deploy time → every deposit reverts InvalidSignature.
 *
 * setBackendSigner is onlyAdmin on the epoch contract (onlyAdmin == SM.hasRole(0x0)).
 * The current SM admin is the gateway executor 0x5fa4e48f…, so run this with the
 * executor key (same as the acceptAdmin step):
 *
 *   HOODI_DEPLOYER_PRIVATE_KEY=<gateway executor key> \
 *     npx hardhat run scripts/set-epoch-signer-hoodi.js --network hoodi
 */
const { ethers } = require("hardhat");

const EPOCH       = process.env.EPOCH_ADDRESS  || "0x10E5a801f5272a5A32604F196960e94a3442d59b";
const NEW_SIGNER  = process.env.NEW_SIGNER     || "0x31b60b11533c97b5ed7b1b650d31855f3754acb4"; // gateway EpochDepositService signer

const ABI = [
  "function backendSigner() view returns (address)",
  "function setBackendSigner(address newSigner)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("No signer — set HOODI_DEPLOYER_PRIVATE_KEY to the executor (current SM admin) key?");
  const ep = new ethers.Contract(EPOCH, ABI, signer);

  const cur = await ep.backendSigner();
  console.log("Caller (must be SM admin = executor):", signer.address);
  console.log("Epoch backendSigner (current):       ", cur);
  console.log("Epoch backendSigner (target gateway):", NEW_SIGNER);
  if (cur.toLowerCase() === NEW_SIGNER.toLowerCase()) {
    console.log("✅ already aligned — nothing to do.");
    return;
  }

  const tx = await ep.setBackendSigner(NEW_SIGNER);
  console.log("setBackendSigner tx:", tx.hash);
  await tx.wait();
  console.log("Epoch backendSigner (now):", await ep.backendSigner());
  console.log("✅ Done — deposits will now verify against the gateway signer.");
}

main().catch((e) => { console.error(e); process.exit(1); });
