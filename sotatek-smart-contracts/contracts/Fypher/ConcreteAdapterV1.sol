// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/interfaces/IERC4626.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./IConcreteAdapter.sol";

/**
 * @title ConcreteAdapterV1
 * @notice Live binding of {IConcreteAdapter} against a Concrete (concrete.xyz)
 *         Earn V2 ERC-4626 vault. Replaces the BSC-era {MockConcreteAdapter}
 *         once the network's Concrete deployment is confirmed.
 *
 *         Per ADR-006 the {FyusdYieldVault} sits in front of this adapter:
 *
 *         <pre>
 *           User → FyusdYieldVault.deposit(amount)
 *                 → ConcreteAdapterV1.deposit(amount)         // this contract
 *                     → concreteVault.deposit(amount, this)   // Concrete Earn V2
 *         </pre>
 *
 *         The adapter never exposes assets to FyusdYieldVault directly;
 *         every share's claim on FYUSD is mediated through Concrete's vault.
 *         Yield accrues silently inside Concrete; the adapter surfaces it
 *         via {totalAssets} (which delegates to
 *         {IERC4626.convertToAssets} on the underlying).
 *
 * <p><b>Why a separate adapter contract</b>: keeps the vault layer
 * portable. Today the underlying is Concrete; tomorrow we may swap in
 * a different yield source (Pendle, Morpho, etc.) by deploying a new
 * adapter implementation and pointing {FyusdYieldVault.setAdapter}
 * at it — without touching the vault's storage layout or share-supply
 * accounting.
 *
 * <p><b>Share accounting</b>: the adapter mints its own internal
 * shares 1:1 with the underlying-asset value at the moment of deposit
 * (so the vault's own ERC-4626 share supply tracks ours 1:1). Yield
 * accrual is reflected purely by {totalAssets} growing — share count
 * stays constant per holder. On withdraw, shares burn proportional to
 * the vault's vToken burn; the adapter looks up the corresponding
 * FYUSD amount from the (totalAssets, totalShares) ratio and pulls
 * that amount out of Concrete to deliver to the caller.
 *
 * <p><b>Single-tenant binding (FYP-01 / FYP-10)</b>: the adapter binds
 * to exactly one vault address at construction. Only that vault can
 * call {deposit} and {withdraw}, and {totalAssets} reports an
 * internally-tracked Concrete-share balance rather than the adapter's
 * raw `concreteVault.balanceOf(this)`. Both choices close the same
 * class of attack: an attacker who deposits directly into the adapter
 * (or sends Concrete shares to it) cannot inflate the vault's share
 * price or block exits, because the vault's accounting reads only
 * what the adapter mediated. Any excess Concrete shares parked on the
 * adapter are recoverable only through {sweepConcreteShares} (admin-
 * gated via the bound vault).
 *
 * <p><b>Withdrawal mode assumption</b>: this adapter assumes Concrete
 * vault is in <i>standard</i> mode (atomic ERC-4626 withdrawals). If
 * Concrete configures the underlying vault in <i>async</i> mode (epoch-
 * batched per their Withdrawal Queue), {withdraw} will succeed at the
 * EVM layer (the call returns) but FYUSD won't actually arrive in our
 * caller's balance until Concrete's allocator processes the next
 * epoch. The vault's {AdapterReturnedShort} guard catches that
 * misbehaviour by checking the FYUSD balance delta. A v2 adapter that
 * speaks the async API (`processEpoch`, `claimWithdrawal`)
 * is the correct fix — out of scope here.
 *
 * <p><b>Whitelisting</b>: Concrete's vault enforces a per-deposit-
 * caller whitelist via the Hook system (Earn V2). The caller of
 * {concreteVault.deposit(...)} is THIS adapter — so the address that
 * needs whitelisting is {address(this)}, NOT the upstream
 * {FyusdYieldVault}. Coordinate the whitelist payload with Concrete
 * after deploying this adapter.
 */
