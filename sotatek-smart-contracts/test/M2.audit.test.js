/**
 * M2 audit-cleanup verification.
 *
 * Covers every CertiK Pending finding scheduled for Milestone 2:
 *
 *   FYP-23 — FyusdEpochSettlement.sweepCollateral
 *   FYP-24 — FypherBurnQueue pauserRole + onlyPauserOrAdmin
 *   FYP-25 — zero-address guards on setPauserRole / setFeeReceiver /
 *             setReservePool
 *   FYP-27 — ReservePool.withdrawETH
 *   FYP-28 — SettingManagement.setFees MAX_FEE_BPS cap
 *   FYP-30 — input validation tightening across the epoch / staking /
 *             minting surface
 *   FYP-31 — FypherBurnQueue.sweepSurplus
 *   FYP-33 — earlyUnstake refuses vault as fee receiver
 *   FYP-43 — _accrueCooldown rejects fresh cooldown on top of a ready
 *             cooldown
 *   FYP-44 — FypherMinting.executeRedeem enforces burnPaused[asset]
 *   FYP-48 — FypherMinting._distributeCollateral assigns rounding
 *             remainder to the last route leg
 */
const assert = require("node:assert/strict");
const { ethers, upgrades, network } = require("hardhat");

const ONE = 10n ** 18n;
const SEVEN_DAYS = 7n * 24n * 60n * 60n;

async function increaseTime(seconds) {
    await network.provider.send("evm_increaseTime", [Number(seconds)]);
    await network.provider.send("evm_mine", []);
}

async function latestTimestamp() {
    const blk = await ethers.provider.getBlock("latest");
    return BigInt(blk.timestamp);
}

// ─── FYP-23 ──────────────────────────────────────────────────────────

