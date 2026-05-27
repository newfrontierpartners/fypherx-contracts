// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "../Fypher/IConcreteAdapter.sol";

/**
 * @title MockConcreteAdapter
 * @notice Test-/BSC-Testnet substitute for the real Concrete adapter
 *         (per ADR-006). Implements {IConcreteAdapter} with simulated
 *         yield: linear at `apyBps` basis points / year, accrued
 *         continuously into the totalAssets accounting.
 *
 *         Shares are tracked 1:1 with deposited FYUSD principal — the
 *         simulated yield inflates {totalAssets} (and therefore the
 *         vault's per-share NAV) without minting more shares.
 *
 *         This contract holds the FYUSD itself; on withdraw it pays
 *         out principal + accrued yield by drawing on its own balance.
 *         The deployer (or anyone) MUST seed the adapter with enough
 *         FYUSD to cover yield obligations via {fundYield}; if the
 *         balance is short, withdraw reverts InsufficientLiquidity.
 *
 *         NOT for production. ConcreteAdapterV1 is the mainnet
 *         counterpart that actually calls into the Concrete protocol.
 */
contract MockConcreteAdapter is IConcreteAdapter {
    using SafeERC20 for IERC20;

    uint256 private constant BPS_DENOMINATOR = 10_000;
    uint256 private constant SECONDS_PER_YEAR = 365 days;

    IERC20 public immutable fyusd;
    /// @notice Annualised yield rate in basis points. 400 = 4% APY.
    uint256 public immutable apyBps;
    /// @notice Optional single-tenant binding. When non-zero, only this
    ///         address may call {deposit}/{withdraw}, mirroring the
    ///         post-FYP-01 ConcreteAdapterV1 access model. Setting it to
    ///         zero in the constructor keeps the legacy free-for-all
    ///         behaviour for ad-hoc unit tests that exercise the adapter
    ///         in isolation.
    address public immutable vault;

    /// @notice Total FYUSD principal deposited (excluding simulated yield).
    uint256 public principal;
    /// @notice Snapshot timestamp of the last principal-affecting action,
    ///         used to accrue simulated yield on read.
    uint64  public lastAccrualAt;
    /// @notice Yield accrued so far but not yet baked into principal
    ///         (simulated income kept in a separate counter so the
    ///         standard MasterChef-style math stays clean).
    uint256 public accruedYield;

    mapping(address => uint256) private _shares;
    uint256 public totalShares;

    event Deposited(address indexed holder, uint256 fyusdAmount, uint256 shares);
    event Withdrawn(address indexed holder, uint256 shares, uint256 fyusdAmount);
    event YieldFunded(address indexed from, uint256 amount);

    error InsufficientLiquidity(uint256 have, uint256 want);
    error ZeroAmount();
    error InsufficientShares(uint256 have, uint256 want);
    error NotVault();
    /// @notice FYP-41: caller asked for more underlying than the
    ///         adapter currently tracks.
    error InsufficientAssets(uint256 requested, uint256 available);

    /// @notice Pass {_vault} non-zero to enforce the same single-tenant
    ///         access model as ConcreteAdapterV1, which is what
    ///         production-shape integration tests want. Pass
    ///         address(0) to keep the legacy free-for-all behaviour
    ///         for ad-hoc unit tests that exercise the adapter in
    ///         isolation.
    constructor(IERC20 _fyusd, uint256 _apyBps, address _vault) {
        fyusd = _fyusd;
        apyBps = _apyBps;
        lastAccrualAt = uint64(block.timestamp);
        vault = _vault;
    }

    /// @dev Only the bound vault (if any) may call adapter mutators.
    ///      When {vault} == address(0) the modifier is a no-op so legacy
    ///      ad-hoc unit tests keep working.
    modifier onlyVault() {
        if (vault != address(0) && msg.sender != vault) revert NotVault();
        _;
    }

    function asset() external view returns (address) {
        return address(fyusd);
    }

    function totalAssets() public view returns (uint256) {
        return principal + accruedYield + _pendingYield();
    }

    function shareOf(address holder) external view returns (uint256) {
        return _shares[holder];
    }

    function realizedYield7d() external view returns (uint256) {
        // For the mock, "realized" === simulated APY. Real adapter would
        // sample the trailing 7-day yield curve from Concrete on-chain
        // accrual records.
        return apyBps;
    }

    function deposit(uint256 fyusdAmount) external onlyVault returns (uint256 shares) {
        if (fyusdAmount == 0) revert ZeroAmount();
        _accrue();
        // Share/principal ratio: if no prior holders, 1:1; else preserve
        // existing per-share NAV.
        uint256 nav = totalShares == 0
            ? fyusdAmount
            : (fyusdAmount * totalShares) / (principal + accruedYield);
        shares = nav;
        fyusd.safeTransferFrom(msg.sender, address(this), fyusdAmount);
        principal += fyusdAmount;
        _shares[msg.sender] += shares;
        totalShares += shares;
        emit Deposited(msg.sender, fyusdAmount, shares);
    }

    /// @dev FYP-41 patch. Parameter semantics flipped from "burn this
    ///      many adapter-shares" to "release this many assets". See
    ///      {IConcreteAdapter.withdraw} for the cross-impl rationale.
    function withdraw(uint256 fyusdAmount) external onlyVault returns (uint256) {
        if (fyusdAmount == 0) revert ZeroAmount();
        _accrue();
        uint256 ta = principal + accruedYield;
        if (ta == 0 || totalShares == 0) revert InsufficientAssets(fyusdAmount, ta);
        if (fyusdAmount > ta) revert InsufficientAssets(fyusdAmount, ta);

        uint256 bal = fyusd.balanceOf(address(this));
        if (bal < fyusdAmount) revert InsufficientLiquidity(bal, fyusdAmount);

        // Burn just enough adapter-shares (ceil) to back the asset
        // amount, exactly mirroring ConcreteAdapterV1.
        uint256 burnShares = Math.ceilDiv(fyusdAmount * totalShares, ta);
        if (_shares[msg.sender] < burnShares) {
            revert InsufficientShares(_shares[msg.sender], burnShares);
        }

        // Decrement principal proportionally; remaining (yield portion)
        // comes out of accruedYield. Use the burn-share ratio so the
        // split tracks how much of the burned shares was "principal"
        // versus "yield".
        uint256 principalShare = (burnShares * principal) / totalShares;
        if (principalShare > fyusdAmount) principalShare = fyusdAmount;
        uint256 yieldShare = fyusdAmount - principalShare;
        principal -= principalShare;
        if (yieldShare > accruedYield) {
            // Defensive: if the ratio split overshoots accruedYield
            // (possible at exact yield boundaries), clamp to what's
            // actually accrued.
            yieldShare = accruedYield;
        }
        accruedYield -= yieldShare;
        _shares[msg.sender] -= burnShares;
        totalShares -= burnShares;

        fyusd.safeTransfer(msg.sender, fyusdAmount);
        emit Withdrawn(msg.sender, burnShares, fyusdAmount);
        return fyusdAmount;
    }

    /// @notice Donate FYUSD to the adapter to cover yield obligations.
    function fundYield(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        fyusd.safeTransferFrom(msg.sender, address(this), amount);
        emit YieldFunded(msg.sender, amount);
    }

    // ── Internal ──

    function _accrue() internal {
        if (lastAccrualAt == block.timestamp) return;
        accruedYield += _pendingYield();
        lastAccrualAt = uint64(block.timestamp);
    }

    function _pendingYield() internal view returns (uint256) {
        if (lastAccrualAt == block.timestamp || principal == 0 || apyBps == 0) return 0;
        uint256 elapsed = block.timestamp - lastAccrualAt;
        return (principal * apyBps * elapsed) / (BPS_DENOMINATOR * SECONDS_PER_YEAR);
    }
}
