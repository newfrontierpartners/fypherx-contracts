const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

// April-audit H-5: settlement now requires an EIP-712 signature from the
// `tradeSigner` key in addition to the relayer allowlist.
describe("FypherXSettlement", function () {
  async function deployFixture() {
    const [owner, relayer, signer, outsider, evilSigner, newOwner] = await ethers.getSigners();
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

    return { owner, relayer, signer, outsider, evilSigner, newOwner, settlement, makeTrade, signTrade };
  }

  // ── Deployment ──────────────────────────────────────────────────────────
  it("sets owner, relayer and tradeSigner on deploy", async function () {
    const { owner, relayer, signer, settlement } = await deployFixture();
    assert.equal(await settlement.owner(), owner.address);
    assert.equal(await settlement.relayers(relayer.address), true);
    assert.equal(await settlement.tradeSigner(), signer.address);
  });

  // ── setOwner ────────────────────────────────────────────────────────────
  it("allows owner to transfer ownership", async function () {
    const { owner, newOwner, settlement } = await deployFixture();
    await settlement.connect(owner).setOwner(newOwner.address);
    assert.equal(await settlement.owner(), newOwner.address);
  });

  it("rejects setOwner from non-owner", async function () {
    const { outsider, newOwner, settlement } = await deployFixture();
    await assert.rejects(
      settlement.connect(outsider).setOwner(newOwner.address),
      /not owner/
    );
  });

  it("rejects setOwner to zero address", async function () {
    const { owner, settlement } = await deployFixture();
    await assert.rejects(
      settlement.connect(owner).setOwner(ethers.ZeroAddress),
      /invalid owner/
    );
  });

  // ── setRelayer ──────────────────────────────────────────────────────────
  it("allows owner to add and revoke relayers", async function () {
    const { owner, outsider, settlement } = await deployFixture();
    await settlement.connect(owner).setRelayer(outsider.address, true);
    assert.equal(await settlement.relayers(outsider.address), true);
    await settlement.connect(owner).setRelayer(outsider.address, false);
    assert.equal(await settlement.relayers(outsider.address), false);
  });

  it("rejects setRelayer from non-owner", async function () {
    const { outsider, settlement } = await deployFixture();
    await assert.rejects(
      settlement.connect(outsider).setRelayer(outsider.address, true),
      /not owner/
    );
  });

  // ── setTradeSigner ──────────────────────────────────────────────────────
  it("allows owner to change tradeSigner", async function () {
    const { owner, newOwner, settlement } = await deployFixture();
    await settlement.connect(owner).setTradeSigner(newOwner.address);
    assert.equal(await settlement.tradeSigner(), newOwner.address);
  });

  it("rejects setTradeSigner from non-owner", async function () {
    const { outsider, settlement } = await deployFixture();
    await assert.rejects(
      settlement.connect(outsider).setTradeSigner(outsider.address),
      /not owner/
    );
  });

  it("rejects setTradeSigner to zero address", async function () {
    const { owner, settlement } = await deployFixture();
    await assert.rejects(
      settlement.connect(owner).setTradeSigner(ethers.ZeroAddress),
      /invalid signer/
    );
  });

  // ── settleTrade ─────────────────────────────────────────────────────────
  it("permits only relayers to settle trades", async function () {
    const { outsider, settlement, makeTrade, signTrade } = await deployFixture();
    const trade = makeTrade();
    const signature = await signTrade(trade);
    await assert.rejects(
      settlement.connect(outsider).settleTrade(trade, signature),
      /not relayer/
    );
  });

  it("settles a valid trade and marks it as settled", async function () {
    const { relayer, settlement, makeTrade, signTrade } = await deployFixture();
    const trade = makeTrade();
    const signature = await signTrade(trade);
    await settlement.connect(relayer).settleTrade(trade, signature);
    assert.equal(await settlement.settledTrades(trade.tradeId), true);
  });

  it("rejects a settlement signed by the wrong key", async function () {
    const { relayer, evilSigner, settlement, makeTrade, signTrade } = await deployFixture();
    const trade = makeTrade();
    const badSignature = await signTrade(trade, evilSigner);
    await assert.rejects(
      settlement.connect(relayer).settleTrade(trade, badSignature),
      /invalid signature/
    );
  });

  it("rejects a settlement whose signature does not match the trade fields", async function () {
    const { relayer, settlement, makeTrade, signTrade } = await deployFixture();
    const trade = makeTrade();
    const signature = await signTrade(trade);
    const tampered = { ...trade, quantityE18: ethers.parseUnits("1", 18) };
    await assert.rejects(
      settlement.connect(relayer).settleTrade(tampered, signature),
      /invalid signature/
    );
  });

  it("prevents duplicate settlement replay", async function () {
    const { relayer, settlement, makeTrade, signTrade } = await deployFixture();
    const trade = makeTrade();
    const signature = await signTrade(trade);
    await settlement.connect(relayer).settleTrade(trade, signature);
    await assert.rejects(
      settlement.connect(relayer).settleTrade(trade, signature),
      /trade already settled/
    );
  });

  it("rejects settlement when tradeSigner is unset", async function () {
    const [owner, relayer] = await ethers.getSigners();
    const Settlement = await ethers.getContractFactory("FypherXSettlement");
    const settlement = await Settlement.deploy(relayer.address, ethers.ZeroAddress);
    const { chainId } = await ethers.provider.getNetwork();

    const domain = { name: "FypherXSettlement", version: "1", chainId, verifyingContract: await settlement.getAddress() };
    const types = { Settle: [
      { name: "tradeId", type: "bytes32" }, { name: "marketId", type: "bytes32" },
      { name: "makerSubaccountId", type: "bytes32" }, { name: "takerSubaccountId", type: "bytes32" },
      { name: "priceE18", type: "uint256" }, { name: "quantityE18", type: "uint256" },
      { name: "makerFeeE18", type: "uint256" }, { name: "takerFeeE18", type: "uint256" },
      { name: "payloadHash", type: "bytes32" },
    ]};
    const trade = {
      tradeId: ethers.id("t1"), marketId: ethers.encodeBytes32String("BTC-PERP"),
      makerSubaccountId: ethers.id("m"), takerSubaccountId: ethers.id("t"),
      priceE18: ethers.parseUnits("60000", 18), quantityE18: ethers.parseUnits("0.1", 18),
      makerFeeE18: 0n, takerFeeE18: 0n, payload: "0xabcd",
    };
    const sig = await relayer.signTypedData(domain, types, { ...trade, payloadHash: ethers.keccak256(trade.payload) });

    await assert.rejects(
      settlement.connect(relayer).settleTrade(trade, sig),
      /signer unset/
    );
  });

  // ── Two unique trades settle independently ──────────────────────────────
  it("settles two distinct trades independently", async function () {
    const { relayer, settlement, makeTrade, signTrade } = await deployFixture();
    const trade1 = makeTrade({ tradeId: ethers.id("trade-A") });
    const trade2 = makeTrade({ tradeId: ethers.id("trade-B"), priceE18: ethers.parseUnits("65000", 18) });
    await settlement.connect(relayer).settleTrade(trade1, await signTrade(trade1));
    await settlement.connect(relayer).settleTrade(trade2, await signTrade(trade2));
    assert.equal(await settlement.settledTrades(trade1.tradeId), true);
    assert.equal(await settlement.settledTrades(trade2.tradeId), true);
  });

  // ── domainSeparator / digest ────────────────────────────────────────────
  it("exposes a non-zero domainSeparator and consistent digest", async function () {
    const { settlement, makeTrade } = await deployFixture();
    const sep = await settlement.domainSeparator();
    assert.notEqual(sep, ethers.ZeroHash);

    const trade = makeTrade();
    const d = await settlement.digest(trade);
    assert.notEqual(d, ethers.ZeroHash);
    // digest is deterministic
    assert.equal(await settlement.digest(trade), d);
  });
});