describe("FYP-23 — FyusdEpochSettlement.sweepCollateral", () => {
    async function deploy() {
        const [deployer, executor, user] = await ethers.getSigners();

        const SettingManagement = await ethers.getContractFactory("SettingManagement");
        const setting = await upgrades.deployProxy(
            SettingManagement,
            [deployer.address],
            { initializer: "initialize", kind: "transparent" },
        );

        const MockERC20 = await ethers.getContractFactory("MockERC20");
        const usdt = await MockERC20.deploy("USDT", "USDT", 18);

        // Mock FYUSD with a minter slot so the contract can mint.
        const FYUSD = await ethers.getContractFactory("FYUSD");
        const fyusd = await upgrades.deployProxy(FYUSD, [deployer.address], {
            initializer: "initialize", kind: "transparent",
        });

        const EpochSettlement = await ethers.getContractFactory("FyusdEpochSettlement");
        const epoch = await upgrades.deployProxy(
            EpochSettlement,
            [
                await setting.getAddress(),
                await fyusd.getAddress(),
                deployer.address,    // backendSigner
                executor.address,    // backendExecutor
            ],
            { initializer: "initialize", kind: "transparent" },
        );

        await (await fyusd.setMinter(await epoch.getAddress())).wait();
        await (await epoch.setSupportedAsset(await usdt.getAddress(), true)).wait();

        // Seed user and approve.
        await (await usdt.mint(user.address, 1_000n * ONE)).wait();
        await (await usdt.connect(user).approve(await epoch.getAddress(), ethers.MaxUint256)).wait();

        return { deployer, executor, user, setting, usdt, fyusd, epoch };
    }

    async function signDeposit(signer, epochAddr, quote) {
        const { chainId } = await ethers.provider.getNetwork();
        const domain = {
            name: "FyusdEpochSettlement",
            version: "1",
            chainId,
            verifyingContract: epochAddr,
        };
        const types = {
            DepositQuote: [
                { name: "user", type: "address" },
                { name: "epochId", type: "uint256" },
                { name: "collateralAsset", type: "address" },
                { name: "collateralAmount", type: "uint256" },
                { name: "fyusdAmount", type: "uint256" },
                { name: "nonce", type: "uint256" },
                { name: "expiry", type: "uint256" },
            ],
        };
        return signer.signTypedData(domain, types, quote);
    }

    async function depositAndSettle(ctx, depositAmount) {
        const { deployer, executor, user, usdt, epoch } = ctx;
        await (await epoch.openEpoch(12 * 3600, 10 * 3600)).wait();
        const epochId = await epoch.nextEpochId();

        const quote = {
            user: user.address,
            epochId,
            collateralAsset: await usdt.getAddress(),
            collateralAmount: depositAmount,
            fyusdAmount: depositAmount,
            nonce: 1n,
            expiry: (await latestTimestamp()) + 3600n,
        };
        const sig = await signDeposit(deployer, await epoch.getAddress(), quote);
        await (await epoch.deposit(quote, sig)).wait();

        await increaseTime(10 * 3600 + 1);
        await (await epoch.lockEpoch(epochId)).wait();
        await (await epoch.connect(executor).settleEpoch(epochId, depositAmount)).wait();
        return epochId;
    }

    it("admin can sweep collateral once the epoch is SETTLED", async () => {
        const ctx = await deploy();
        const epochId = await depositAndSettle(ctx, 100n * ONE);

        const treasury = ethers.Wallet.createRandom().address;
        const balBefore = await ctx.usdt.balanceOf(treasury);

        await (await ctx.epoch.sweepCollateral(
            epochId,
            await ctx.usdt.getAddress(),
            treasury,
            100n * ONE,
        )).wait();

        const balAfter = await ctx.usdt.balanceOf(treasury);
        assert.equal(balAfter - balBefore, 100n * ONE);
    });

    it("rejects sweep on OPEN, LOCKED, and CANCELLED epochs", async () => {
        const ctx = await deploy();

        // OPEN
        await (await ctx.epoch.openEpoch(12 * 3600, 10 * 3600)).wait();
        const id = await ctx.epoch.nextEpochId();
        await assert.rejects(
            ctx.epoch.sweepCollateral(id, await ctx.usdt.getAddress(), ctx.deployer.address, 1n),
            (err) => err.message.includes("InvalidState"),
        );

        // CANCELLED
        await (await ctx.epoch.cancelEpoch(id, ethers.ZeroHash)).wait();
        await assert.rejects(
            ctx.epoch.sweepCollateral(id, await ctx.usdt.getAddress(), ctx.deployer.address, 1n),
            (err) => err.message.includes("InvalidState"),
        );
    });

    it("rejects non-admin callers", async () => {
        const ctx = await deploy();
        const epochId = await depositAndSettle(ctx, 100n * ONE);

        await assert.rejects(
            ctx.epoch.connect(ctx.user).sweepCollateral(
                epochId,
                await ctx.usdt.getAddress(),
                ctx.user.address,
                1n,
            ),
            (err) => err.message.includes("NotAdmin"),
        );
    });

    it("rejects zero address recipient and zero amount", async () => {
        const ctx = await deploy();
        const epochId = await depositAndSettle(ctx, 100n * ONE);

        await assert.rejects(
            ctx.epoch.sweepCollateral(epochId, await ctx.usdt.getAddress(), ethers.ZeroAddress, 1n),
            (err) => err.message.includes("ZeroAddress"),
        );
        await assert.rejects(
            ctx.epoch.sweepCollateral(epochId, await ctx.usdt.getAddress(), ctx.deployer.address, 0n),
            (err) => err.message.includes("ZeroAmount"),
        );
    });
});

// ─── FYP-24 ──────────────────────────────────────────────────────────

