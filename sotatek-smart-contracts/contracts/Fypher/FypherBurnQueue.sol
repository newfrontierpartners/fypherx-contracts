// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "../interfaces/ISettingManagement.sol";

interface IRUSDBurnable {
    function burnFrom(address account, uint256 amount) external;
}

/**
 * @title FypherBurnQueue
 * @notice Phase 1 burn flow: user burns RUSD immediately, claims collateral
 *         after a fixed 7-day UTC delay. Tickets are tracked by uint256
 *         sequence id (DB-only ticket model — see ADR-002).
 *
 *         Burn flow per PHASE1_SPEC §3.1 (mermaid):
 *           U[User RUSD] --|burn 요청|--> B[Burn contract: RUSD 즉시 소각]
 *           B --|ticket|--> Q[7-day countdown]
 *           Q --|7일 경과 + claim|--> W[User wallet: USDT/USDC/ETH]
 *
 *         Cancellation is intentionally NOT supported in v1: RUSD is
 *         minter-singleton, so re-mint after cancel would require either
 *         an upgrade or routing through FypherMinting. The 7-day window
 *         is the user's commitment. For ops remediation use
 *         {emergencyReverse} (multisig only).
 *
 * @dev Upgradeable (TransparentProxy). Deployed by S1.9 deploy script.
 *      Tracked decisions: ADR-001 (UTC 7d gate), ADR-002 (DB-only ticket),
 *      ADR-008 (per-asset pause).
 */
