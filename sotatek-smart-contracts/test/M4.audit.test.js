/**
 * M4 audit-cleanup verification.
 *
 *   FYP-12 — RUSDSilo SafeERC20 (covered indirectly by every cooldown
 *             unstake path; no separate test added)
 *   FYP-34 — ERC4626 max and preview functions on yield vaults
 *   FYP-37 — cooldown default fallback in staked vaults
 *   FYP-46 — mintBound: route-bound EIP-712 signature
 *   FYP-50 — max length caps + paginated ticket view
 *   FYP-52 — pendingAdmin / cancelAdminTransfer / admin() getter
 *   FYP-55 — adapter allowance reset to 0 after deposit
 *   FYP-56 — updateTrigger rejects when trigger is tripped
 *   FYP-60 — emit-on-config-change events
 */
const assert = require("node:assert/strict");
const { ethers, upgrades, network } = require("hardhat");

const ONE = 10n ** 18n;

async function latestTimestamp() {
    const blk = await ethers.provider.getBlock("latest");
    return BigInt(blk.timestamp);
}

// ─── FYP-34 ──────────────────────────────────────────────────────────

describe("FYP-34 — yield-vault max*/preview* return 0", () => {
    it("FyusdYieldVault & RUSDYieldVault advertise no synchronous exit", async () => {
        const [deployer] = await ethers.getSigners();
        const SettingManagement = await ethers.getContractFactory("SettingManagement");
        const setting = await upgrades.deployProxy(SettingManagement, [deployer.address], {
            initializer: "initialize", kind: "transparent",
        });
        const MockERC20 = await ethers.getContractFactory("MockERC20");
        const fyusd = await MockERC20.deploy("FYUSD", "FYUSD", 18);
        const MockAdapter = await ethers.getContractFactory("MockConcreteAdapter");
        const adapter = await MockAdapter.deploy(await fyusd.getAddress(), 0, ethers.ZeroAddress);
        const Vault = await ethers.getContractFactory("FyusdYieldVault");
        const vault = await upgrades.deployProxy(
            Vault,
            [
                await setting.getAddress(),
                await fyusd.getAddress(),
                await adapter.getAddress(),
                deployer.address,
            ],
            { initializer: "initialize", kind: "transparent" },
        );
        assert.equal(await vault.maxWithdraw(deployer.address), 0n);
        assert.equal(await vault.maxRedeem(deployer.address), 0n);
        assert.equal(await vault.previewWithdraw(123n * ONE), 0n);
        assert.equal(await vault.previewRedeem(456n * ONE), 0n);
    });
});

// ─── FYP-37 ──────────────────────────────────────────────────────────

describe("FYP-37 — staked-vault cooldown default fallback", () => {
    it("cooldownAssets uses DEFAULT_COOLDOWN when SettingManagement returns 0", async () => {
        const [deployer, alice] = await ethers.getSigners();
        const SettingManagement = await ethers.getContractFactory("SettingManagement");
        const setting = await upgrades.deployProxy(SettingManagement, [deployer.address], {
            initializer: "initialize", kind: "transparent",
        });
        // Intentionally DO NOT set cooldownDuration → getPoolConfigs returns 0.
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

        const tBefore = await latestTimestamp();
        await (await sRUSD.connect(alice).cooldownAssets(100n * ONE)).wait();
        const cd = await sRUSD.cooldowns(alice.address);
        // DEFAULT_COOLDOWN is 7 days = 604800 seconds — cooldownEnd
        // should be at least that far in the future relative to the
        // pre-call timestamp.
        const expectedMinEnd = tBefore + 7n * 24n * 60n * 60n;
        assert.ok(cd.cooldownEnd >= expectedMinEnd,
            "cooldownEnd should fall back to DEFAULT_COOLDOWN");
    });
});

// ─── FYP-46 ──────────────────────────────────────────────────────────