describe("FYP-24 — FypherBurnQueue pauserRole", () => {
    async function deploy() {
        const [deployer, pauser, nonAdmin] = await ethers.getSigners();
        const SettingManagement = await ethers.getContractFactory("SettingManagement");
        const setting = await upgrades.deployProxy(SettingManagement, [deployer.address], {
            initializer: "initialize", kind: "transparent",
        });
        const MockERC20 = await ethers.getContractFactory("MockERC20");
        const rusd = await MockERC20.deploy("RUSD", "RUSD", 18);
        const BurnQueue = await ethers.getContractFactory("FypherBurnQueue");
        const queue = await upgrades.deployProxy(
            BurnQueue,
            [await setting.getAddress(), await rusd.getAddress(), deployer.address],
            { initializer: "initialize", kind: "transparent" },
        );
        await (await queue.setPauserRole(pauser.address)).wait();
        await (await queue.setSupportedAsset(await rusd.getAddress(), true)).wait();
        return { deployer, pauser, nonAdmin, queue, rusd };
    }

    it("setPauserRole rejects zero address", async () => {
        const { queue } = await deploy();
        await assert.rejects(
            queue.setPauserRole(ethers.ZeroAddress),
            (err) => err.message.includes("ZeroAddress"),
        );
    });

    it("pauser can call setBurnPaused(true)", async () => {
        const { pauser, queue, rusd } = await deploy();
        await (await queue.connect(pauser).setBurnPaused(await rusd.getAddress(), true)).wait();
        assert.equal(await queue.burnPaused(await rusd.getAddress()), true);
    });

    it("pauser CANNOT unpause — admin only", async () => {
        const { pauser, queue, rusd } = await deploy();
        await (await queue.connect(pauser).setBurnPaused(await rusd.getAddress(), true)).wait();
        await assert.rejects(
            queue.connect(pauser).setBurnPaused(await rusd.getAddress(), false),
            (err) => err.message.includes("NotAdmin"),
        );
    });

    it("admin can pause and unpause", async () => {
        const { queue, rusd } = await deploy();
        await (await queue.setBurnPaused(await rusd.getAddress(), true)).wait();
        await (await queue.setBurnPaused(await rusd.getAddress(), false)).wait();
        assert.equal(await queue.burnPaused(await rusd.getAddress()), false);
    });

    it("rando cannot pause", async () => {
        const { nonAdmin, queue, rusd } = await deploy();
        await assert.rejects(
            queue.connect(nonAdmin).setBurnPaused(await rusd.getAddress(), true),
            (err) => err.message.includes("NotPauserOrAdmin"),
        );
    });
});

// ─── FYP-30 ──────────────────────────────────────────────────────────

