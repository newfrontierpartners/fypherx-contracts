/**
 * M3 audit-cleanup verification.
 *
 *   FYP-41 — adapter asset-based withdraw (vault/adapter share-divergence
 *             drain attack)
 *   FYP-13 + FYP-47 — claimer-counter state machine + last-claim
 *             rounding residue absorption (epoch contracts)
 *   FYP-58 — FypherStakingHub pull-claim model (principal moves no
 *             longer revert on an under-funded reward pot)
 *   FYP-59 — permissionless {forceCancel} timeout (epoch contracts)
 */
const assert = require("node:assert/strict");
const { ethers, upgrades, network } = require("hardhat");

const ONE = 10n ** 18n;

async function increaseTime(seconds) {
    await network.provider.send("evm_increaseTime", [Number(seconds)]);
    await network.provider.send("evm_mine", []);
}

async function mineBlocks(n) {
    for (let i = 0; i < n; ++i) await network.provider.send("evm_mine", []);
}

async function latestTimestamp() {
    const blk = await ethers.provider.getBlock("latest");
    return BigInt(blk.timestamp);
}

// ─── FYP-41 — adapter asset-based withdraw ───────────────────────────

describe("FYP-41 — adapter / vault share divergence drain", () => {
    async function deploy() {
        const [deployer, alice, bob] = await ethers.getSigners();
        const SettingManagement = await ethers.getContractFactory("SettingManagement");
        const setting = await upgrades.deployProxy(SettingManagement, [deployer.address], {
            initializer: "initialize", kind: "transparent",
        });
        await (await setting.setPoolConfigs("vFyusdCooldown", 7 * 24 * 3600)).wait();

        const MockERC20 = await ethers.getContractFactory("MockERC20");
        const fyusd = await MockERC20.deploy("Mock FYUSD", "mFYUSD", 18);

        // Use the MockConcreteAdapter — it now mirrors the asset-based
        // withdraw shape. Vault binding deferred until we know the vault
        // address (chicken-and-egg with the proxy); set _vault = 0 to
        // use the "any caller" mode, then the proxy-bound vault calls
        // into it from inside its modifier-gated entry points.
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

        for (const u of [alice, bob]) {
            await (await fyusd.mint(u.address, 1_000n * ONE)).wait();
            await (await fyusd.connect(u).approve(await vault.getAddress(), ethers.MaxUint256)).wait();
        }

        return { deployer, alice, bob, fyusd, adapter, vault };
    }

    it("multi-user exit after yield does not drain the vault", async () => {
        const { alice, bob, fyusd, adapter, vault } = await deploy();

        // Alice deposits 100 FYUSD.
        await (await vault.connect(alice).deposit(100n * ONE, alice.address)).wait();

        // Simulate yield by donating FYUSD to the adapter (mock-only:
        // production goes through Concrete's NAV). The mock's yield
        // accrual integrates via {fundYield} which transferFrom's from
        // the caller, so alice must approve and invoke directly.
        await (await fyusd.mint(alice.address, 50n * ONE)).wait();
        await (await fyusd.connect(alice).approve(await adapter.getAddress(), 50n * ONE)).wait();
        await (await adapter.connect(alice).fundYield(50n * ONE)).wait();

        // Force the mock's internal accrual to recognise the yield
        // donation by depositing a tiny amount (any vault touch on
        // the adapter triggers _accrue). The fundYield call only
        // moved FYUSD into the contract; principal/accruedYield
        // stay flat until _accrue runs.
        await (await vault.connect(bob).deposit(1n, bob.address)).wait();

        // Bob now deposits 100. The vault's share calc and the
        // adapter's internal share calc round differently, which
        // pre-patch let Bob's full cooldownShares call drain ALL
        // of the vault's adapter shares and leave Alice with no
        // backing.
        await (await vault.connect(bob).deposit(100n * ONE, bob.address)).wait();

        // Bob cools all his shares.
        const bobShares = await vault.balanceOf(bob.address);
        await (await vault.connect(bob).cooldownShares(bobShares)).wait();
        await increaseTime(7 * 24 * 3600 + 1);
        await (await vault.connect(bob).unstake(bob.address)).wait();

        // After Bob exits, Alice's shares MUST still redeem some
        // positive amount of FYUSD — the vault has not been drained.
        const aliceShares = await vault.balanceOf(alice.address);
        assert.ok(aliceShares > 0n);
        const totalAssets = await vault.totalAssets();
        assert.ok(totalAssets > 0n,
            "vault still has backing for Alice after Bob's exit");
    });

    it("ConcreteAdapterV1 partial withdraw is asset-based", async () => {
        // Bind a real ConcreteAdapterV1 on top of a minimal IERC4626 mock
        // to verify the patched contract path (not just the MockAdapter).
        const [deployer, vault] = await ethers.getSigners();
        const MockERC20 = await ethers.getContractFactory("MockERC20");
        const fyusd = await MockERC20.deploy("Mock FYUSD", "mFYUSD", 18);
        const MockConcreteVault = await ethers.getContractFactory("MockERC4626Vault");
        const concreteVault = await MockConcreteVault.deploy(
            await fyusd.getAddress(), "cFYUSD", "cFYUSD",
        );
        const Adapter = await ethers.getContractFactory("ConcreteAdapterV1");
        const adapter = await Adapter.deploy(
            await fyusd.getAddress(),
            await concreteVault.getAddress(),
            vault.address,
        );

        await (await fyusd.mint(vault.address, 1_000n * ONE)).wait();
        await (await fyusd.connect(vault).approve(await adapter.getAddress(), ethers.MaxUint256)).wait();
        await (await adapter.connect(vault).deposit(1_000n * ONE)).wait();

        // Withdraw half: 500 assets.
        const balBefore = await fyusd.balanceOf(vault.address);
        await (await adapter.connect(vault).withdraw(500n * ONE)).wait();
        const balAfter = await fyusd.balanceOf(vault.address);
        assert.equal(balAfter - balBefore, 500n * ONE,
            "asset-based withdraw delivers exactly the requested amount");
    });
});

