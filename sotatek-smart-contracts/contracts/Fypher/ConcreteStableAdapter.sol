// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/interfaces/IERC4626.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./IConcreteAdapter.sol";

/**
 * @title ConcreteStableAdapter
 * @notice The 30%-leg adapter for the 70:30 Earn flow (PRODUCT-FLOWS
 *         §6-1 / C-5). Binds {IConcreteAdapter} against a Concrete
 *         (concrete.xyz) Earn V2 ERC-4626 vault whose underlying is a
 *         **stablecoin (USDT/USDC)** — NOT FYUSD.
 *
 *         This is the sister contract to {ConcreteAdapterV1}: same
 *         single-tenant, internally-accounted share model, but the
 *         underlying asset is the raw collateral stablecoin so the Earn
 *         30% leg can deposit USDT/USDC straight into Concrete with **no FYUSD
 *         conversion** (the whole point of the §6-1 "stablecoin direct"
 *         decision — avoids a BitGo round-trip for the on-chain leg).
 *
 *         <pre>
 *           Keeper → FyusdEarnVault.depositBlended(...)            // 30% leg only
 *                  → ConcreteStableAdapter.deposit(stableAmount)     // this contract
 *                      → concreteVault.deposit(stableAmount, this)   // Concrete Earn V2 (USDT/USDC)
 *         </pre>
 *
 * <p><b>Why a distinct contract rather than reusing ConcreteAdapterV1</b>:
 * the adapter↔Concrete-vault asset binding is immutable and checked at
 * construction (`concreteVault.asset() == stable`). ConcreteAdapterV1 is
 * bound to a FYUSD Concrete vault; the Earn 30% leg needs a USDT/USDC Concrete
 * vault. Different underlying ⇒ different deployed instance. The interface
 * ({IConcreteAdapter}) is identical so {FyusdEarnVault} can hold either.
 *
 * <p><b>Single-tenant binding (FYP-01 / FYP-10)</b>: identical to
 * ConcreteAdapterV1 — the adapter binds to exactly one vault at
 * construction; only that vault may call {deposit}/{withdraw};
 * {totalAssets} reports {accountedConcreteShares} (deposit-mediated only),
 * not the raw `balanceOf`, so a direct share transfer cannot distort vault
 * share pricing. Excess is recoverable through {sweepConcreteShares}.
 *
 * <p><b>Withdrawal mode assumption</b>: assumes Concrete's USDT/USDC vault is in
 * <i>standard</i> (atomic ERC-4626) mode, exactly like ConcreteAdapterV1.
 * If Concrete configures it in <i>async</i> mode (epoch-batched withdrawal
 * queue), {withdraw} returns at the EVM layer but USDT/USDC does not arrive
 * until Concrete processes the next epoch; the upstream
 * {FyusdEarnVault}'s balance-delta guard catches the shortfall. A v2
 * adapter speaking the async API (`processEpoch`/`claimWithdrawal`) is the
 * correct fix and is out of scope here — note PRODUCT-FLOWS §C-5 flags
 * "async 가능성". The 14-day user-facing cooldown lives in the vault's
 * silo, not in this adapter.
 *
 * <p><b>Whitelisting</b>: Concrete's vault enforces a per-deposit-caller
 * whitelist (Earn V2 Hook system). The caller of
 * {concreteVault.deposit(...)} is THIS adapter, so {address(this)} is the
 * address Concrete must whitelist — coordinate the payload with Concrete
 * after deploying this adapter.
 */