describe("FYP-30 — input validation tightening", () => {
    it("openEpoch rejects opening a second epoch while the first is OPEN (settlement)", async () => {
        const [deployer, executor] = await ethers.getSigners();
        const SettingManagement = await ethers.getContractFactory("SettingManagement");
        const setting = await upgrades.deployProxy(SettingManagement, [deployer.address], {
            initializer: "initialize", kind: "transparent",
        });
        const FYUSD = await ethers.getContractFactory("FYUSD");
        const fyusd = await upgrades.deployProxy(FYUSD, [deployer.address], {
            initializer: "initialize", kind: "transparent",
        });
        const Epoch = await ethers.getContractFactory("FyusdEpochSettlement");
        const epoch = await upgrades.deployProxy(
            Epoch,
            [await setting.getAddress(), await fyusd.getAddress(), deployer.address, executor.address],
            { initializer: "initialize", kind: "transparent" },
        );

        await (await epoch.openEpoch(12 * 3600, 10 * 3600)).wait();
        await assert.rejects(
            epoch.openEpoch(12 * 3600, 10 * 3600),
            (err) => err.message.includes("AnotherEpochOpen"),
        );
    });

    it("settleEpoch rejects fyusdMinted == 0 and over-mint", async () => {
        const [deployer, executor, user] = await ethers.getSigners();
        const SettingManagement = await ethers.getContractFactory("SettingManagement");
        const setting = await upgrades.deployProxy(SettingManagement, [deployer.address], {
            initializer: "initialize", kind: "transparent",
        });
        const MockERC20 = await ethers.getContractFactory("MockERC20");
        const usdt = await MockERC20.deploy("USDT", "USDT", 18);
        const FYUSD = await ethers.getContractFactory("FYUSD");
        const fyusd = await upgrades.deployProxy(FYUSD, [deployer.address], {
            initializer: "initialize", kind: "transparent",
        });
        const Epoch = await ethers.getContractFactory("FyusdEpochSettlement");
        const epoch = await upgrades.deployProxy(
            Epoch,
            [await setting.getAddress(), await fyusd.getAddress(), deployer.address, executor.address],
            { initializer: "initialize", kind: "transparent" },
        );
        await (await fyusd.setMinter(await epoch.getAddress())).wait();
        await (await epoch.setSupportedAsset(await usdt.getAddress(), true)).wait();
        await (await usdt.mint(user.address, 1_000n * ONE)).wait();
        await (await usdt.connect(user).approve(await epoch.getAddress(), ethers.MaxUint256)).wait();

        await (await epoch.openEpoch(12 * 3600, 10 * 3600)).wait();
        const epochId = await epoch.nextEpochId();

        // Deposit 100, entitled to 100.
        const quote = {
            user: user.address,
            epochId,
            collateralAsset: await usdt.getAddress(),
            collateralAmount: 100n * ONE,
            fyusdAmount: 100n * ONE,
            nonce: 1n,
            expiry: (await latestTimestamp()) + 3600n,
        };
        const { chainId } = await ethers.provider.getNetwork();
        const domain = {
            name: "FyusdEpochSettlement", version: "1", chainId,
            verifyingContract: await epoch.getAddress(),
        };
        const types = {
            DepositQuote: [
                { name: "user", type: "address" },
                { name: "epochId", type: "uint256" },
                { name: "collateralAsset", type: "address" },
                { name: "collateralAmount", type: "uint256" },
                { name: "fyusdAmount", type: "uint256" },
                { name: "nonce", type: "uint256" },
                { name: "expiry", type: "uint256" },
            ],
        };
        const sig = await deployer.signTypedData(domain, types, quote);
        await (await epoch.deposit(quote, sig)).wait();

        await increaseTime(10 * 3600 + 1);
        await (await epoch.lockEpoch(epochId)).wait();

        // fyusdMinted = 0 → ZeroAmount
        await assert.rejects(
            epoch.connect(executor).settleEpoch(epochId, 0n),
            (err) => err.message.includes("ZeroAmount"),
        );
        // fyusdMinted > totalEntitled → ExcessSettlement
        await assert.rejects(
            epoch.connect(executor).settleEpoch(epochId, 200n * ONE),
            (err) => err.message.includes("ExcessSettlement"),
        );
        // Exactly entitled — passes.
        await (await epoch.connect(executor).settleEpoch(epochId, 100n * ONE)).wait();
    });

    it("FypherStakingHub.addPool rejects underlying equal to the FYP reward token", async () => {
        const [deployer] = await ethers.getSigners();
        const SettingManagement = await ethers.getContractFactory("SettingManagement");
        const setting = await upgrades.deployProxy(SettingManagement, [deployer.address], {
            initializer: "initialize", kind: "transparent",
        });
        const MockERC20 = await ethers.getContractFactory("MockERC20");
        const fpy = await MockERC20.deploy("Mock FYP", "mFYP", 18);
        const Hub = await ethers.getContractFactory("FypherStakingHub");
        const hub = await upgrades.deployProxy(
            Hub,
            [await setting.getAddress(), await fpy.getAddress(), ONE],
            { initializer: "initialize", kind: "transparent" },
        );

        await assert.rejects(
            hub.addPool(await fpy.getAddress(), 10_000),
            (err) => err.message.includes("UnderlyingIsRewardToken"),
        );
    });

    it("StakedRUSD.earlyUnstake reverts with ExistingCooldownReady when cooldown already elapsed", async () => {
        const [deployer, alice] = await ethers.getSigners();
        const SettingManagement = await ethers.getContractFactory("SettingManagement");
        const setting = await upgrades.deployProxy(SettingManagement, [deployer.address], {
            initializer: "initialize", kind: "transparent",
        });
        await (await setting.setPoolConfigs("cooldownDuration", 7 * 24 * 3600)).wait();
        await (await setting.setFeeReceiver(deployer.address)).wait();
        const MockERC20 = await ethers.getContractFactory("MockERC20");
        const rusd = await MockERC20.deploy("RUSD", "RUSD", 18);
        const StakedRUSD = await ethers.getContractFactory("StakedRUSD");
        const sRUSD = await upgrades.deployProxy(
            StakedRUSD,
            [await rusd.getAddress(), await setting.getAddress(), deployer.address],
            { initializer: "initialize", kind: "transparent" },
        );

        await (await rusd.mint(alice.address, 100n * ONE)).wait();
        await (await rusd.connect(alice).approve(await sRUSD.getAddress(), ethers.MaxUint256)).wait();
        await (await sRUSD.connect(alice).deposit(100n * ONE, alice.address)).wait();
        await (await sRUSD.connect(alice).cooldownAssets(100n * ONE)).wait();

        // Past cooldownEnd → earlyUnstake should reject.
        await increaseTime(7 * 24 * 3600 + 1);
        await assert.rejects(
            sRUSD.connect(alice).earlyUnstake(alice.address),
            (err) => err.message.includes("ExistingCooldownReady"),
        );
        // unstake() still works.
        await (await sRUSD.connect(alice).unstake(alice.address)).wait();
    });

    it("FypherMinting.verifyOrder returns false after expiry", async () => {
        const [deployer, signer, executor, user] = await ethers.getSigners();
        const SettingManagement = await ethers.getContractFactory("SettingManagement");
        const setting = await upgrades.deployProxy(SettingManagement, [deployer.address], {
            initializer: "initialize", kind: "transparent",
        });
        const MockERC20 = await ethers.getContractFactory("MockERC20");
        const rusd = await MockERC20.deploy("RUSD", "RUSD", 18);
        const Minting = await ethers.getContractFactory("FypherMinting");
        const minting = await upgrades.deployProxy(
            Minting,
            [await setting.getAddress(), await rusd.getAddress(), signer.address, executor.address],
            { initializer: "initialize", kind: "transparent" },
        );

        const order = {
            benefactor: user.address,
            beneficiary: user.address,
            collateral_asset: await rusd.getAddress(),
            collateral_amount: 1n * ONE,
            rusd_amount: 1n * ONE,
            nonce: 1n,
            expiry: (await latestTimestamp()) - 1n,  // already expired
        };
        const { chainId } = await ethers.provider.getNetwork();
        const domain = {
            name: "FypherMinting", version: "1", chainId,
            verifyingContract: await minting.getAddress(),
        };
        const types = {
            Order: [
                { name: "orderType", type: "uint8" },
                { name: "benefactor", type: "address" },
                { name: "beneficiary", type: "address" },
                { name: "collateral_asset", type: "address" },
                { name: "collateral_amount", type: "uint256" },
                { name: "rusd_amount", type: "uint256" },
                { name: "nonce", type: "uint256" },
                { name: "expiry", type: "uint256" },
            ],
        };
        const sig = await signer.signTypedData(domain, types, { orderType: 0, ...order });

        // Signature itself recovers correctly, but expiry has passed → false.
        // Two `verifyOrder` overloads exist (the deprecated 2-arg stub and
        // the active 3-arg form); spell the signature out for ethers v6.
        const verifyOrder3 = minting["verifyOrder((address,address,address,uint256,uint256,uint256,uint256),bytes,uint8)"];
        assert.equal(await verifyOrder3(order, sig, 0 /* MINT */), false);
    });
});

