// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IFyusdMintBurn {
    function mint(address to, uint256 amount) external;
    function burnFrom(address account, uint256 amount) external;
    function decimals() external view returns (uint8);
}

/**
 * @title FyusdTeller
 * @notice Fully on-chain, 1:1 FYUSD issuance desk for the GIWA environment.
 *
 * @dev WHY THIS EXISTS
 *      ─────────────────
 *      On Ethereum mainnet, FYUSD is issued through BitGo custody and
 *      settled by {FyusdEpochSettlement}; on HOODI it is issued by a
 *      backend keeper. Neither path exists on GIWA — BitGo does not
 *      support the chain — so the GIWA environment needs a mint path that
 *      depends on nothing but the chain itself.
 *
 *      This teller is that path. A user approves a supported stablecoin
 *      and calls {mint}; the teller escrows the stablecoin 1:1 and mints
 *      FYUSD. {redeem} is the exact inverse: burn FYUSD, release the
 *      escrowed stablecoin. Reserves are therefore always fully backed by
 *      construction — {reserveOf} is auditable on the block explorer and
 *      no operator action sits between a user and their funds.
 *
 *      SCOPE: GIWA testnet only. This contract is NOT part of the CertiK
 *      alpha audit scope and is never deployed to Ethereum mainnet, where
 *      the custodial issuance path is the real one. It lives under
 *      contracts/giwa/ precisely so that boundary stays legible.
 *
 *      DECIMALS: supported stables are 6-decimal (USDT/USDC-shaped) while
 *      FYUSD is 18-decimal. The teller normalises both directions and
 *      rejects any amount that would round to zero, so a user can never
 *      burn value into a rounding gap.
 *
 *      FEES: none. The GIWA environment demonstrates the money path, not
 *      the fee model; adding a spread here would make the 1:1 reserve
 *      invariant harder to verify from the explorer alone.
 */