// ─── FYP-13 + FYP-47 — claimer-counter + residue absorption ──────────

describe("FYP-13 + FYP-47 — last-claim residue + DISTRIBUTED terminal", () => {
    async function deploy() {
        const [deployer, executor, alice, bob, carol] = await ethers.getSigners();
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
        for (const u of [alice, bob, carol]) {
            await (await usdt.mint(u.address, 1_000n * ONE)).wait();
            await (await usdt.connect(u).approve(await epoch.getAddress(), ethers.MaxUint256)).wait();
        }
        return { deployer, executor, alice, bob, carol, usdt, fyusd, epoch };
    }

    async function signDeposit(signer, epochAddr, quote) {
        const { chainId } = await ethers.provider.getNetwork();
        const domain = {
            name: "FyusdEpochSettlement", version: "1", chainId,
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

    it("last claimer absorbs the floor-rounded residue; epoch advances to DISTRIBUTED", async () => {
        const { deployer, executor, alice, bob, carol, usdt, fyusd, epoch } = await deploy();

        await (await epoch.openEpoch(12 * 3600, 10 * 3600)).wait();
        const epochId = await epoch.nextEpochId();
        const asset = await usdt.getAddress();
        const expiry = (await latestTimestamp()) + 3600n;

        // Three users deposit different amounts so the pro-rata math
        // doesn't divide cleanly. Total entitlement = 10 FYUSD.
        const deposits = [
            { user: alice, amt: 3n * ONE, nonce: 1n },
            { user: bob,   amt: 3n * ONE, nonce: 2n },
            { user: carol, amt: 4n * ONE, nonce: 3n },
        ];
        for (const d of deposits) {
            const q = {
                user: d.user.address, epochId,
                collateralAsset: asset,
                collateralAmount: d.amt,
                fyusdAmount: d.amt,
                nonce: d.nonce, expiry,
            };
            const sig = await signDeposit(deployer, await epoch.getAddress(), q);
            await (await epoch.deposit(q, sig)).wait();
        }
        assert.equal(await epoch.numClaimers(epochId), 3n);

        await increaseTime(10 * 3600 + 1);
        await (await epoch.lockEpoch(epochId)).wait();

        // Settle with an odd amount that won't divide cleanly across
        // 3 entitlements of (3, 3, 4) out of 10 total.
        // Use fyusdMinted = 10e18 - 1 (off by 1 wei to force residue).
        const fyusdMinted = 10n * ONE - 1n;
        await (await epoch.connect(executor).settleEpoch(epochId, fyusdMinted)).wait();

        // First two claims get pro-rata; third (last) absorbs residue.
        await (await epoch.claim(epochId, alice.address)).wait();
        await (await epoch.claim(epochId, bob.address)).wait();
        const sumSoFar =
            (await fyusd.balanceOf(alice.address)) +
            (await fyusd.balanceOf(bob.address));
        await (await epoch.claim(epochId, carol.address)).wait();
        const carolPaid = await fyusd.balanceOf(carol.address);

        // Sum across all claimants MUST equal fyusdMinted exactly.
        assert.equal(sumSoFar + carolPaid, fyusdMinted,
            "no FYUSD dust stranded in the contract");
        // Epoch is now DISTRIBUTED.
        assert.equal(await epoch.epochState(epochId), 4n /* DISTRIBUTED */);
    });

    it("DISTRIBUTED is terminal — further claims revert", async () => {
        const { deployer, executor, alice, usdt, epoch } = await deploy();
        await (await epoch.openEpoch(12 * 3600, 10 * 3600)).wait();
        const epochId = await epoch.nextEpochId();
        const expiry = (await latestTimestamp()) + 3600n;
        const q = {
            user: alice.address, epochId,
            collateralAsset: await usdt.getAddress(),
            collateralAmount: 100n * ONE,
            fyusdAmount: 100n * ONE,
            nonce: 1n, expiry,
        };
        const sig = await signDeposit(deployer, await epoch.getAddress(), q);
        await (await epoch.deposit(q, sig)).wait();
        await increaseTime(10 * 3600 + 1);
        await (await epoch.lockEpoch(epochId)).wait();
        await (await epoch.connect(executor).settleEpoch(epochId, 100n * ONE)).wait();
        // Single claimant claims → epoch becomes DISTRIBUTED in one step.
        await (await epoch.claim(epochId, alice.address)).wait();
        assert.equal(await epoch.epochState(epochId), 4n /* DISTRIBUTED */);

        // Any further claim attempt reverts InvalidState.
        await assert.rejects(
            epoch.claim(epochId, alice.address),
            (err) => err.message.includes("AlreadyClaimed"),
        );
    });
});

// ─── FYP-58 — pull-claim model ───────────────────────────────────────

describe("FYP-58 — pull-claim rewards decouple principal from reward solvency", () => {
    async function deploy() {
        const [deployer, alice, funder] = await ethers.getSigners();
        const SettingManagement = await ethers.getContractFactory("SettingManagement");
        const setting = await upgrades.deployProxy(SettingManagement, [deployer.address], {
            initializer: "initialize", kind: "transparent",
        });
        const MockERC20 = await ethers.getContractFactory("MockERC20");
        const rusd = await MockERC20.deploy("RUSD", "RUSD", 18);
        const fpy = await MockERC20.deploy("FYP", "FYP", 18);
        const Hub = await ethers.getContractFactory("FypherStakingHub");
        const hub = await upgrades.deployProxy(
            Hub,
            [await setting.getAddress(), await fpy.getAddress(), ONE],
            { initializer: "initialize", kind: "transparent" },
        );
        await (await hub.addPool(await rusd.getAddress(), 10_000)).wait();
        await (await rusd.mint(alice.address, 1_000n * ONE)).wait();
        await (await rusd.connect(alice).approve(await hub.getAddress(), ethers.MaxUint256)).wait();
        return { deployer, alice, funder, rusd, fpy, hub };
    }

    it("unstake returns principal even when the hub holds zero FPY", async () => {
        const { alice, rusd, fpy, hub } = await deploy();
        await (await hub.connect(alice).stake(0, 100n * ONE)).wait();
        await mineBlocks(5);
        // Hub is intentionally unfunded for FYP.
        const rusdBefore = await rusd.balanceOf(alice.address);
        await (await hub.connect(alice).unstake(0, 100n * ONE)).wait();
        assert.equal(await rusd.balanceOf(alice.address) - rusdBefore, 100n * ONE,
            "principal returned regardless of reward solvency");
        assert.equal(await fpy.balanceOf(alice.address), 0n);
        assert.ok((await hub.pendingFpyRewards(alice.address)) > 0n);
    });

    it("claim partially pays when treasury is short, balance stays booked", async () => {
        const { alice, funder, fpy, hub } = await deploy();
        await (await hub.connect(alice).stake(0, 100n * ONE)).wait();
        await mineBlocks(5);

        // Fund the hub with a tiny amount.
        await (await fpy.mint(funder.address, 2n * ONE)).wait();
        await (await fpy.connect(funder).approve(await hub.getAddress(), ethers.MaxUint256)).wait();
        await (await fpy.connect(funder).transfer(await hub.getAddress(), 2n * ONE)).wait();

        const fpyBefore = await fpy.balanceOf(alice.address);
        await (await hub.connect(alice).claim(0)).wait();
        const fpyAfter = await fpy.balanceOf(alice.address);

        // Hub held 2 FYP; user got that much, the rest stays pending.
        assert.equal(fpyAfter - fpyBefore, 2n * ONE);
        assert.ok((await hub.pendingFpyRewards(alice.address)) > 0n);
    });

    it("claimableRewards rolls pendingFpyRewards + live per-pool projection", async () => {
        const { alice, rusd, hub } = await deploy();
        await (await hub.connect(alice).stake(0, 100n * ONE)).wait();
        await mineBlocks(5);
        const live = await hub.claimableRewards(alice.address);
        assert.ok(live > 0n);
    });
});

// ─── FYP-59 — permissionless force cancel ────────────────────────────

describe("FYP-59 — permissionless forceCancel after endAt", () => {
    async function deploy() {
        const [deployer, executor, alice, anyone] = await ethers.getSigners();
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
        await (await usdt.mint(alice.address, 1_000n * ONE)).wait();
        await (await usdt.connect(alice).approve(await epoch.getAddress(), ethers.MaxUint256)).wait();
        return { deployer, executor, alice, anyone, usdt, fyusd, epoch };
    }

    it("rejects forceCancel before endAt; accepts after; refund path works", async () => {
        const { deployer, alice, anyone, usdt, epoch } = await deploy();
        await (await epoch.openEpoch(12 * 3600, 10 * 3600)).wait();
        const epochId = await epoch.nextEpochId();
        const expiry = (await latestTimestamp()) + 3600n;
        const q = {
            user: alice.address, epochId,
            collateralAsset: await usdt.getAddress(),
            collateralAmount: 100n * ONE,
            fyusdAmount: 100n * ONE,
            nonce: 1n, expiry,
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
        const sig = await deployer.signTypedData(domain, types, q);
        await (await epoch.deposit(q, sig)).wait();

        // Lock the epoch.
        await increaseTime(10 * 3600 + 1);
        await (await epoch.lockEpoch(epochId)).wait();

        // Before endAt, forceCancel reverts.
        await assert.rejects(
            epoch.connect(anyone).forceCancel(epochId),
            (err) => err.message.includes("SettlementWindowActive"),
        );

        // After endAt, anyone can force-cancel.
        await increaseTime(2 * 3600 + 1);
        await (await epoch.connect(anyone).forceCancel(epochId)).wait();
        assert.equal(await epoch.epochState(epochId), 5n /* CANCELLED */);

        // User claims refund.
        const usdtBefore = await usdt.balanceOf(alice.address);
        await (await epoch.claim(epochId, alice.address)).wait();
        assert.equal(await usdt.balanceOf(alice.address) - usdtBefore, 100n * ONE);
    });
});