// ─── FYP-27 ──────────────────────────────────────────────────────────

describe("FYP-27 — ReservePool.withdrawETH", () => {
    it("admin can withdraw ETH; non-admin and zero recipient rejected", async () => {
        const [deployer, alice, nonAdmin] = await ethers.getSigners();
        const SettingManagement = await ethers.getContractFactory("SettingManagement");
        const setting = await upgrades.deployProxy(SettingManagement, [deployer.address], {
            initializer: "initialize", kind: "transparent",
        });
        const ReservePool = await ethers.getContractFactory("ReservePool");
        const pool = await ReservePool.deploy(await setting.getAddress());

        // Fund the pool with 1 ETH.
        await (await deployer.sendTransaction({ to: await pool.getAddress(), value: ONE })).wait();

        await assert.rejects(
            pool.connect(nonAdmin).withdrawETH(alice.address, ONE),
            (err) => err.message.includes("NotAdmin"),
        );
        await assert.rejects(
            pool.withdrawETH(ethers.ZeroAddress, ONE),
            (err) => err.message.includes("ZeroAddress"),
        );

        const aliceBefore = await ethers.provider.getBalance(alice.address);
        await (await pool.withdrawETH(alice.address, ONE)).wait();
        const aliceAfter = await ethers.provider.getBalance(alice.address);
        assert.equal(aliceAfter - aliceBefore, ONE);
    });
});

