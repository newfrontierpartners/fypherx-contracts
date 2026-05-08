// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/interfaces/IERC4626.sol";
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

    // ── Events ──
    event Deposited(address indexed caller, uint256 assetsIn, uint256 sharesMinted);
    event Withdrawn (address indexed caller, uint256 sharesBurned, uint256 assetsOut);

    // ── Errors ──
    error AdapterAssetMismatch(address expected, address actual);
    error InsufficientShares(uint256 requested, uint256 available);
    error ZeroAmount();
    error ZeroAddress();

    constructor(IERC20 _fyusd, IERC4626 _concreteVault) {
        if (address(_fyusd) == address(0)) revert ZeroAddress();
        if (address(_concreteVault) == address(0)) revert ZeroAddress();
        if (_concreteVault.asset() != address(_fyusd)) {
            revert AdapterAssetMismatch(address(_fyusd), _concreteVault.asset());
        }
        fyusd = _fyusd;
        concreteVault = _concreteVault;
    }

    // ── IConcreteAdapter ──

    /// @inheritdoc IConcreteAdapter
    function asset() external view returns (address) {
        return address(fyusd);
    }

    /// @inheritdoc IConcreteAdapter
    /// @dev Delegates to {IERC4626.convertToAssets} on Concrete's vault.
    ///      As Concrete's NAV grows, this number grows in lockstep —
    ///      that's the entire yield-pass-through mechanism.
    function totalAssets() public view returns (uint256) {
        uint256 cShares = concreteVault.balanceOf(address(this));
        return concreteVault.convertToAssets(cShares);
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
    /// @dev Pulls {amount} FYUSD from {msg.sender} (the FyusdYieldVault),
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
    function deposit(uint256 amount) external returns (uint256 shares) {
        if (amount == 0) revert ZeroAmount();

        // Pull underlying from the caller (typically the FyusdYieldVault
        // contract). The caller MUST have approved address(this) for
        // {amount} prior to this call — vault.deposit does that via
        // forceApprove on every call.
        fyusd.safeTransferFrom(msg.sender, address(this), amount);

        // Pre-deposit asset value drives the share-mint ratio. After
        // calling concreteVault.deposit, totalAssets() will reflect
        // the new balance — so we MUST snapshot it now.
        uint256 ta = totalAssets();
        shares = (totalShares == 0 || ta == 0) ? amount : (amount * totalShares) / ta;

        // Forward to Concrete. address(this) is the receiver — Concrete
        // mints its own shares to us; we hold them as our backing.
        fyusd.forceApprove(address(concreteVault), amount);
        concreteVault.deposit(amount, address(this));

        _shareOf[msg.sender] += shares;
        totalShares          += shares;

        emit Deposited(msg.sender, amount, shares);
        return shares;
    }

    /// @inheritdoc IConcreteAdapter
    /// @dev Burns {shares} from {msg.sender}, computes the proportional
    ///      FYUSD amount they're entitled to from
    ///      {totalAssets * shares / totalShares}, and pulls that amount
    ///      out of Concrete directly to the caller.
    ///
    ///      <p>Concrete's {IERC4626.withdraw} burns enough Concrete-
    ///      vault shares to release the requested asset amount; the
    ///      adapter doesn't need to compute a Concrete-share burn count
    ///      manually. The {receiver} parameter forwards FYUSD to
    ///      msg.sender so the upstream vault sees the asset land in its
    ///      own balance — matching the contract surface
    ///      {FyusdYieldVault._exitToCooldown} expects.
    function withdraw(uint256 shares) external returns (uint256 amount) {
        if (shares == 0) revert ZeroAmount();
        uint256 available = _shareOf[msg.sender];
        if (shares > available) revert InsufficientShares(shares, available);

        // Compute proportional asset amount BEFORE updating totalShares —
        // the math depends on the pre-burn ratio. Order matters under the
        // CEI pattern (compute → state-update → external-call).
        amount = (totalAssets() * shares) / totalShares;

        _shareOf[msg.sender] = available - shares;
        totalShares         -= shares;

        // Pull from Concrete to msg.sender. address(this) is the share
        // owner (we hold the Concrete shares). msg.sender is the FYUSD
        // receiver. ERC-4626 tolerates owner == sender or owner ==
        // address(this) without allowance — we're the owner here, so no
        // allowance check fires.
        concreteVault.withdraw(amount, msg.sender, address(this));

        emit Withdrawn(msg.sender, shares, amount);
        return amount;
    }
}
