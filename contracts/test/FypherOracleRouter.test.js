const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

describe("FypherOracleRouter", function () {
  const marketId = ethers.encodeBytes32String("BTC-PERP");

  async function deployFixture() {
    const [owner, other] = await ethers.getSigners();
    const MockPriceOracle = await ethers.getContractFactory("MockPriceOracle");
    const FypherOracleRouter = await ethers.getContractFactory("FypherOracleRouter");

    const feed = await MockPriceOracle.deploy(8, 60000n * 10n ** 8n);
    const router = await FypherOracleRouter.deploy();
    await router.configureMarketOracle(marketId, await feed.getAddress(), 8, 120, true);

    return { owner, other, feed, router };
  }

  it("normalizes oracle answers to 1e18 precision", async function () {
    const { router } = await deployFixture();
    assert.equal(await router.getPriceE18(marketId), ethers.parseUnits("60000", 18));
  });

  it("rejects stale oracle data", async function () {
    const { router } = await deployFixture();
    await ethers.provider.send("evm_increaseTime", [121]);
    await ethers.provider.send("evm_mine", []);
    await assert.rejects(router.getPriceE18(marketId), /stale oracle price/);
  });

  it("rejects negative or zero oracle prices", async function () {
    const { feed, router } = await deployFixture();
    await feed.setLatestAnswer(0);
    await assert.rejects(router.getPriceE18(marketId), /invalid oracle price/);
  });

  it("allows only the owner to reconfigure a market feed", async function () {
    const { other, feed, router } = await deployFixture();
    await assert.rejects(
      router.connect(other).configureMarketOracle(marketId, await feed.getAddress(), 8, 120, true)
    , /not owner/);
  });
});