// ─── FYP-28 ──────────────────────────────────────────────────────────

describe("FYP-28 — SettingManagement.setFees fee cap", () => {
    it("rejects fees above MAX_FEE_BPS (1000 = 10%)", async () => {
        const [deployer] = await ethers.getSigners();
        const SettingManagement = await ethers.getContractFactory("SettingManagement");
        const setting = await upgrades.deployProxy(SettingManagement, [deployer.address], {
            initializer: "initialize", kind: "transparent",
        });

        await (await setting.setFees("earlyUnstakeFee", 500)).wait();  // 5%
        await (await setting.setFees("earlyUnstakeFee", 1_000)).wait(); // exactly cap
        await assert.rejects(
            setting.setFees("earlyUnstakeFee", 1_001),
            (err) => err.message.includes("FeeAboveCap"),
        );
    });
});

// ─── FYP-31 ──────────────────────────────────────────────────────────

describe("FYP-31 — FypherBurnQueue.sweepSurplus", () => {
    it("admin can sweep surplus above outstandingLiability; reverts when it would dip below", async () => {
        const [deployer, donor, treasury] = await ethers.getSigners();
        const SettingManagement = await ethers.getContractFactory("SettingManagement");
        const setting = await upgrades.deployProxy(SettingManagement, [deployer.address], {
            initializer: "initialize", kind: "transparent",
        });
        const MockERC20 = await ethers.getContractFactory("MockERC20");
        const usdt = await MockERC20.deploy("USDT", "USDT", 18);
        const BurnQueue = await ethers.getContractFactory("FypherBurnQueue");
        const queue = await upgrades.deployProxy(
            BurnQueue,
            [await setting.getAddress(), await usdt.getAddress(), deployer.address],
            { initializer: "initialize", kind: "transparent" },
        );

        // Stuff 500 USDT directly into the queue (no liability against it).
        await (await usdt.mint(donor.address, 500n * ONE)).wait();
        await (await usdt.connect(donor).transfer(await queue.getAddress(), 500n * ONE)).wait();

        await (await queue.sweepSurplus(
            await usdt.getAddress(),
            treasury.address,
            300n * ONE,
        )).wait();
        assert.equal(await usdt.balanceOf(treasury.address), 300n * ONE);

        // 200 remains; trying to sweep 250 reverts.
        await assert.rejects(
            queue.sweepSurplus(await usdt.getAddress(), treasury.address, 250n * ONE),
            (err) => err.message.includes("WouldUnderfundLiability"),
        );
    });
});

// ─── FYP-33 ──────────────────────────────────────────────────────────

describe("FYP-33 — earlyUnstake refuses vault as fee receiver", () => {
    it("reverts when feeReceiver is configured to the vault itself", async () => {
        const [deployer, alice] = await ethers.getSigners();
        const SettingManagement = await ethers.getContractFactory("SettingManagement");
        const setting = await upgrades.deployProxy(SettingManagement, [deployer.address], {
            initializer: "initialize", kind: "transparent",
        });
        await (await setting.setPoolConfigs("cooldownDuration", 7 * 24 * 3600)).wait();
        await (await setting.setFees("earlyUnstakeFee", 500)).wait(); // 5%
        const MockERC20 = await ethers.getContractFactory("MockERC20");
        const rusd = await MockERC20.deploy("RUSD", "RUSD", 18);
        const StakedRUSD = await ethers.getContractFactory("StakedRUSD");
        const sRUSD = await upgrades.deployProxy(
            StakedRUSD,
            [await rusd.getAddress(), await setting.getAddress(), deployer.address],
            { initializer: "initialize", kind: "transparent" },
        );

        // Maliciously / accidentally point feeReceiver at the vault itself.
        await (await setting.setFeeReceiver(await sRUSD.getAddress())).wait();

        await (await rusd.mint(alice.address, 100n * ONE)).wait();
        await (await rusd.connect(alice).approve(await sRUSD.getAddress(), ethers.MaxUint256)).wait();
        await (await sRUSD.connect(alice).deposit(100n * ONE, alice.address)).wait();
        await (await sRUSD.connect(alice).cooldownAssets(100n * ONE)).wait();

        await assert.rejects(
            sRUSD.connect(alice).earlyUnstake(alice.address),
            (err) => err.message.includes("Vault cannot be its own fee receiver"),
        );
    });
});