contract ConcreteAdapterV1 is IConcreteAdapter {
    using SafeERC20 for IERC20;

    /// @notice The underlying token. Set at construction; immutable.
    ///         MUST equal {IERC4626.asset} on the Concrete vault — checked
    ///         in the constructor and reverts on mismatch.
    IERC20 public immutable fyusd;

    /// @notice The Concrete Earn V2 ERC-4626 vault we delegate yield
    ///         generation to. Owned + curated by Concrete; we are an LP.
    IERC4626 public immutable concreteVault;

    /// @notice The single vault permitted to call {deposit}/{withdraw}.
    ///         Bound at construction; immutable so a compromised admin
    ///         cannot redirect adapter flow to an attacker-controlled
    ///         vault. (FYP-01 patch.)
    address public immutable vault;

    /// @notice Internal share accounting per holder. Distinct from the
    ///         shares Concrete vault holds for {address(this)} — the
    ///         adapter mints its own ERC-20-style supply so the
    ///         FyusdYieldVault layer's vToken supply tracks ours 1:1
    ///         (which the cooldown flow depends on).
    mapping(address => uint256) private _shareOf;

    /// @notice Total adapter shares minted across all holders. Kept in
    ///         sync with {_shareOf} so {totalAssets * shares / totalShares}
    ///         can size each withdrawal proportionally.
    uint256 public totalShares;

    /// @notice Concrete-vault share balance the adapter is willing to
    ///         account for. Updated only inside {deposit}/{withdraw} so
    ///         that direct ERC-20 transfers of Concrete shares to this
    ///         adapter (FYP-10 attack surface) are excluded from
    ///         {totalAssets} and cannot distort the vault's share
    ///         pricing. Reconciliation of the excess goes through
    ///         {sweepConcreteShares}, which is admin-gated via the
    ///         bound vault.
    uint256 public accountedConcreteShares;

    // ── Events ──
    event Deposited(address indexed caller, uint256 assetsIn, uint256 sharesMinted);
    event Withdrawn (address indexed caller, uint256 sharesBurned, uint256 assetsOut);
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

    constructor(IERC20 _fyusd, IERC4626 _concreteVault, address _vault) {
        if (address(_fyusd) == address(0)) revert ZeroAddress();
        if (address(_concreteVault) == address(0)) revert ZeroAddress();
        if (_vault == address(0)) revert ZeroAddress();
        if (_concreteVault.asset() != address(_fyusd)) {
            revert AdapterAssetMismatch(address(_fyusd), _concreteVault.asset());
        }
        fyusd = _fyusd;
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
        return address(fyusd);
    }

    /// @inheritdoc IConcreteAdapter
    /// @dev Reports the asset value of the Concrete shares the adapter
    ///      has TRACKED in {accountedConcreteShares} — NOT
    ///      `concreteVault.balanceOf(this)`. This excludes any
    ///      Concrete shares that landed on the adapter by direct
    ///      transfer (FYP-10) from share-price math, so vault share
    ///      pricing depends only on adapter-mediated activity.
    function totalAssets() public view returns (uint256) {
        return concreteVault.convertToAssets(accountedConcreteShares);
    }

    /// @inheritdoc IConcreteAdapter
    function shareOf(address holder) external view returns (uint256) {
        return _shareOf[holder];
    }

    /// @inheritdoc IConcreteAdapter
    /// @dev Concrete's ERC-4626 vault does NOT expose a 7d-realized-APY
    ///      number directly — computing it would require time-series
    ///      snapshots (block-timestamped totalAssets samples). Neither
    ///      this adapter nor Concrete keeps that on chain; the
    ///      authoritative source is Concrete's subgraph.
    ///
    ///      Returning 0 keeps the dashboard's "7d realized APY" widget
    ///      honest about the missing data. The follow-up plan: a backend
    ///      service queries Concrete's subgraph (`vault.apyDetails`,
    ///      see Earn-V2/SDK getAPYDetails) and surfaces it through a
    ///      separate gateway endpoint. The on-chain adapter doesn't
    ///      need to mirror it.
    function realizedYield7d() external pure returns (uint256) {
        return 0;
    }

    /// @inheritdoc IConcreteAdapter
    /// @dev Pulls {amount} FYUSD from {msg.sender} (the bound vault),
    ///      forwards to Concrete's vault as a deposit, mints adapter
    ///      shares to msg.sender 1:1 with the asset value at this
    ///      moment.
    ///
    ///      <p>Two share calculations for first-deposit vs steady-state:
    ///      on the very first deposit (totalShares == 0), we mint
    ///      {amount} shares (a 1-share-per-1-asset bootstrap). After
    ///      that, shares = {amount * totalShares / totalAssets} which
    ///      preserves the share-price invariant when other deposits
    ///      happen between yield accruals.
    function deposit(uint256 amount) external onlyVault returns (uint256 shares) {
        if (amount == 0) revert ZeroAmount();

        // Pull underlying from the bound vault. The vault MUST have
        // approved address(this) for {amount} prior to this call —
        // FyusdYieldVault._deposit does that via forceApprove.
        fyusd.safeTransferFrom(msg.sender, address(this), amount);

        // Pre-deposit asset value drives the share-mint ratio. After
        // calling concreteVault.deposit, totalAssets() will reflect
        // the new balance — so we MUST snapshot it now.
        uint256 ta = totalAssets();
        shares = (totalShares == 0 || ta == 0) ? amount : (amount * totalShares) / ta;

        // Forward to Concrete. address(this) is the receiver — Concrete
        // mints its own shares to us; we hold them as our backing.
        // Snapshot the Concrete-share delta to update our internal
        // tracker, since {accountedConcreteShares} (not raw
        // balanceOf) backs totalAssets going forward.
        uint256 cBefore = concreteVault.balanceOf(address(this));
        fyusd.forceApprove(address(concreteVault), amount);
        concreteVault.deposit(amount, address(this));
        uint256 cAfter = concreteVault.balanceOf(address(this));
        accountedConcreteShares += (cAfter - cBefore);

        _shareOf[msg.sender] += shares;
        totalShares          += shares;

        emit Deposited(msg.sender, amount, shares);
        return shares;
    }

    /// @inheritdoc IConcreteAdapter
    /// @dev FYP-41 patch. The parameter is now `fyusdAmount`
    ///      (asset-based), not adapter-shares. The adapter computes
    ///      how many of its own internal shares back the requested
    ///      asset amount (`ceildiv(amount * totalShares, totalAssets)`)
    ///      and burns at least that many. This lets the upstream
    ///      vault stay the single source of share accounting (the
    ///      adapter's internal `_shareOf` map only matters for ops
    ///      dashboards now) and removes the divergence-then-drain
    ///      class of bug CertiK's FYP-41 PoC reproduced.
    ///
    ///      <p>Concrete's {IERC4626.withdraw} burns enough Concrete-
    ///      vault shares to release the requested asset amount; the
    ///      adapter mirrors that contract with the {receiver}
    ///      argument set to `msg.sender` so the upstream vault sees
    ///      the asset land in its own balance.
    function withdraw(uint256 fyusdAmount) external onlyVault returns (uint256) {
        if (fyusdAmount == 0) revert ZeroAmount();
        uint256 ta = totalAssets();
        if (ta == 0 || totalShares == 0) revert InsufficientAssets(fyusdAmount, ta);
        if (fyusdAmount > ta) revert InsufficientAssets(fyusdAmount, ta);

        // Ceil-divide so the burn never under-charges shares for the
        // delivered asset amount. Worst-case rounding gives the caller
        // up to (1 / totalShares) wei of extra asset value, which is
        // negligible at any realistic scale.
        uint256 burnShares = Math.ceilDiv(fyusdAmount * totalShares, ta);
        uint256 available = _shareOf[msg.sender];
        if (burnShares > available) revert InsufficientShares(burnShares, available);

        _shareOf[msg.sender] = available - burnShares;
        totalShares         -= burnShares;

        // Pull from Concrete to msg.sender. address(this) is the share
        // owner (we hold the Concrete shares); msg.sender (the bound
        // vault) is the FYUSD receiver. ERC-4626 tolerates owner ==
        // sender or owner == address(this) without allowance.
        // Snapshot the Concrete-share delta to update our internal
        // tracker so subsequent totalAssets() readings stay correct.
        uint256 cBefore = concreteVault.balanceOf(address(this));
        concreteVault.withdraw(fyusdAmount, msg.sender, address(this));
        uint256 cAfter = concreteVault.balanceOf(address(this));
        uint256 burned = cBefore - cAfter;
        accountedConcreteShares = burned > accountedConcreteShares
            ? 0
            : accountedConcreteShares - burned;

        emit Withdrawn(msg.sender, burnShares, fyusdAmount);
        return fyusdAmount;
    }

    /**
     * @notice Recovery hatch for Concrete shares that landed on the
     *         adapter outside of {deposit} — direct ERC-20 transfers,
     *         airdrops, or operator mistakes. The excess (raw balance
     *         minus accounted) is forwarded to {to}. The bound vault's
     *         admin chain authorises the call (we delegate the
     *         authorisation to the vault rather than re-implementing
     *         a role check, so the adapter stays minimal).
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
