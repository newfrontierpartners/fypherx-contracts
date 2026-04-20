const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

// April-audit H-5: settlement now requires an EIP-712 signature from the
// `tradeSigner` key in addition to the relayer allowlist. The tests below
// build the typed-data envelope the contract expects and exercise the
// auth, replay, and bad-signature paths.
describe("FypherXSettlement", function () {
  async function deployFixture() {
    const [owner, relayer, signer, outsider, evilSigner] = await ethers.getSigners();
    const Settlement = await ethers.getContractFactory("FypherXSettlement");
    const settlement = await Settlement.deploy(relayer.address, signer.address);
    const settlementAddress = await settlement.getAddress();
    const { chainId } = await ethers.provider.getNetwork();

    const domain = {
      name: "FypherXSettlement",
      version: "1",
      chainId,
      verifyingContract: settlementAddress,
    };

    const types = {
      Settle: [
        { name: "tradeId", type: "bytes32" },
        { name: "marketId", type: "bytes32" },
        { name: "makerSubaccountId", type: "bytes32" },
        { name: "takerSubaccountId", type: "bytes32" },
        { name: "priceE18", type: "uint256" },
        { name: "quantityE18", type: "uint256" },
        { name: "makerFeeE18", type: "uint256" },
        { name: "takerFeeE18", type: "uint256" },
        { name: "payloadHash", type: "bytes32" },
      ],
    };

    function makeTrade(overrides = {}) {
      return {
        tradeId: ethers.id("trade-1"),
        marketId: ethers.encodeBytes32String("BTC-PERP"),
        makerSubaccountId: ethers.id("maker"),
        takerSubaccountId: ethers.id("taker"),
        priceE18: ethers.parseUnits("60000", 18),
        quantityE18: ethers.parseUnits("0.1", 18),
        makerFeeE18: 0n,
        takerFeeE18: 0n,
        payload: "0x1234",
        ...overrides,
      };
    }

    async function signTrade(trade, signerWallet = signer) {
      // The on-chain typed-data hashes `keccak256(payload)`, so the
      // off-chain signing input mirrors that — the struct field is
      // `payloadHash`, not the raw payload bytes.
      const message = {
        tradeId: trade.tradeId,
        marketId: trade.marketId,
        makerSubaccountId: trade.makerSubaccountId,
        takerSubaccountId: trade.takerSubaccountId,
        priceE18: trade.priceE18,
        quantityE18: trade.quantityE18,
        makerFeeE18: trade.makerFeeE18,
        takerFeeE18: trade.takerFeeE18,
        payloadHash: ethers.keccak256(trade.payload),
      };
      return signerWallet.signTypedData(domain, types, message);
    }

    return {
      owner,
      relayer,
      signer,
      outsider,
      evilSigner,
      settlement,
      makeTrade,
      signTrade,
    };
  }

  it("permits only relayers to settle trades", async function () {
    const { outsider, settlement, makeTrade, signTrade } = await deployFixture();
    const trade = makeTrade();
    const signature = await signTrade(trade);

    await assert.rejects(
      settlement.connect(outsider).settleTrade(trade, signature),
      /not relayer/,
    );
  });

  it("rejects a settlement signed by the wrong key", async function () {
    const { relayer, evilSigner, settlement, makeTrade, signTrade } = await deployFixture();
    const trade = makeTrade();
    // Signed by an unauthorised key — the relayer cannot launder it.
    const badSignature = await signTrade(trade, evilSigner);

    await assert.rejects(
      settlement.connect(relayer).settleTrade(trade, badSignature),
      /invalid signature/,
    );
  });

  it("rejects a settlement whose signature does not match the trade fields", async function () {
    const { relayer, settlement, makeTrade, signTrade } = await deployFixture();
    const trade = makeTrade();
    const signature = await signTrade(trade);

    // Tamper with quantity after signing — the digest changes, so
    // recovery yields a different address than `tradeSigner`.
    const tampered = { ...trade, quantityE18: ethers.parseUnits("1", 18) };

    await assert.rejects(
      settlement.connect(relayer).settleTrade(tampered, signature),
      /invalid signature/,
    );
  });

  it("prevents duplicate settlement replay", async function () {
    const { relayer, settlement, makeTrade, signTrade } = await deployFixture();
    const trade = makeTrade();
    const signature = await signTrade(trade);

    await settlement.connect(relayer).settleTrade(trade, signature);

    await assert.rejects(
      settlement.connect(relayer).settleTrade(trade, signature),
      /trade already settled/,
    );
  });
});