// ─── FYP-43 ──────────────────────────────────────────────────────────

describe("FYP-43 — _accrueCooldown refuses fresh cooldown on top of a ready cooldown", () => {
    it("reverts ExistingCooldownReady when the user already has a claimable balance", async () => {
        const [deployer, alice] = await ethers.getSigners();
        const SettingManagement = await ethers.getContractFactory("SettingManagement");
        const setting = await upgrades.deployProxy(SettingManagement, [deployer.address], {
            initializer: "initialize", kind: "transparent",
        });
        await (await setting.setPoolConfigs("cooldownDuration", 7 * 24 * 3600)).wait();
        const MockERC20 = await ethers.getContractFactory("MockERC20");
        const rusd = await MockERC20.deploy("RUSD", "RUSD", 18);
        const StakedRUSD = await ethers.getContractFactory("StakedRUSD");
        const sRUSD = await upgrades.deployProxy(
            StakedRUSD,
            [await rusd.getAddress(), await setting.getAddress(), deployer.address],
            { initializer: "initialize", kind: "transparent" },
        );

        await (await rusd.mint(alice.address, 200n * ONE)).wait();
        await (await rusd.connect(alice).approve(await sRUSD.getAddress(), ethers.MaxUint256)).wait();

        await (await sRUSD.connect(alice).deposit(200n * ONE, alice.address)).wait();
        await (await sRUSD.connect(alice).cooldownAssets(100n * ONE)).wait();
        await increaseTime(7 * 24 * 3600 + 1);

        // Old cooldown is now claimable. Starting a new one would silently
        // re-lock the ready 100 RUSD.
        await assert.rejects(
            sRUSD.connect(alice).cooldownAssets(50n * ONE),
            (err) => err.message.includes("ExistingCooldownReady"),
        );
        // Unstaking first clears the bucket; then a new cooldown is allowed.
        await (await sRUSD.connect(alice).unstake(alice.address)).wait();
        await (await sRUSD.connect(alice).cooldownAssets(50n * ONE)).wait();
    });
});

// ─── FYP-44 + FYP-48 ─────────────────────────────────────────────────

