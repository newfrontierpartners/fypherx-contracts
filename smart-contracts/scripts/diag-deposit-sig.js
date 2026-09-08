// READ-ONLY diagnostic: recover the actual signer of a failed epoch deposit and
// compare to the contract's backendSigner + expected digest. No key, no tx.
const { ethers } = require("hardhat");

const EP = "0x10E5a801f5272a5A32604F196960e94a3442d59b";
const TX = process.env.DIAG_TX || "0x5495f039e103f8608cbb4a04bb423cddcb941d84bc64649f0e270440de1ac5e4";

async function main() {
  const provider = ethers.provider;
  const tx = await provider.getTransaction(TX);
  const data = tx.data;
  const body = data.slice(10); // strip 0x + 4-byte selector
  const W = (i) => "0x" + body.slice(i * 64, i * 64 + 64);

  const quote = {
    user:            ethers.getAddress("0x" + body.slice(0 * 64 + 24, 1 * 64)),
    epochId:         BigInt(W(1)),
    collateralAsset: ethers.getAddress("0x" + body.slice(2 * 64 + 24, 3 * 64)),
    collateralAmount:BigInt(W(3)),
    fyusdAmount:     BigInt(W(4)),
    nonce:           BigInt(W(5)),
    expiry:          BigInt(W(6)),
  };
  // bytes signature: offset W(7), len W(8), data W(9..)
  const sigLen = Number(BigInt(W(8)));
  const sig = "0x" + body.slice(9 * 64, 9 * 64 + sigLen * 2);

  console.log("selector:", data.slice(0, 10));
  console.log("quote:", {
    user: quote.user, epochId: quote.epochId.toString(), collateralAsset: quote.collateralAsset,
    collateralAmount: quote.collateralAmount.toString(), fyusdAmount: quote.fyusdAmount.toString(),
    nonce: quote.nonce.toString(), expiry: quote.expiry.toString(),
  });
  console.log("signature:", sig, "(len", sigLen, ")");

  const ep = new ethers.Contract(EP, [
    "function digest((address,uint256,address,uint256,uint256,uint256,uint256)) view returns (bytes32)",
    "function hashQuote((address,uint256,address,uint256,uint256,uint256,uint256)) pure returns (bytes32)",
    "function domainSeparator() view returns (bytes32)",
    "function backendSigner() view returns (address)",
  ], provider);

  const tuple = [quote.user, quote.epochId, quote.collateralAsset, quote.collateralAmount, quote.fyusdAmount, quote.nonce, quote.expiry];
  const d  = await ep.digest(tuple);
  const bs = await ep.backendSigner();
  const ds = await ep.domainSeparator();
  const recovered = ethers.recoverAddress(d, sig);

  console.log("\ncontract domainSeparator:", ds);
  console.log("contract digest(quote)  :", d);
  console.log("contract backendSigner  :", bs);
  console.log("★ recovered signer       :", recovered);
  console.log(recovered.toLowerCase() === bs.toLowerCase()
    ? "✅ MATCH — signature valid for current backendSigner (failure is NOT the signature)"
    : "❌ MISMATCH — gateway signed a different digest/struct than the contract expects");
}
main().catch((e) => { console.error(e); process.exit(1); });