describe("FYP-46 — mintBound: route is bound to the signature", () => {
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
        await (await usdt.mint(user.address, 1_000n * ONE)).wait();
        await (await usdt.connect(user).approve(await minting.getAddress(), ethers.MaxUint256)).wait();
        return { deployer, signer, executor, user, custodianA, custodianB, rusd, usdt, minting };
    }

    async function signBoundOrder(signer, mintingAddr, order, routeHash, orderType) {
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
                { name: "route_hash", type: "bytes32" },
            ],
        };
        return signer.signTypedData(domain, types, { orderType, ...order, route_hash: routeHash });
    }

    it("mintBound accepts a route whose hash matches the signed routeHash", async () => {
        const ctx = await deploy();
        const { signer, user, custodianA, custodianB, usdt, rusd, minting } = ctx;

        const order = {
            benefactor: user.address,
            beneficiary: user.address,
            collateral_asset: await usdt.getAddress(),
            collateral_amount: 100n * ONE,
            rusd_amount: 100n * ONE,
            nonce: 1n,
            expiry: (await latestTimestamp()) + 3600n,
        };
        const route = {
            addresses: [custodianA.address, custodianB.address],
            ratios: [3000, 7000],
        };
        const routeHash = await minting.routeHash(route);
        const sig = await signBoundOrder(signer, await minting.getAddress(), order, routeHash, 0);

        await (await minting.mintBound(order, route, sig)).wait();
        assert.equal(await rusd.balanceOf(user.address), 100n * ONE);
    });

    it("mintBound rejects a route that does not match the signed routeHash", async () => {
        const ctx = await deploy();
        const { signer, user, custodianA, custodianB, usdt, minting } = ctx;

        const order = {
            benefactor: user.address,
            beneficiary: user.address,
            collateral_asset: await usdt.getAddress(),
            collateral_amount: 100n * ONE,
            rusd_amount: 100n * ONE,
            nonce: 2n,
            expiry: (await latestTimestamp()) + 3600n,
        };
        const intendedRoute = {
            addresses: [custodianA.address, custodianB.address],
            ratios: [3000, 7000],
        };
        const intendedHash = await minting.routeHash(intendedRoute);
        const sig = await signBoundOrder(signer, await minting.getAddress(), order, intendedHash, 0);

        // Caller swaps ratios to a different valid split. The route is
        // still on-chain valid (whitelisted custodians, ratios sum to
        // 10_000) but its hash doesn't match what was signed.
        const tamperedRoute = {
            addresses: [custodianA.address, custodianB.address],
            ratios: [5000, 5000],
        };
        await assert.rejects(
            minting.mintBound(order, tamperedRoute, sig),
            (err) => err.message.includes("InvalidSignature"),
        );
    });

    it("legacy mint still works alongside mintBound", async () => {
        const ctx = await deploy();
        const { signer, user, custodianA, usdt, rusd, minting } = ctx;

        // Legacy v1 typehash (no route_hash field).
        const { chainId } = await ethers.provider.getNetwork();
        const domain = {
            name: "FypherMinting", version: "1", chainId,
            verifyingContract: await minting.getAddress(),
        };
        const v1Types = {
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
        const order = {
            benefactor: user.address,
            beneficiary: user.address,
            collateral_asset: await usdt.getAddress(),
            collateral_amount: 50n * ONE,
            rusd_amount: 50n * ONE,
            nonce: 3n,
            expiry: (await latestTimestamp()) + 3600n,
        };
        const sig = await signer.signTypedData(domain, v1Types, { orderType: 0, ...order });
        const route = { addresses: [custodianA.address], ratios: [10_000] };
        await (await minting.mint(order, route, sig)).wait();
        assert.equal(await rusd.balanceOf(user.address), 50n * ONE);
    });
});

// ─── FYP-50 ──────────────────────────────────────────────────────────

