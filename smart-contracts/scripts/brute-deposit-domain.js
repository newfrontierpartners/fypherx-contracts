// READ-ONLY: find which EIP-712 domain / signing scheme the gateway actually
// used, by brute-forcing candidates until ecrecover == the gateway signer 0x31b6.
const { ethers } = require("hardhat");

const TARGET = "0x31B60b11533c97b5ED7b1B650D31855F3754Acb4".toLowerCase(); // gateway EpochDepositService signer
const EP = "0x10E5a801f5272a5A32604F196960e94a3442d59b";

const quote = {
  user:            "0x3C886D7C56Ca228FB575aAaa4890C5dbB716eC99",
  epochId:         1n,
  collateralAsset: "0x67F75A12Ba115429494a894755E768847e66Ba2A",
  collateralAmount:1234000000n,
  fyusdAmount:     1230298000000000000000n,
  nonce:           1780899962n,
  expiry:          1780900562n,
};
const sig = "0x7529d3f54bda817280c8387ec50df10750267311c9ed81a006219d4034508bbf58b86c0b1b9f28a37b7e222f92d1142a6e9b0d48910f51901e7755a9ca63094f1c";

const types = { DepositQuote: [
  {name:"user",type:"address"},{name:"epochId",type:"uint256"},
  {name:"collateralAsset",type:"address"},{name:"collateralAmount",type:"uint256"},
  {name:"fyusdAmount",type:"uint256"},{name:"nonce",type:"uint256"},{name:"expiry",type:"uint256"},
]};

const chainIds = [560048, 11155111, 97, 56, 1, 17000, 5, 31337, 1337];
const contracts = [
  EP,
  "0xAe5e7D463eAA33c7942D29eecB7747FFc268f913", // application.yml default (sepolia)
  "0x6d9f036897777CAF0C252fA60F6FEA7210CD4731", // settlement contract addr from configmap
  "0xD1bbd247be78c68CDEB8486744Bd4513e62025E6", // fyusd
  ethers.ZeroAddress,
];
const names = ["FyusdEpochSettlement","Fypher","FypherEpoch","FyusdEpochRedemption"];
const versions = ["1","1.0","0.1","2"];

function tryRec(label, digest) {
  try {
    const r = ethers.recoverAddress(digest, sig).toLowerCase();
    if (r === TARGET) { console.log("★★★ FOUND:", label, "→", r); return true; }
  } catch {}
  return false;
}

async function main() {
  let found = false;
  // A. EIP-712 domain variations
  for (const name of names) for (const version of versions)
    for (const chainId of chainIds) for (const verifyingContract of contracts) {
      const domain = {name, version, chainId, verifyingContract};
      const digest = ethers.TypedDataEncoder.hash(domain, types, quote);
      if (tryRec(`EIP712 name=${name} ver=${version} chain=${chainId} vc=${verifyingContract}`, digest)) found = true;
    }
  // B. raw struct hash (no domain)
  const structHash = ethers.TypedDataEncoder.hashStruct("DepositQuote", types, quote);
  if (tryRec("rawStructHash", structHash)) found = true;
  // C. personal_sign over the contract digest / struct hash
  for (const m of [structHash]) {
    try { const r = ethers.verifyMessage(ethers.getBytes(m), sig).toLowerCase();
      if (r===TARGET) { console.log("★★★ FOUND: personal_sign(structHash)"); found = true; } } catch {}
  }
  // D. sanity: confirm our encoder reproduces the contract digest for the matching domain
  const probe = ethers.TypedDataEncoder.hash({name:"FyusdEpochSettlement",version:"1",chainId:560048,verifyingContract:EP}, types, quote);
  console.log("\nencoder digest (name=FyusdEpochSettlement,v=1,chain=560048,vc=EP):", probe);
  console.log("(should equal contract digest 0x102b8f3a167325a04543972065b8c4c5c93515c4f8a97f5bb4141cb1cfb8634b)");
  if (!found) console.log("\n❌ no candidate recovered the gateway signer — mismatch is in the struct field values/types");
}
main().catch((e) => { console.error(e); process.exit(1); });