contract FyusdTeller is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The FYUSD token this teller issues. Immutable — a teller is
    ///         bound to exactly one token so {reserveOf} can never drift
    ///         from the supply it backs.
    IFyusdMintBurn public immutable fyusd;

    /// @dev Cached at construction: FYUSD's own decimals, used for scaling.
    uint8 public immutable fyusdDecimals;

    /// @notice Stablecoins this teller accepts, keyed by token address.
    mapping(address => bool) public supported;

    /// @notice Stablecoin escrowed per token. Backs outstanding FYUSD 1:1
    ///         (in normalised units). Tracked explicitly rather than read
    ///         from balanceOf so a stray airdrop cannot be redeemed.
    mapping(address => uint256) public reserveOf;

    event SupportedAssetUpdated(address indexed asset, bool supported);
    event Minted(address indexed user, address indexed asset, uint256 assetAmount, uint256 fyusdAmount);
    event Redeemed(address indexed user, address indexed asset, uint256 fyusdAmount, uint256 assetAmount);
    event SurplusSwept(address indexed asset, address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error UnsupportedAsset(address asset);
    error DustAmount();
    error InsufficientReserve(address asset, uint256 requested, uint256 available);
    error DecimalsTooLarge(uint8 decimals);

    constructor(address fyusd_, address owner_) Ownable(owner_) {
        if (fyusd_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        fyusd = IFyusdMintBurn(fyusd_);
        fyusdDecimals = IFyusdMintBurn(fyusd_).decimals();
    }

    // ── Admin ────────────────────────────────────────────────────────────

    /**
     * @notice Add or remove an accepted stablecoin.
     * @dev Removing an asset does NOT strand its reserve: {redeem} stays
     *      open for already-issued FYUSD, only {mint} is closed. That
     *      ordering matters — the opposite would let governance trap user
     *      funds behind a config flag.
     */
    function setSupportedAsset(address asset, bool isSupported) external onlyOwner {
        if (asset == address(0)) revert ZeroAddress();
        if (isSupported) {
            // Scaling maths below assumes the stable is no finer-grained
            // than FYUSD. Reject at registration rather than at mint time.
            uint8 d = IERC20Metadata(asset).decimals();
            if (d > fyusdDecimals) revert DecimalsTooLarge(d);
        }
        supported[asset] = isSupported;
        emit SupportedAssetUpdated(asset, isSupported);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    /**
     * @notice Sweep tokens sent to this contract outside {mint} — airdrops,
     *         fat-fingered transfers, a stable that was later delisted.
     * @dev Can only move the balance ABOVE {reserveOf}, so user backing is
     *      unreachable by the owner even when paused. This is the whole
     *      reason reserves are tracked in storage instead of via balanceOf.
     */
    function sweepSurplus(address asset, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = IERC20(asset).balanceOf(address(this));
        uint256 reserved = reserveOf[asset];
        if (balance <= reserved) revert ZeroAmount();
        uint256 surplus = balance - reserved;
        IERC20(asset).safeTransfer(to, surplus);
        emit SurplusSwept(asset, to, surplus);
    }

    // ── User ─────────────────────────────────────────────────────────────

    /**
     * @notice Deposit `assetAmount` of `asset` and receive the equivalent
     *         FYUSD 1:1. Caller must have approved this contract first.
     */
    function mint(address asset, uint256 assetAmount)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 fyusdAmount)
    {
        if (!supported[asset]) revert UnsupportedAsset(asset);
        if (assetAmount == 0) revert ZeroAmount();

        // Pull first, then measure: a fee-on-transfer token would otherwise
        // let a user mint FYUSD against stablecoin that never arrived.
        uint256 before = IERC20(asset).balanceOf(address(this));
        IERC20(asset).safeTransferFrom(msg.sender, address(this), assetAmount);
        uint256 received = IERC20(asset).balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();

        fyusdAmount = received * _scale(asset);
        reserveOf[asset] += received;

        fyusd.mint(msg.sender, fyusdAmount);
        emit Minted(msg.sender, asset, received, fyusdAmount);
    }

    /**
     * @notice Burn `fyusdAmount` of FYUSD and receive `asset` 1:1. Caller
     *         must have approved this contract to burn their FYUSD.
     */
    function redeem(address asset, uint256 fyusdAmount)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 assetAmount)
    {
        if (fyusdAmount == 0) revert ZeroAmount();

        uint256 scale = _scale(asset);
        assetAmount = fyusdAmount / scale;
        // Anything under one base unit of the stable would burn FYUSD for
        // nothing. Refuse instead of silently keeping the dust.
        if (assetAmount == 0) revert DustAmount();
        // Only redeem what the escrow can actually cover, and normalise the
        // burn to the payout so the two sides stay exactly 1:1.
        uint256 available = reserveOf[asset];
        if (assetAmount > available) revert InsufficientReserve(asset, assetAmount, available);

        uint256 burnAmount = assetAmount * scale;
        reserveOf[asset] = available - assetAmount;

        fyusd.burnFrom(msg.sender, burnAmount);
        IERC20(asset).safeTransfer(msg.sender, assetAmount);
        emit Redeemed(msg.sender, asset, burnAmount, assetAmount);
    }

    // ── Views ────────────────────────────────────────────────────────────

    /// @notice FYUSD minted for `assetAmount` of `asset`, before any transfer.
    function previewMint(address asset, uint256 assetAmount) external view returns (uint256) {
        return assetAmount * _scale(asset);
    }

    /// @notice `asset` paid out for `fyusdAmount`, truncated to base units.
    function previewRedeem(address asset, uint256 fyusdAmount) external view returns (uint256) {
        return fyusdAmount / _scale(asset);
    }

    /// @dev 10 ** (fyusdDecimals - assetDecimals). Registration rejects any
    ///      asset with more decimals than FYUSD, so this never underflows
    ///      for a supported asset.
    function _scale(address asset) internal view returns (uint256) {
        uint8 d = IERC20Metadata(asset).decimals();
        if (d > fyusdDecimals) revert DecimalsTooLarge(d);
        return 10 ** uint256(fyusdDecimals - d);
    }
}
