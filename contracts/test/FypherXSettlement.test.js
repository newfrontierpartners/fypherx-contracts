const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

describe("FypherXSettlement", function () {
  async function deployFixture() {
    const [owner, relayer, outsider] = await ethers.getSigners();
    const Settlement = await ethers.getContractFactory("FypherXSettlement");
    const settlement = await Settlement.deploy(relayer.address);
    return { owner, relayer, outsider, settlement };
  }

  it("permits only relayers to settle trades", async function () {
    const { outsider, settlement } = await deployFixture();
    await assert.rejects(
      settlement.connect(outsider).settleTrade(
        ethers.id("trade-1"),
        ethers.encodeBytes32String("BTC-PERP"),
        ethers.id("maker"),
        ethers.id("taker"),
        ethers.parseUnits("60000", 18),
        ethers.parseUnits("0.1", 18),
        0,
        0,
        "0x"
      )
    , /not relayer/);
  });

  it("prevents duplicate settlement replay", async function () {
    const { relayer, settlement } = await deployFixture();
    const tradeId = ethers.id("trade-1");

    await settlement.connect(relayer).settleTrade(
      tradeId,
      ethers.encodeBytes32String("BTC-PERP"),
      ethers.id("maker"),
      ethers.id("taker"),
      ethers.parseUnits("60000", 18),
      ethers.parseUnits("0.1", 18),
      0,
      0,
      "0x1234"
    );

    await assert.rejects(
      settlement.connect(relayer).settleTrade(
        tradeId,
        ethers.encodeBytes32String("BTC-PERP"),
        ethers.id("maker"),
        ethers.id("taker"),
        ethers.parseUnits("60000", 18),
        ethers.parseUnits("0.1", 18),
        0,
        0,
        "0x1234"
      )
    , /trade already settled/);
  });
});