contract FypherBurnQueue is Initializable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    // ── Constants ──
    /// @notice On-chain enforced burn-to-claim delay (UTC seconds). ADR-001.
    uint64 public constant BURN_DELAY_SECONDS = 7 days;

    // ── EIP-712 (FYP-07 patch) ──
    /// @notice EIP-712 type-hash for the BurnQuote struct. Binding
    ///         this into the signed digest gives every signature an
    ///         action discriminator so a burn-signed quote can never
    ///         be replayed as a settle/redeem quote in
    ///         FyusdEpochSettlement / FyusdEpochRedemption (which use
    ///         their own typehashes).
    bytes32 public constant BURN_TYPEHASH = keccak256(
        "BurnQuote(address user,address collateralAsset,uint256 rusdAmount,uint256 collateralAmount,uint256 nonce,uint256 expiry)"
    );

    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant DOMAIN_NAME_HASH = keccak256(bytes("FypherBurnQueue"));
    bytes32 private constant DOMAIN_VERSION_HASH = keccak256(bytes("1"));

    // ── Types ──

    /// @notice Backend-signed quote. The signing scope binds (user, asset,
    ///         amounts, nonce, expiry) so the user cannot front-run with a
    ///         different asset/amount than the backend approved.
    struct BurnQuote {
        address user;
        address collateralAsset;
        uint256 rusdAmount;
        uint256 collateralAmount;
        uint256 nonce;     // per-user, replay-protected
        uint256 expiry;    // UTC seconds
    }

    /// @notice On-chain record per burn ticket. id = sequence (1-indexed).
    struct Ticket {
        address user;
        address collateralAsset;
        uint256 rusdAmount;
        uint256 collateralAmount;
        uint64  requestedAt;
        bool    claimed;
    }

    // ── Storage ──

    ISettingManagement public settingManagement;
    IRUSDBurnable      public rusd;
    address            public backendSigner;

    /// @notice 1-indexed sequence; 0 is the sentinel "no ticket".
    uint256 public nextTicketId;

    mapping(uint256 => Ticket) public tickets;
    mapping(address => uint256[]) private _userTickets;
    mapping(address => bool) public supportedAssets;

    /// @notice ADR-008 per-asset burn pause. `burnPaused[asset] = true`
    ///         blocks new {requestBurn} for that asset; existing tickets
    ///         remain claimable so users are not locked out post-burn.
    mapping(address => bool) public burnPaused;

    /// @notice Replay protection: (user, nonce) consumed.
    mapping(address => mapping(uint256 => bool)) private _usedNonces;

    /// @notice Per-asset committed liability (sum of unclaimed
    ///         collateralAmount). Lets ops know how much collateral the
    ///         vault must hold for outstanding tickets.
    mapping(address => uint256) public outstandingLiability;

    // ── Storage append (FYP-24 patch — APPEND-ONLY for proxy safety) ──
    /**
     * @notice ADR-007 §"Pauser carve-out". Latency-critical role that
     *         can only call {setBurnPaused(asset, true)} (the
     *         {pauseRole} can pause but not unpause; unpausing is
     *         admin-only). Empty by default — admin must call
     *         {setPauserRole} after deploy, typically pointing at
     *         the {FypherCircuitBreaker} so its watchdog-triggered
     *         {trip} flow can halt burn intake without waiting on
     *         multisig.
     *
     * @dev Before this slot existed, {FypherBurnQueue.setBurnPaused}
     *      was {onlyAdmin}, so the breaker could not pause burn
     *      requests even though its NatSpec listed BurnQueue as a
     *      target (FYP-24). The fix mirrors the pauserRole pattern
     *      already used by FypherMinting, FypherStakingHub, and the
     *      epoch contracts.
     */
    address public pauserRole;

    // ── Events ──

    event BurnRequested(
        address indexed user,
        uint256 indexed ticketId,
        address indexed collateralAsset,
        uint256 rusdAmount,
        uint256 collateralAmount,
        uint64  requestedAt,
        uint64  claimableAt
    );
    event BurnClaimed(
        address indexed user,
        uint256 indexed ticketId,
        address indexed collateralAsset,
        uint256 collateralAmount
    );
    event EmergencyReverse(
        address indexed admin,
        uint256 indexed ticketId,
        address indexed remediation,
        address collateralAsset,
        uint256 collateralAmount,
        bytes32 reasonHash
    );
    event ToppedUp(address indexed asset, address indexed from, uint256 amount);
    event CollateralAssetSet(address indexed asset, bool supported);
    event BurnPausedSet(address indexed asset, bool paused);
    event BackendSignerUpdated(address indexed oldSigner, address indexed newSigner);
    event PauserRoleUpdated(address indexed oldPauser, address indexed newPauser);
    event SurplusSwept(address indexed asset, address indexed to, uint256 amount);

    // ── Errors ──

    error NotAdmin();
    error NotPauserOrAdmin();
    error ZeroAddress();
    error ZeroAmount();
    error UnsupportedAsset();
    error BurnPausedForAsset();
    error ExpiredQuote();
    error NonceAlreadyUsed();
    error InvalidSignature();
    error InvalidTicket();
    error EarlyClaim(uint64 claimableAt);
    error AlreadyClaimed();
    error InsufficientLiquidity();
    error UserBlacklisted();
    /// @notice FYP-31: requested sweep would dip below the contract's
    ///         outstanding liability for that asset.
    error WouldUnderfundLiability(uint256 surplus, uint256 requested);

    // ── Init ──

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        ISettingManagement _settingManagement,
        IRUSDBurnable _rusd,
        address _backendSigner
    ) external initializer {
        if (address(_settingManagement) == address(0)) revert ZeroAddress();
        if (address(_rusd) == address(0)) revert ZeroAddress();
        if (_backendSigner == address(0)) revert ZeroAddress();
        __ReentrancyGuard_init();
        settingManagement = _settingManagement;
        rusd = _rusd;
        backendSigner = _backendSigner;
    }

    // ── Modifiers ──

    modifier onlyAdmin() {
        if (!settingManagement.hasRole(bytes32(0), msg.sender)) revert NotAdmin();
        _;
    }

    /// @notice FYP-24 patch. pauser EOA OR admin (multisig) can pause.
    ///         Unpause requires admin only — enforced inside
    ///         {setBurnPaused}.
    modifier onlyPauserOrAdmin() {
        if (msg.sender != pauserRole && !settingManagement.hasRole(bytes32(0), msg.sender)) {
            revert NotPauserOrAdmin();
        }
        _;
    }

    // ── Core: Burn request ──

    /**
     * @notice Burn `quote.rusdAmount` RUSD from `quote.user` immediately
     *         (RUSD `burnFrom` requires approval) and issue a ticket entitling
     *         the user to `quote.collateralAmount` of `quote.collateralAsset`
     *         after BURN_DELAY_SECONDS.
     *
     *         The quote is signed by `backendSigner` (EIP-191 personal_sign,
     *         matching the existing FypherMinting flow). The backend sets the
     *         quote's price at request time; the user accepts that price for
     *         the 7-day window.
     *
     *         Anyone can submit on behalf of the user (provided they have the
     *         signed quote and the user has approved RUSD), enabling
     *         meta-transaction style flows. The RUSD is always burned from
     *         `quote.user`.
     */
    function requestBurn(BurnQuote calldata quote, bytes calldata signature)
        external
        nonReentrant
        returns (uint256 ticketId)
    {
        if (quote.user == address(0)) revert ZeroAddress();
        if (quote.rusdAmount == 0 || quote.collateralAmount == 0) revert ZeroAmount();
        if (!supportedAssets[quote.collateralAsset]) revert UnsupportedAsset();
        if (burnPaused[quote.collateralAsset]) revert BurnPausedForAsset();
        if (block.timestamp > quote.expiry) revert ExpiredQuote();
        if (settingManagement.isBlacklisted(quote.user)) revert UserBlacklisted();
        if (_usedNonces[quote.user][quote.nonce]) revert NonceAlreadyUsed();

        _verifyQuote(quote, signature);
        _usedNonces[quote.user][quote.nonce] = true;

        // Burn RUSD immediately. burnFrom requires the user to have approved
        // this contract for at least quote.rusdAmount.
        rusd.burnFrom(quote.user, quote.rusdAmount);

        // Allocate ticket (1-indexed).
        unchecked {
            ticketId = ++nextTicketId;
        }

        uint64 requestedAt = uint64(block.timestamp);
        tickets[ticketId] = Ticket({
            user: quote.user,
            collateralAsset: quote.collateralAsset,
            rusdAmount: quote.rusdAmount,
            collateralAmount: quote.collateralAmount,
            requestedAt: requestedAt,
            claimed: false
        });
        _userTickets[quote.user].push(ticketId);
        outstandingLiability[quote.collateralAsset] += quote.collateralAmount;

        emit BurnRequested(
            quote.user,
            ticketId,
            quote.collateralAsset,
            quote.rusdAmount,
            quote.collateralAmount,
            requestedAt,
            requestedAt + BURN_DELAY_SECONDS
        );
    }

    // ── Core: Claim ──

    /**
     * @notice Claim collateral for a ticket. Permissionless: anyone can
     *         submit (the collateral always goes to the original `user`).
     *         Reverts before the 7-day delay elapses.
     */
    function claim(uint256 ticketId) external nonReentrant {
        Ticket storage t = tickets[ticketId];
        if (t.user == address(0)) revert InvalidTicket();
        if (t.claimed) revert AlreadyClaimed();

        uint64 claimableAt = t.requestedAt + BURN_DELAY_SECONDS;
        if (block.timestamp < claimableAt) revert EarlyClaim(claimableAt);

        // Liquidity check is informational; safeTransfer will revert anyway
        // but a typed error is more debuggable.
        uint256 bal = IERC20(t.collateralAsset).balanceOf(address(this));
        if (bal < t.collateralAmount) revert InsufficientLiquidity();

        t.claimed = true;
        outstandingLiability[t.collateralAsset] -= t.collateralAmount;

        IERC20(t.collateralAsset).safeTransfer(t.user, t.collateralAmount);

        emit BurnClaimed(t.user, ticketId, t.collateralAsset, t.collateralAmount);
    }

    // ── Admin ──

    /**
     * @notice Top up the queue's collateral balance from the caller. Used by
     *         ops to settle pending tickets (typically funded from
     *         `FypherMinting` custodian or `ReservePool`).
     *
     *         No access control — anyone can donate liquidity. The
     *         `outstandingLiability` mapping tracks what is owed; any
     *         surplus above that is swept by admin via {sweepSurplus}
     *         (FYP-31). {emergencyReverse} is NOT a surplus-sweep path —
     *         it bookkeeps the liability counter down ticket-by-ticket.
     */
    function topUp(address asset, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        emit ToppedUp(asset, msg.sender, amount);
    }

    /**
     * @notice Sweep collateral held in excess of the contract's
     *         outstanding ticket liability for `asset` to `to`.
     *         Admin-only. Reverts if the requested amount would dip
     *         the contract's balance below {outstandingLiability}.
     *
     * @dev FYP-31 patch. Surplus accumulates when the contract is
     *      overfunded through {topUp} (ops over-tops to be safe)
     *      or when users send the collateral asset directly to the
     *      contract address by mistake. Before this entry point the
     *      surplus could only be reclaimed by an upgrade or by
     *      walking it through {emergencyReverse} ticket-by-ticket,
     *      both of which CertiK flagged as awkward; the comment in
     *      {topUp} also incorrectly claimed {emergencyReverse} was
     *      the sweep path even though that function bookkeeps the
     *      liability counter down.
     */
    function sweepSurplus(address asset, address to, uint256 amount)
        external
        onlyAdmin
        nonReentrant
    {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 bal = IERC20(asset).balanceOf(address(this));
        uint256 liability = outstandingLiability[asset];
        uint256 surplus = bal > liability ? bal - liability : 0;
        if (surplus < amount) revert WouldUnderfundLiability(surplus, amount);
        IERC20(asset).safeTransfer(to, amount);
        emit SurplusSwept(asset, to, amount);
    }

    /**
     * @notice Multisig escape: cancel a ticket without claim. Sends the
     *         locked collateral somewhere else (typically back to
     *         FypherMinting or ReservePool). Does NOT re-mint RUSD — that
     *         must be done out-of-band via FypherMinting if the user is to
     *         be made whole.
     *
     *         `reasonHash` is a free-form hash committing to a written
     *         off-chain justification (audit ledger).
     */
    function emergencyReverse(uint256 ticketId, address remediation, bytes32 reasonHash)
        external
        onlyAdmin
        nonReentrant
    {
        if (remediation == address(0)) revert ZeroAddress();
        Ticket storage t = tickets[ticketId];
        if (t.user == address(0)) revert InvalidTicket();
        if (t.claimed) revert AlreadyClaimed();

        t.claimed = true;
        outstandingLiability[t.collateralAsset] -= t.collateralAmount;

        IERC20(t.collateralAsset).safeTransfer(remediation, t.collateralAmount);

        emit EmergencyReverse(
            msg.sender,
            ticketId,
            remediation,
            t.collateralAsset,
            t.collateralAmount,
            reasonHash
        );
    }

    function setSupportedAsset(address asset, bool supported) external onlyAdmin {
        if (asset == address(0)) revert ZeroAddress();
        // FYP-39: skip the SSTORE + event when the value is unchanged.
        if (supportedAssets[asset] == supported) return;
        supportedAssets[asset] = supported;
        emit CollateralAssetSet(asset, supported);
    }

    /**
     * @notice Per-asset burn pause. Mirrors the
     *         {FypherMinting.setMintPaused} authorisation pattern:
     *         pauser OR admin can PAUSE, but only admin can UNPAUSE
     *         (ADR-007 asymmetric authorisation — default to "stop"
     *         under operational uncertainty).
     *
     * @dev FYP-24 patch. Pre-patch this function was {onlyAdmin}, so
     *      {FypherCircuitBreaker.trip} could not pause this contract
     *      even though the breaker's NatSpec listed BurnQueue as a
     *      target — every {trip} that hit a BurnQueue subcall reverted
     *      with NotAdmin. The watchdog can now pause without waiting
     *      on multisig.
     */
    function setBurnPaused(address asset, bool paused) external onlyPauserOrAdmin {
        if (!paused) {
            // Unpause requires admin (multisig) only.
            if (!settingManagement.hasRole(bytes32(0), msg.sender)) revert NotAdmin();
        }
        if (burnPaused[asset] == paused) return;
        burnPaused[asset] = paused;
        emit BurnPausedSet(asset, paused);
    }

    function setBackendSigner(address newSigner) external onlyAdmin {
        if (newSigner == address(0)) revert ZeroAddress();
        if (newSigner == backendSigner) return;
        emit BackendSignerUpdated(backendSigner, newSigner);
        backendSigner = newSigner;
    }

    /**
     * @notice Set the pauser role. Typically the FypherCircuitBreaker
     *         address so its trip flow can pause burn intake on a
     *         watchdog signal. FYP-24 patch.
     */
    function setPauserRole(address newPauser) external onlyAdmin {
        // FYP-25: reject zero pauser.
        if (newPauser == address(0)) revert ZeroAddress();
        if (newPauser == pauserRole) return;
        emit PauserRoleUpdated(pauserRole, newPauser);
        pauserRole = newPauser;
    }

    // ── View ──

    function isClaimable(uint256 ticketId) external view returns (bool) {
        Ticket storage t = tickets[ticketId];
        if (t.user == address(0) || t.claimed) return false;
        return block.timestamp >= uint256(t.requestedAt) + BURN_DELAY_SECONDS;
    }

    function ticketsOf(address user) external view returns (uint256[] memory) {
        return _userTickets[user];
    }

    function ticketCountOf(address user) external view returns (uint256) {
        return _userTickets[user].length;
    }

    /**
     * @notice Paginated view of a user's ticket history.
     * @dev FYP-50 patch. {ticketsOf} returns the entire array, which
     *      can exceed RPC response limits for active retail users.
     *      This pagination view lets the frontend / indexer fetch
     *      ticket history in fixed-size slices. The caller-supplied
     *      `offset` and `limit` bound iteration on-chain; values
     *      past the array end yield an empty slice rather than a
     *      revert so dashboards do not need a pre-flight length
     *      check.
     */
    function ticketsOfPage(address user, uint256 offset, uint256 limit)
        external view returns (uint256[] memory page)
    {
        uint256[] storage all = _userTickets[user];
        uint256 total = all.length;
        if (offset >= total) return new uint256[](0);
        uint256 end = offset + limit;
        if (end > total) end = total;
        page = new uint256[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            page[i - offset] = all[i];
        }
    }

    function isNonceUsed(address user, uint256 nonce) external view returns (bool) {
        return _usedNonces[user][nonce];
    }

    /**
     * @notice EIP-712 struct hash for a BurnQuote — the inner hash that
     *         is wrapped by the domain separator inside {digest}.
     *
     * @dev FYP-07 patch. The previous hash was a plain
     *      `keccak256(abi.encode(quote.fields))` without any
     *      contract / chainId binding, so the same signature could be
     *      replayed across:
     *      (a) sibling chains where this contract is also deployed
     *          under the same backendSigner,
     *      (b) any future redeployment / proxy reset on the same
     *          chain,
     *      (c) potentially against FyusdEpochSettlement /
     *          FyusdEpochRedemption if their pre-patch field layouts
     *          collided.
     *      Including BURN_TYPEHASH gives the signature an action
     *      discriminator; wrapping it in {_domainSeparatorV4} inside
     *      {digest} closes the chain/contract leg.
     */
    function hashQuote(BurnQuote calldata quote) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                BURN_TYPEHASH,
                quote.user,
                quote.collateralAsset,
                quote.rusdAmount,
                quote.collateralAmount,
                quote.nonce,
                quote.expiry
            )
        );
    }

    /**
     * @notice The full EIP-712 digest that {backendSigner} must produce
     *         (and that {_verifyQuote} authenticates against). Backend
     *         signing code should switch from the legacy
     *         `personal_sign(hashQuote)` to signing this exact digest.
     */
    function digest(BurnQuote calldata quote) external view returns (bytes32) {
        return _digestFromStruct(hashQuote(quote));
    }

    /// @notice Live EIP-712 domain separator, recomputed per call so
    ///         the chainId always reflects the current execution
    ///         context.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ── Internal ──

    function _verifyQuote(BurnQuote calldata quote, bytes calldata signature) internal view {
        bytes32 d = _digestFromStruct(hashQuote(quote));
        address recovered = d.recover(signature);
        if (recovered != backendSigner) revert InvalidSignature();
    }

    function _domainSeparatorV4() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                DOMAIN_NAME_HASH,
                DOMAIN_VERSION_HASH,
                block.chainid,
                address(this)
            )
        );
    }

    function _digestFromStruct(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(hex"19_01", _domainSeparatorV4(), structHash)
        );
    }
}