contract ConcreteStableAdapter is IConcreteAdapter {
    using SafeERC20 for IERC20;

    /// @notice The underlying stablecoin (USDT/USDC). Set at construction;
    ///         immutable. MUST equal {IERC4626.asset} on the Concrete
    ///         vault — checked in the constructor, reverts on mismatch.
    IERC20 public immutable stable;

    /// @notice The Concrete Earn V2 ERC-4626 vault (USDT/USDC) we delegate
    ///         yield generation to. Owned + curated by Concrete; we are an LP.
    IERC4626 public immutable concreteVault;

    /// @notice The single vault permitted to call {deposit}/{withdraw}.
    ///         Bound at construction; immutable so a compromised admin
    ///         cannot redirect adapter flow to an attacker-controlled
    ///         vault. (FYP-01 patch.)
    address public immutable vault;

    /// @notice Internal share accounting per holder. The adapter mints its
    ///         own supply so the {FyusdEarnVault} layer can size the
    ///         on-chain (30%) leg of each withdrawal proportionally.
    mapping(address => uint256) private _shareOf;

    /// @notice Total adapter shares minted across all holders.
    uint256 public totalShares;

    /// @notice Concrete-vault share balance the adapter accounts for.
    ///         Updated only inside {deposit}/{withdraw} so direct ERC-20
    ///         transfers of Concrete shares to this adapter (FYP-10) are
    ///         excluded from {totalAssets} and cannot distort the vault's
    ///         share pricing. Excess goes through {sweepConcreteShares}.
    uint256 public accountedConcreteShares;

    // ── Events ──
    event Deposited(address indexed caller, uint256 assetsIn, uint256 sharesMinted);
    event Withdrawn(address indexed caller, uint256 sharesBurned, uint256 assetsOut);
    event ConcreteSharesSwept(address indexed to, uint256 amount);

    // ── Errors ──
    error AdapterAssetMismatch(address expected, address actual);
    error InsufficientShares(uint256 requested, uint256 available);
    error ZeroAmount();
    error ZeroAddress();
    error NotVault();
    error NoExcessShares();
    /// @notice FYP-41: caller asked for more underlying than the adapter
    ///         currently controls via Concrete (totalAssets).
    error InsufficientAssets(uint256 requested, uint256 available);

    constructor(IERC20 _stable, IERC4626 _concreteVault, address _vault) {
        if (address(_stable) == address(0)) revert ZeroAddress();
        if (address(_concreteVault) == address(0)) revert ZeroAddress();
        if (_vault == address(0)) revert ZeroAddress();
        if (_concreteVault.asset() != address(_stable)) {
            revert AdapterAssetMismatch(address(_stable), _concreteVault.asset());
        }
        stable = _stable;
        concreteVault = _concreteVault;
        vault = _vault;
    }

    // ── Modifiers ──

    /// @notice Only the bound vault may call adapter mutators. (FYP-01.)
    modifier onlyVault() {
        if (msg.sender != vault) revert NotVault();
        _;
    }

    // ── IConcreteAdapter ──

    /// @inheritdoc IConcreteAdapter
    function asset() external view returns (address) {
        return address(stable);
    }

    /// @inheritdoc IConcreteAdapter
    /// @dev Reports the asset value of the Concrete shares the adapter has
    ///      TRACKED in {accountedConcreteShares} — NOT
    ///      `concreteVault.balanceOf(this)`. Excludes direct-transfer
    ///      shares (FYP-10) from share-price math.
    function totalAssets() public view returns (uint256) {
        return concreteVault.convertToAssets(accountedConcreteShares);
    }

    /// @inheritdoc IConcreteAdapter
    function shareOf(address holder) external view returns (uint256) {
        return _shareOf[holder];
    }

    /// @inheritdoc IConcreteAdapter
    /// @dev Concrete's ERC-4626 vault does NOT expose a 7d-realized-APY
    ///      number on-chain; the authoritative source is Concrete's
    ///      subgraph (queried by the backend, surfaced via a gateway
    ///      endpoint). Returning 0 keeps the dashboard honest about the
    ///      missing on-chain data — same posture as ConcreteAdapterV1.
    function realizedYield7d() external pure returns (uint256) {
        return 0;
    }

    /// @inheritdoc IConcreteAdapter
    /// @dev Pulls {amount} USDT/USDC from {msg.sender} (the bound vault),
    ///      forwards to Concrete's vault, mints adapter shares to
    ///      msg.sender. First deposit (totalShares == 0) bootstraps 1:1;
    ///      thereafter shares = amount * totalShares / totalAssets, which
    ///      preserves the share-price invariant across yield accruals.
    function deposit(uint256 amount) external onlyVault returns (uint256 shares) {
        if (amount == 0) revert ZeroAmount();

        // Pull underlying from the bound vault. The vault MUST have
        // approved address(this) for {amount} prior to this call.
        stable.safeTransferFrom(msg.sender, address(this), amount);

        // Pre-deposit asset value drives the share-mint ratio. Snapshot it
        // now, before concreteVault.deposit changes our backing.
        uint256 ta = totalAssets();
        shares = (totalShares == 0 || ta == 0) ? amount : (amount * totalShares) / ta;

        // Forward to Concrete (address(this) is the receiver). Snapshot the
        // Concrete-share delta so {accountedConcreteShares} (not raw
        // balanceOf) backs totalAssets. FYP-55: reset allowance to 0 after
        // the deposit so an upstream vault that under-consumes the approval
        // cannot pull additional USDT/USDC on a later call.
        uint256 cBefore = concreteVault.balanceOf(address(this));
        stable.forceApprove(address(concreteVault), amount);
        concreteVault.deposit(amount, address(this));
        stable.forceApprove(address(concreteVault), 0);
        uint256 cAfter = concreteVault.balanceOf(address(this));
        accountedConcreteShares += (cAfter - cBefore);

        _shareOf[msg.sender] += shares;
        totalShares += shares;

        emit Deposited(msg.sender, amount, shares);
        return shares;
    }

    /// @inheritdoc IConcreteAdapter
    /// @dev FYP-41 asset-based withdraw. The parameter is `stableAmount`
    ///      (assets), not adapter-shares: the adapter computes the share
    ///      burn (`ceildiv(amount * totalShares, totalAssets)`) internally
    ///      so the upstream vault stays the single source of share
    ///      accounting. Concrete's {IERC4626.withdraw} burns enough
    ///      Concrete shares to release the requested USDT/USDC; we set
    ///      {receiver} = msg.sender so the vault sees the asset land.
    function withdraw(uint256 stableAmount) external onlyVault returns (uint256) {
        if (stableAmount == 0) revert ZeroAmount();
        uint256 ta = totalAssets();
        if (ta == 0 || totalShares == 0) revert InsufficientAssets(stableAmount, ta);
        if (stableAmount > ta) revert InsufficientAssets(stableAmount, ta);

        // Ceil-divide so the burn never under-charges shares for the
        // delivered asset amount (worst-case the caller gets up to
        // 1/totalShares wei extra — negligible at any realistic scale).
        uint256 burnShares = Math.ceilDiv(stableAmount * totalShares, ta);
        uint256 available = _shareOf[msg.sender];
        if (burnShares > available) revert InsufficientShares(burnShares, available);

        _shareOf[msg.sender] = available - burnShares;
        totalShares -= burnShares;

        // Pull from Concrete to msg.sender (the bound vault). address(this)
        // owns the Concrete shares; ERC-4626 tolerates owner == sender.
        // Snapshot the Concrete-share delta to keep our tracker correct.
        uint256 cBefore = concreteVault.balanceOf(address(this));
        concreteVault.withdraw(stableAmount, msg.sender, address(this));
        uint256 cAfter = concreteVault.balanceOf(address(this));
        uint256 burned = cBefore - cAfter;
        accountedConcreteShares = burned > accountedConcreteShares
            ? 0
            : accountedConcreteShares - burned;

        emit Withdrawn(msg.sender, burnShares, stableAmount);
        return stableAmount;
    }

    /**
     * @notice Recovery hatch for Concrete shares that landed on the adapter
     *         outside of {deposit} — direct ERC-20 transfers, airdrops, or
     *         operator mistakes. The excess (raw balance minus accounted)
     *         is forwarded to {to}. The bound vault's admin chain
     *         authorises the call (we delegate authorisation to the vault).
     *
     * @dev FYP-10 patch. Without this hatch, untracked Concrete shares
     *      would be permanently locked.
     */
    function sweepConcreteShares(address to) external onlyVault returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        uint256 raw = concreteVault.balanceOf(address(this));
        if (raw <= accountedConcreteShares) revert NoExcessShares();
        amount = raw - accountedConcreteShares;
        IERC20(address(concreteVault)).safeTransfer(to, amount);
        emit ConcreteSharesSwept(to, amount);
    }
}
