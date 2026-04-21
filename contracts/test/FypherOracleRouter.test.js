const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

describe("FypherOracleRouter", function () {
  const btcMarket = ethers.encodeBytes32String("BTC-PERP");
  const ethMarket = ethers.encodeBytes32String("ETH-PERP");

  async function deployFixture() {
    const [owner, other, newOwner] = await ethers.getSigners();
    const MockPriceOracle = await ethers.getContractFactory("MockPriceOracle");
    const FypherOracleRouter = await ethers.getContractFactory("FypherOracleRouter");

    const btcFeed = await MockPriceOracle.deploy(8, 60000n * 10n ** 8n);
    const ethFeed = await MockPriceOracle.deploy(8, 3000n * 10n ** 8n);
    const router = await FypherOracleRouter.deploy();
    await router.configureMarketOracle(btcMarket, await btcFeed.getAddress(), 8, 120, true);
    await router.configureMarketOracle(ethMarket, await ethFeed.getAddress(), 8, 120, true);

    return { owner, other, newOwner, btcFeed, ethFeed, router };
  }

  // ── Deployment ──────────────────────────────────────────────────────────
  it("sets owner on deploy", async function () {
    const { owner, router } = await deployFixture();
    assert.equal(await router.owner(), owner.address);
  });

  // ── setOwner ────────────────────────────────────────────────────────────
  it("allows owner to transfer ownership", async function () {
    const { owner, newOwner, router } = await deployFixture();
    await router.connect(owner).setOwner(newOwner.address);
    assert.equal(await router.owner(), newOwner.address);
  });

  it("rejects setOwner from non-owner", async function () {
    const { other, newOwner, router } = await deployFixture();
    await assert.rejects(
      router.connect(other).setOwner(newOwner.address),
      /not owner/
    );
  });

  // ── configureMarketOracle ───────────────────────────────────────────────
  it("allows only the owner to reconfigure a market feed", async function () {
    const { other, btcFeed, router } = await deployFixture();
    await assert.rejects(
      router.connect(other).configureMarketOracle(btcMarket, await btcFeed.getAddress(), 8, 120, true),
      /not owner/
    );
  });

  it("reverts getPriceE18 for an unconfigured market", async function () {
    const { router } = await deployFixture();
    const unknown = ethers.encodeBytes32String("SOL-PERP");
    await assert.rejects(router.getPriceE18(unknown));
  });

  // ── getPriceE18 — normalization ─────────────────────────────────────────
  it("normalizes oracle answers to 1e18 precision (8 decimals)", async function () {
    const { router } = await deployFixture();
    assert.equal(await router.getPriceE18(btcMarket), ethers.parseUnits("60000", 18));
  });

  it("normalizes a 6-decimal feed to 1e18", async function () {
    const [owner] = await ethers.getSigners();
    const MockPriceOracle = await ethers.getContractFactory("MockPriceOracle");
    const FypherOracleRouter = await ethers.getContractFactory("FypherOracleRouter");
    const feed6 = await MockPriceOracle.deploy(6, 3000n * 10n ** 6n);
    const router2 = await FypherOracleRouter.deploy();
    const mkt = ethers.encodeBytes32String("ETH-USD-6");
    await router2.connect(owner).configureMarketOracle(mkt, await feed6.getAddress(), 6, 120, true);
    assert.equal(await router2.getPriceE18(mkt), ethers.parseUnits("3000", 18));
  });

  it("reads both BTC and ETH markets correctly", async function () {
    const { router } = await deployFixture();
    assert.equal(await router.getPriceE18(btcMarket), ethers.parseUnits("60000", 18));
    assert.equal(await router.getPriceE18(ethMarket), ethers.parseUnits("3000", 18));
  });

  // ── staleness ───────────────────────────────────────────────────────────
  it("rejects stale oracle data", async function () {
    const { router } = await deployFixture();
    await ethers.provider.send("evm_increaseTime", [121]);
    await ethers.provider.send("evm_mine", []);
    await assert.rejects(router.getPriceE18(btcMarket), /stale oracle price/);
  });

  // ── invalid price ───────────────────────────────────────────────────────
  it("rejects negative or zero oracle prices", async function () {
    const { btcFeed, router } = await deployFixture();
    await btcFeed.setLatestAnswer(0);
    await assert.rejects(router.getPriceE18(btcMarket), /invalid oracle price/);
  });

  it("rejects negative price from feed", async function () {
    const { btcFeed, router } = await deployFixture();
    await btcFeed.setLatestAnswer(-1);
    await assert.rejects(router.getPriceE18(btcMarket), /invalid oracle price/);
  });

  // ── pause ────────────────────────────────────────────────────────────────
  it("freezes price reads across all markets when paused, and only the owner can toggle", async function () {
    const { owner, other, router } = await deployFixture();

    await assert.rejects(router.connect(other).setPaused(true), /not owner/);

    await router.connect(owner).setPaused(true);
    assert.equal(await router.paused(), true);
    await assert.rejects(router.getPriceE18(btcMarket), /oracle paused/);
    await assert.rejects(router.getPriceE18(ethMarket), /oracle paused/);

    await router.connect(owner).setPaused(false);
    assert.equal(await router.paused(), false);
    assert.equal(await router.getPriceE18(btcMarket), ethers.parseUnits("60000", 18));
  });

  it("price update on feed reflects immediately in router", async function () {
    const { btcFeed, router } = await deployFixture();
    await btcFeed.setLatestAnswer(70000n * 10n ** 8n);
    assert.equal(await router.getPriceE18(btcMarket), ethers.parseUnits("70000", 18));
  });
});