describe("FYP-44 + FYP-48 — FypherMinting executeRedeem burnPaused + route rounding", () => {
    async function deploy() {
        const [deployer, signer, executor, user, custodianA, custodianB] = await ethers.getSigners();
        const SettingManagement = await ethers.getContractFactory("SettingManagement");
        const setting = await upgrades.deployProxy(SettingManagement, [deployer.address], {
            initializer: "initialize", kind: "transparent",
        });
        const RUSD = await ethers.getContractFactory("RUSD");
        const rusd = await upgrades.deployProxy(RUSD, [deployer.address], {
            initializer: "initialize", kind: "transparent",
        });
        const MockERC20 = await ethers.getContractFactory("MockERC20");
        const usdt = await MockERC20.deploy("USDT", "USDT", 18);

        const Minting = await ethers.getContractFactory("FypherMinting");
        const minting = await upgrades.deployProxy(
            Minting,
            [await setting.getAddress(), await rusd.getAddress(), signer.address, executor.address],
            { initializer: "initialize", kind: "transparent" },
        );
        await (await rusd.setMinter(await minting.getAddress())).wait();

        await (await minting.addSupportedAsset(await usdt.getAddress())).wait();
        await (await minting.addCustodianAddress(custodianA.address)).wait();
        await (await minting.addCustodianAddress(custodianB.address)).wait();

        await (await usdt.mint(user.address, 1_000_000n * ONE)).wait();
        await (await usdt.connect(user).approve(await minting.getAddress(), ethers.MaxUint256)).wait();

        return { deployer, signer, executor, user, custodianA, custodianB, setting, rusd, usdt, minting };
    }

    async function signOrder(signer, mintingAddr, order, orderType) {
        const { chainId } = await ethers.provider.getNetwork();
        const domain = {
            name: "FypherMinting", version: "1", chainId,
            verifyingContract: mintingAddr,
        };
        const types = {
            Order: [
                { name: "orderType", type: "uint8" },
                { name: "benefactor", type: "address" },
                { name: "beneficiary", type: "address" },
                { name: "collateral_asset", type: "address" },
                { name: "collateral_amount", type: "uint256" },
                { name: "rusd_amount", type: "uint256" },
                { name: "nonce", type: "uint256" },
                { name: "expiry", type: "uint256" },
            ],
        };
        return signer.signTypedData(domain, types, { orderType, ...order });
    }

    it("FYP-48 route rounding remainder lands on the last leg (exact total)", async () => {
        const ctx = await deploy();
        const { signer, user, custodianA, custodianB, usdt, minting } = ctx;

        // Use an amount that won't divide cleanly across 3333/3333/3334.
        const total = 100n * ONE + 1n;  // 100.000000000000000001 (odd-numbered last digit)
        const order = {
            benefactor: user.address,
            beneficiary: user.address,
            collateral_asset: await usdt.getAddress(),
            collateral_amount: total,
            rusd_amount: total,
            nonce: 1n,
            expiry: (await latestTimestamp()) + 3600n,
        };
        const sig = await signOrder(signer, await minting.getAddress(), order, 0);

        const route = {
            addresses: [custodianA.address, custodianB.address],
            ratios: [3333, 6667],
        };

        const balABefore = await usdt.balanceOf(custodianA.address);
        const balBBefore = await usdt.balanceOf(custodianB.address);
        await (await minting.mint(order, route, sig)).wait();
        const balAAfter = await usdt.balanceOf(custodianA.address);
        const balBAfter = await usdt.balanceOf(custodianB.address);

        // Sum of legs MUST equal collateral_amount exactly. Pre-patch the
        // sum was 1 wei short.
        const sumDistributed = (balAAfter - balABefore) + (balBAfter - balBBefore);
        assert.equal(sumDistributed, total);
    });

    it("FYP-44 executeRedeem reverts BurnPausedForAsset when asset is paused", async () => {
        const ctx = await deploy();
        const { signer, executor, user, usdt, rusd, minting } = ctx;

        // Mint some RUSD to user via the mint path so they can requestRedeem.
        const mintOrder = {
            benefactor: user.address,
            beneficiary: user.address,
            collateral_asset: await usdt.getAddress(),
            collateral_amount: 50n * ONE,
            rusd_amount: 50n * ONE,
            nonce: 10n,
            expiry: (await latestTimestamp()) + 3600n,
        };
        await (await minting.addCustodianAddress(ctx.deployer.address)).wait();
        const route = { addresses: [ctx.deployer.address], ratios: [10_000] };
        const mintSig = await signOrder(signer, await minting.getAddress(), mintOrder, 0);
        await (await minting.mint(mintOrder, route, mintSig)).wait();

        // requestRedeem 30 RUSD.
        await (await rusd.connect(user).approve(await minting.getAddress(), ethers.MaxUint256)).wait();
        await (await minting.connect(user).requestRedeem(30n * ONE, 99n)).wait();

        const redeemOrder = {
            benefactor: user.address,
            beneficiary: user.address,
            collateral_asset: await usdt.getAddress(),
            collateral_amount: 30n * ONE,
            rusd_amount: 30n * ONE,
            nonce: 99n,
            expiry: (await latestTimestamp()) + 3600n,
        };
        const redeemSig = await signOrder(signer, await minting.getAddress(), redeemOrder, 1);

        // Pause burns on the asset.
        await (await minting.setBurnPaused(await usdt.getAddress(), true)).wait();
        await assert.rejects(
            minting.connect(executor).executeRedeem(redeemOrder, redeemSig),
            (err) => err.message.includes("BurnPausedForAsset"),
        );
    });
});