describe("FYP-50 — array caps + paginated ticket view", () => {
    it("FypherMinting._distributeCollateral rejects route longer than MAX_ROUTE_LEGS", async () => {
        const [deployer, signer, executor, user, ...custodians] = await ethers.getSigners();
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
        // 9 custodians — one more than MAX_ROUTE_LEGS (8).
        const useCust = custodians.slice(0, 9);
        for (const c of useCust) {
            await (await minting.addCustodianAddress(c.address)).wait();
        }
        await (await usdt.mint(user.address, 100n * ONE)).wait();
        await (await usdt.connect(user).approve(await minting.getAddress(), ethers.MaxUint256)).wait();

        const order = {
            benefactor: user.address,
            beneficiary: user.address,
            collateral_asset: await usdt.getAddress(),
            collateral_amount: 90n * ONE,
            rusd_amount: 90n * ONE,
            nonce: 1n,
            expiry: (await latestTimestamp()) + 3600n,
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
        const route = {
            addresses: useCust.map((c) => c.address),
            ratios: [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 2000],
        };
        await assert.rejects(
            minting.mint(order, route, sig),
            (err) => err.message.includes("RouteTooLong"),
        );
    });

    it("FypherBurnQueue paginated ticketsOfPage clips at array end", async () => {
        const [deployer] = await ethers.getSigners();
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
        // No tickets booked → page returns empty regardless of offset.
        const empty = await queue.ticketsOfPage(deployer.address, 0, 10);
        assert.equal(empty.length, 0);
        const past = await queue.ticketsOfPage(deployer.address, 50, 10);
        assert.equal(past.length, 0);
    });
});

// ─── FYP-52 ──────────────────────────────────────────────────────────

describe("FYP-52 — admin handoff transparency", () => {
    it("pendingAdmin getter + cancelAdminTransfer + admin() helper", async () => {
        const [deployer, alice] = await ethers.getSigners();
        const SettingManagement = await ethers.getContractFactory("SettingManagement");
        const setting = await upgrades.deployProxy(SettingManagement, [deployer.address], {
            initializer: "initialize", kind: "transparent",
        });

        // admin() returns the current admin.
        assert.equal(await setting.admin(), deployer.address);
        assert.equal(await setting.owner(), deployer.address);  // alias

        // No transfer in flight.
        assert.equal(await setting.pendingAdmin(), ethers.ZeroAddress);
        await assert.rejects(
            setting.cancelAdminTransfer(),
            (err) => err.message.includes("NotPendingAdmin"),
        );

        // Stage transfer.
        await (await setting.transferAdmin(alice.address)).wait();
        assert.equal(await setting.pendingAdmin(), alice.address);

        // Cancel.
        await (await setting.cancelAdminTransfer()).wait();
        assert.equal(await setting.pendingAdmin(), ethers.ZeroAddress);
        assert.equal(await setting.admin(), deployer.address);
    });
});

// ─── FYP-55 ──────────────────────────────────────────────────────────

describe("FYP-55 — adapter allowance reset to 0 after deposit", () => {
    it("vault → adapter allowance is 0 after FyusdYieldVault.deposit returns", async () => {
        const [deployer, alice] = await ethers.getSigners();
        const SettingManagement = await ethers.getContractFactory("SettingManagement");
        const setting = await upgrades.deployProxy(SettingManagement, [deployer.address], {
            initializer: "initialize", kind: "transparent",
        });
        const MockERC20 = await ethers.getContractFactory("MockERC20");
        const fyusd = await MockERC20.deploy("FYUSD", "FYUSD", 18);
        const MockAdapter = await ethers.getContractFactory("MockConcreteAdapter");
        const adapter = await MockAdapter.deploy(await fyusd.getAddress(), 0, ethers.ZeroAddress);
        const Vault = await ethers.getContractFactory("FyusdYieldVault");
        const vault = await upgrades.deployProxy(
            Vault,
            [
                await setting.getAddress(),
                await fyusd.getAddress(),
                await adapter.getAddress(),
                deployer.address,
            ],
            { initializer: "initialize", kind: "transparent" },
        );

        await (await fyusd.mint(alice.address, 100n * ONE)).wait();
        await (await fyusd.connect(alice).approve(await vault.getAddress(), ethers.MaxUint256)).wait();
        await (await vault.connect(alice).deposit(100n * ONE, alice.address)).wait();

        assert.equal(
            await fyusd.allowance(await vault.getAddress(), await adapter.getAddress()),
            0n,
            "vault → adapter allowance must be cleared after deposit",
        );
    });
});

// ─── FYP-56 ──────────────────────────────────────────────────────────

describe("FYP-56 — updateTrigger rejects tripped triggers", () => {
    it("admin cannot update a trigger that is currently tripped", async () => {
        const [deployer, alice, target] = await ethers.getSigners();
        const SettingManagement = await ethers.getContractFactory("SettingManagement");
        const setting = await upgrades.deployProxy(SettingManagement, [deployer.address], {
            initializer: "initialize", kind: "transparent",
        });
        const Breaker = await ethers.getContractFactory("FypherCircuitBreaker");
        const breaker = await upgrades.deployProxy(
            Breaker,
            [await setting.getAddress(), deployer.address],
            { initializer: "initialize", kind: "transparent" },
        );

        // Register a trigger whose target is a benign address (the call
        // will fail at trip time, but registration succeeds).
        const dummyCall = { target: target.address, data: "0x" };
        await (await breaker.registerTrigger("t", "desc", [dummyCall], [])).wait();

        // Trip path requires the target to NOT revert; use a trigger
        // that points at the setting-management contract (any selector
        // — we just need .call to succeed). Register a no-op-ish trigger:
        const helloCall = {
            target: await setting.getAddress(),
            // owner() — a pure read; .call returns successfully.
            data: "0x8da5cb5b",
        };
        await (await breaker.updateTrigger(0, "t2", "desc2", [helloCall], [])).wait();

        await (await breaker.trip(0, ethers.ZeroHash)).wait();

        // Now updateTrigger must reject.
        await assert.rejects(
            breaker.updateTrigger(0, "t3", "desc3", [helloCall], []),
            (err) => err.message.includes("AlreadyTripped"),
        );

        // After reset, updateTrigger works again.
        await (await breaker.reset(0, ethers.ZeroHash)).wait();
        await (await breaker.updateTrigger(0, "t4", "desc4", [helloCall], [])).wait();
    });
});

// ─── FYP-60 ──────────────────────────────────────────────────────────

describe("FYP-60 — emit-on-change events for rate-limit setters", () => {
    it("setMaxMintPerBlock and setStablesDeltaLimit emit on real change", async () => {
        const [deployer, signer, executor] = await ethers.getSigners();
        const SettingManagement = await ethers.getContractFactory("SettingManagement");
        const setting = await upgrades.deployProxy(SettingManagement, [deployer.address], {
            initializer: "initialize", kind: "transparent",
        });
        const MockERC20 = await ethers.getContractFactory("MockERC20");
        const rusd = await MockERC20.deploy("RUSD", "RUSD", 18);
        const usdt = await MockERC20.deploy("USDT", "USDT", 18);
        const Minting = await ethers.getContractFactory("FypherMinting");
        const minting = await upgrades.deployProxy(
            Minting,
            [await setting.getAddress(), await rusd.getAddress(), signer.address, executor.address],
            { initializer: "initialize", kind: "transparent" },
        );

        await assert.doesNotReject(async () => {
            const tx = await minting.setMaxMintPerBlock(await usdt.getAddress(), 100n);
            const rcpt = await tx.wait();
            const has = rcpt.logs.some((l) => {
                try {
                    const parsed = minting.interface.parseLog(l);
                    return parsed && parsed.name === "MaxMintPerAssetUpdated";
                } catch { return false; }
            });
            assert.ok(has, "MaxMintPerAssetUpdated should fire on first set");
        });

        await assert.doesNotReject(async () => {
            const tx = await minting.setStablesDeltaLimit(1_000_000n);
            const rcpt = await tx.wait();
            const has = rcpt.logs.some((l) => {
                try {
                    const parsed = minting.interface.parseLog(l);
                    return parsed && parsed.name === "StablesDeltaLimitUpdated";
                } catch { return false; }
            });
            assert.ok(has, "StablesDeltaLimitUpdated should fire on first set");
        });
    });
});
