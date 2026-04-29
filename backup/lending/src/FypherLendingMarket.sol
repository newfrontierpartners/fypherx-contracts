// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.19;

/*
 * Core accounting (accrue interest, supply/borrow share math, liquidation math) is
 * derived from Morpho Blue (https://github.com/morpho-org/morpho-blue), licensed
 * GPL-2.0-or-later. Adaptations for Fypher:
 *   - Per-market contract (Morpho is a multi-market singleton).
 *   - BPS-denominated parameters (lltvBps, liquidationBonusBps, reserveFactorBps)
 *     to match the Fypher admin/governance surface.
 *   - Supply/borrow caps.
 *   - Reserve factor accumulates supplier shares owned by the market itself,
 *     skimmable to a shared InsuranceFund.
 *   - Bad debt is first offered to the InsuranceFund; any uncovered residual is
 *     socialised by writing down totalSupplyAssets (Morpho's original behaviour).
 *   - Timelock-gated governance (no signature authorisations).
 */

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IFypherLendingMarket} from "./interfaces/IFypherLendingMarket.sol";
import {IIrm} from "./interfaces/IIrm.sol";
import {IOracle} from "./interfaces/IOracle.sol";
import {IInsuranceFund} from "./interfaces/IInsuranceFund.sol";

import {MathLib, WAD} from "./libraries/MathLib.sol";
import {SharesMathLib} from "./libraries/SharesMathLib.sol";
import {UtilsLib} from "./libraries/UtilsLib.sol";
import {ErrorsLib} from "./libraries/ErrorsLib.sol";
import {EventsLib} from "./libraries/EventsLib.sol";

/// @title FypherLendingMarket
/// @notice Single-pair isolated lending market: one loan token, one collateral token.
/// @dev Deployed by `FypherLendingMarketFactory` from inside a timelocked governance batch.
contract FypherLendingMarket is IFypherLendingMarket, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using MathLib for uint256;
    using SharesMathLib for uint256;
    using UtilsLib for uint256;

    /* ------------------------------------------------------------------ */
    /*                               CONSTANTS                            */
    /* ------------------------------------------------------------------ */

    uint256 internal constant BPS = 10_000;
    uint256 internal constant ORACLE_PRICE_SCALE = 1e36;
    uint256 internal constant MAX_LLTV_BPS = 9_500;               // 95%
    uint256 internal constant MAX_LIQ_BONUS_BPS = 2_000;          // 20%
    uint256 internal constant MAX_RESERVE_FACTOR_BPS = 2_500;     // 25%

    /* ------------------------------------------------------------------ */
    /*                               IMMUTABLES                           */
    /* ------------------------------------------------------------------ */

    IERC20 internal immutable _loanToken;
    IERC20 internal immutable _collateralToken;
    IOracle public immutable oracle;
    IIrm public immutable irm;
    uint256 public immutable override lltvBps;
    uint256 public immutable override liquidationBonusBps;

    /* ------------------------------------------------------------------ */
    /*                                STORAGE                             */
    /* ------------------------------------------------------------------ */

    address public timelock;
    address public insuranceFund;
    bool public override paused;

    uint256 public override reserveFactorBps;
    uint256 public override supplyCap;
    uint256 public override borrowCap;

    uint256 public override totalSupplyAssets;
    uint256 public override totalSupplyShares;
    uint256 public override totalBorrowAssets;
    uint256 public override totalBorrowShares;

    /// @dev Supply shares owned by the market itself, representing the accrued reserve.
    ///      Converted to assets on skim.
    uint256 public accumulatedReserveShares;
    uint64  public override lastAccrualTimestamp;

    mapping(address => uint256) public override supplySharesOf;
    mapping(address => uint256) public override borrowSharesOf;
    mapping(address => uint256) public override collateralOf;

    /* ------------------------------------------------------------------ */
    /*                              CONSTRUCTOR                           */
    /* ------------------------------------------------------------------ */

    struct InitParams {
        address loanToken;
        address collateralToken;
        address oracle;
        address irm;
        uint256 lltvBps;
        uint256 liquidationBonusBps;
        uint256 reserveFactorBps;
        uint256 supplyCap;
        uint256 borrowCap;
        address timelock;
        address insuranceFund;
    }

    constructor(InitParams memory p) {
        if (
            p.loanToken == address(0) ||
            p.collateralToken == address(0) ||
            p.oracle == address(0) ||
            p.irm == address(0) ||
            p.timelock == address(0) ||
            p.insuranceFund == address(0)
        ) revert ErrorsLib.ZeroAddress();
        if (p.loanToken == p.collateralToken) revert ErrorsLib.InconsistentInput();
        if (p.lltvBps == 0 || p.lltvBps > MAX_LLTV_BPS) revert ErrorsLib.LltvTooHigh();
        if (p.liquidationBonusBps > MAX_LIQ_BONUS_BPS) revert ErrorsLib.LiquidationBonusTooHigh();
        if (p.reserveFactorBps > MAX_RESERVE_FACTOR_BPS) revert ErrorsLib.ReserveFactorTooHigh();

        _loanToken = IERC20(p.loanToken);
        _collateralToken = IERC20(p.collateralToken);
        oracle = IOracle(p.oracle);
        irm = IIrm(p.irm);
        lltvBps = p.lltvBps;
        liquidationBonusBps = p.liquidationBonusBps;

        reserveFactorBps = p.reserveFactorBps;
        supplyCap = p.supplyCap;
        borrowCap = p.borrowCap;
        timelock = p.timelock;
        insuranceFund = p.insuranceFund;
        lastAccrualTimestamp = uint64(block.timestamp);

        emit EventsLib.MarketInitialized(
            p.loanToken, p.collateralToken, p.oracle, p.irm, p.lltvBps, p.liquidationBonusBps
        );
    }

    /* ------------------------------------------------------------------ */
    /*                               MODIFIERS                            */
    /* ------------------------------------------------------------------ */

    modifier onlyTimelock() {
        if (msg.sender != timelock) revert ErrorsLib.NotTimelock();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert ErrorsLib.Paused();
        _;
    }

    /* ------------------------------------------------------------------ */
    /*                               TOKEN VIEWS                          */
    /* ------------------------------------------------------------------ */

    function loanToken() external view override returns (address) { return address(_loanToken); }
    function collateralToken() external view override returns (address) { return address(_collateralToken); }

    /* ------------------------------------------------------------------ */
    /*                            GOVERNANCE SETTERS                      */
    /* ------------------------------------------------------------------ */

    function setPaused(bool value) external onlyTimelock {
        paused = value;
        emit EventsLib.PausedSet(value);
    }

    function setReserveFactorBps(uint256 value) external onlyTimelock {
        if (value > MAX_RESERVE_FACTOR_BPS) revert ErrorsLib.ReserveFactorTooHigh();
        _accrueInterest();
        emit EventsLib.ParameterUpdated("reserveFactorBps", reserveFactorBps, value);
        reserveFactorBps = value;
    }

    function setSupplyCap(uint256 value) external onlyTimelock {
        emit EventsLib.ParameterUpdated("supplyCap", supplyCap, value);
        supplyCap = value;
    }

    function setBorrowCap(uint256 value) external onlyTimelock {
        emit EventsLib.ParameterUpdated("borrowCap", borrowCap, value);
        borrowCap = value;
    }

    function setInsuranceFund(address value) external onlyTimelock {
        if (value == address(0)) revert ErrorsLib.ZeroAddress();
        emit EventsLib.InsuranceFundSet(insuranceFund, value);
        insuranceFund = value;
    }

    function setTimelock(address value) external onlyTimelock {
        if (value == address(0)) revert ErrorsLib.ZeroAddress();
        timelock = value;
    }

    /* ------------------------------------------------------------------ */
    /*                              SUPPLY / WITHDRAW                     */
    /* ------------------------------------------------------------------ */

    function supply(uint256 assets, address onBehalf)
        external
        override
        nonReentrant
        whenNotPaused
        returns (uint256 shares)
    {
        if (assets == 0) revert ErrorsLib.ZeroAmount();
        if (onBehalf == address(0)) revert ErrorsLib.ZeroAddress();

        _accrueInterest();

        if (supplyCap != 0 && totalSupplyAssets + assets > supplyCap) revert ErrorsLib.SupplyCapExceeded();

        shares = assets.toSharesDown(totalSupplyAssets, totalSupplyShares);
        supplySharesOf[onBehalf] += shares;
        totalSupplyShares += shares;
        totalSupplyAssets += assets;

        _loanToken.safeTransferFrom(msg.sender, address(this), assets);

        emit EventsLib.Supply(msg.sender, onBehalf, assets, shares);
    }

    function withdraw(uint256 shares, address to)
        external
        override
        nonReentrant
        returns (uint256 assets)
    {
        if (shares == 0) revert ErrorsLib.ZeroAmount();
        if (to == address(0)) revert ErrorsLib.ZeroAddress();
        if (supplySharesOf[msg.sender] < shares) revert ErrorsLib.InsufficientShares();

        _accrueInterest();

        assets = shares.toAssetsDown(totalSupplyAssets, totalSupplyShares);

        supplySharesOf[msg.sender] -= shares;
        totalSupplyShares -= shares;
        totalSupplyAssets -= assets;

        if (totalBorrowAssets > totalSupplyAssets) revert ErrorsLib.InsufficientLiquidity();

        _loanToken.safeTransfer(to, assets);

        emit EventsLib.Withdraw(msg.sender, msg.sender, to, assets, shares);
    }

    /* ------------------------------------------------------------------ */
    /*                        COLLATERAL  SUPPLY / WITHDRAW                */
    /* ------------------------------------------------------------------ */

    function supplyCollateral(uint256 assets, address onBehalf) external override nonReentrant whenNotPaused {
        if (assets == 0) revert ErrorsLib.ZeroAmount();
        if (onBehalf == address(0)) revert ErrorsLib.ZeroAddress();

        collateralOf[onBehalf] += assets;
        _collateralToken.safeTransferFrom(msg.sender, address(this), assets);

        emit EventsLib.SupplyCollateral(msg.sender, onBehalf, assets);
    }

    function withdrawCollateral(uint256 assets, address to) external override nonReentrant {
        if (assets == 0) revert ErrorsLib.ZeroAmount();
        if (to == address(0)) revert ErrorsLib.ZeroAddress();
        if (collateralOf[msg.sender] < assets) revert ErrorsLib.InsufficientCollateral();

        _accrueInterest();

        collateralOf[msg.sender] -= assets;

        if (!_isHealthy(msg.sender)) revert ErrorsLib.InsufficientCollateral();

        _collateralToken.safeTransfer(to, assets);

        emit EventsLib.WithdrawCollateral(msg.sender, msg.sender, to, assets);
    }

    /* ------------------------------------------------------------------ */
    /*                              BORROW / REPAY                         */
    /* ------------------------------------------------------------------ */

    function borrow(uint256 assets, address to)
        external
        override
        nonReentrant
        whenNotPaused
        returns (uint256 shares)
    {
        if (assets == 0) revert ErrorsLib.ZeroAmount();
        if (to == address(0)) revert ErrorsLib.ZeroAddress();

        _accrueInterest();

        if (borrowCap != 0 && totalBorrowAssets + assets > borrowCap) revert ErrorsLib.BorrowCapExceeded();

        shares = assets.toSharesUp(totalBorrowAssets, totalBorrowShares);
        borrowSharesOf[msg.sender] += shares;
        totalBorrowShares += shares;
        totalBorrowAssets += assets;

        if (totalBorrowAssets > totalSupplyAssets) revert ErrorsLib.InsufficientLiquidity();
        if (!_isHealthy(msg.sender)) revert ErrorsLib.InsufficientCollateral();

        _loanToken.safeTransfer(to, assets);

        emit EventsLib.Borrow(msg.sender, msg.sender, to, assets, shares);
    }

    function repay(uint256 shares, address onBehalf)
        external
        override
        nonReentrant
        returns (uint256 assets)
    {
        if (shares == 0) revert ErrorsLib.ZeroAmount();
        if (onBehalf == address(0)) revert ErrorsLib.ZeroAddress();
        if (borrowSharesOf[onBehalf] < shares) revert ErrorsLib.InsufficientShares();

        _accrueInterest();

        assets = shares.toAssetsUp(totalBorrowAssets, totalBorrowShares);

        borrowSharesOf[onBehalf] -= shares;
        totalBorrowShares -= shares;
        totalBorrowAssets = totalBorrowAssets.zeroFloorSub(assets);

        _loanToken.safeTransferFrom(msg.sender, address(this), assets);

        emit EventsLib.Repay(msg.sender, onBehalf, assets, shares);
    }

    /* ------------------------------------------------------------------ */
    /*                               LIQUIDATION                           */
    /* ------------------------------------------------------------------ */

    function liquidate(address borrower, uint256 repayAssets)
        external
        override
        nonReentrant
        returns (uint256 seizedCollateral, uint256 badDebtCovered, uint256 badDebtSocialised)
    {
        if (borrower == address(0)) revert ErrorsLib.ZeroAddress();
        if (repayAssets == 0) revert ErrorsLib.ZeroAmount();

        _accrueInterest();

        if (_isHealthy(borrower)) revert ErrorsLib.HealthyPosition();

        uint256 collateralPrice = oracle.price();
        if (collateralPrice == 0) revert ErrorsLib.InconsistentOracle();

        // Cap repay at the borrower's outstanding debt.
        uint256 borrowerDebt = borrowSharesOf[borrower].toAssetsUp(totalBorrowAssets, totalBorrowShares);
        if (repayAssets > borrowerDebt) repayAssets = borrowerDebt;

        uint256 repayShares = repayAssets.toSharesDown(totalBorrowAssets, totalBorrowShares);
        // Re-round assets from shares so we never credit more debt reduction than the
        // liquidator actually pulled.
        uint256 repaidAssets = repayShares.toAssetsUp(totalBorrowAssets, totalBorrowShares);

        // seizedValue (in loan-token units) = repaidAssets * (1 + bonus)
        uint256 seizedValue = (repaidAssets * (BPS + liquidationBonusBps)) / BPS;
        // seized (in collateral-token units) = seizedValue * 1e36 / price
        seizedCollateral = (seizedValue * ORACLE_PRICE_SCALE) / collateralPrice;

        if (seizedCollateral > collateralOf[borrower]) {
            seizedCollateral = collateralOf[borrower];
        }

        collateralOf[borrower] -= seizedCollateral;
        borrowSharesOf[borrower] -= repayShares;
        totalBorrowShares -= repayShares;
        totalBorrowAssets = totalBorrowAssets.zeroFloorSub(repaidAssets);

        // If the borrower is fully liquidated (no collateral left) but still owes,
        // socialise the residual. Try to pull it from the insurance fund first.
        if (collateralOf[borrower] == 0 && borrowSharesOf[borrower] > 0) {
            uint256 badDebtShares = borrowSharesOf[borrower];
            uint256 badDebtAssets = badDebtShares.toAssetsUp(totalBorrowAssets, totalBorrowShares);

            badDebtCovered = IInsuranceFund(insuranceFund).coverBadDebt(address(_loanToken), badDebtAssets);
            if (badDebtCovered > badDebtAssets) badDebtCovered = badDebtAssets;
            badDebtSocialised = badDebtAssets - badDebtCovered;

            borrowSharesOf[borrower] = 0;
            totalBorrowShares -= badDebtShares;
            totalBorrowAssets = totalBorrowAssets.zeroFloorSub(badDebtAssets);

            if (badDebtSocialised > 0) {
                totalSupplyAssets = totalSupplyAssets.zeroFloorSub(badDebtSocialised);
            }
        }

        _loanToken.safeTransferFrom(msg.sender, address(this), repaidAssets);
        _collateralToken.safeTransfer(msg.sender, seizedCollateral);

        emit EventsLib.Liquidate(
            msg.sender, borrower, repaidAssets, repayShares, seizedCollateral, badDebtCovered, badDebtSocialised
        );
    }

    /* ------------------------------------------------------------------ */
    /*                               RESERVES                              */
    /* ------------------------------------------------------------------ */

    function skimReservesToFund() external override nonReentrant returns (uint256 skimmed) {
        _accrueInterest();

        uint256 shares = accumulatedReserveShares;
        if (shares == 0) return 0;

        skimmed = shares.toAssetsDown(totalSupplyAssets, totalSupplyShares);
        accumulatedReserveShares = 0;
        totalSupplyShares -= shares;
        totalSupplyAssets -= skimmed;

        if (totalBorrowAssets > totalSupplyAssets) revert ErrorsLib.InsufficientLiquidity();

        _loanToken.safeTransfer(insuranceFund, skimmed);
        IInsuranceFund(insuranceFund).onReservesReceived(address(_loanToken), skimmed);

        emit EventsLib.ReservesSkimmed(insuranceFund, skimmed);
    }

    function accumulatedReserve() external view override returns (uint256) {
        if (accumulatedReserveShares == 0) return 0;
        return accumulatedReserveShares.toAssetsDown(totalSupplyAssets, totalSupplyShares);
    }

    /* ------------------------------------------------------------------ */
    /*                               USER VIEWS                            */
    /* ------------------------------------------------------------------ */

    function supplyAssetsOf(address user) external view override returns (uint256) {
        return supplySharesOf[user].toAssetsDown(totalSupplyAssets, totalSupplyShares);
    }

    function debtAssetsOf(address user) external view override returns (uint256) {
        return borrowSharesOf[user].toAssetsUp(totalBorrowAssets, totalBorrowShares);
    }

    /// @notice Returns the borrower's health factor scaled by 1e18.
    ///         `>= 1e18` = healthy (collateral × LLTV ≥ debt). `0` means no debt.
    function healthFactor(address user) external view override returns (uint256) {
        uint256 debtAssets = borrowSharesOf[user].toAssetsUp(totalBorrowAssets, totalBorrowShares);
        if (debtAssets == 0) return type(uint256).max;

        uint256 price = oracle.price();
        if (price == 0) return 0;

        uint256 collateralValue = (collateralOf[user] * price) / ORACLE_PRICE_SCALE;
        uint256 maxBorrow = (collateralValue * lltvBps) / BPS;

        return (maxBorrow * WAD) / debtAssets;
    }

    /* ------------------------------------------------------------------ */
    /*                              INTERNAL MATH                          */
    /* ------------------------------------------------------------------ */

    function _accrueInterest() internal {
        uint256 elapsed = block.timestamp - lastAccrualTimestamp;
        if (elapsed == 0) return;

        lastAccrualTimestamp = uint64(block.timestamp);

        if (totalBorrowAssets == 0) return;

        uint256 borrowRate = irm.borrowRate(totalSupplyAssets, totalBorrowAssets);
        uint256 interest = totalBorrowAssets.wMulDown(borrowRate.wTaylorCompounded(elapsed));
        if (interest == 0) return;

        totalBorrowAssets += interest;
        totalSupplyAssets += interest;

        uint256 reserveShares = 0;
        if (reserveFactorBps > 0) {
            uint256 reserveAssets = (interest * reserveFactorBps) / BPS;
            if (reserveAssets > 0) {
                // Mint reserve shares at the *pre-reserve* share price so suppliers are
                // only credited the post-reserve portion of the interest.
                reserveShares = reserveAssets.toSharesDown(totalSupplyAssets - reserveAssets, totalSupplyShares);
                accumulatedReserveShares += reserveShares;
                totalSupplyShares += reserveShares;
            }
        }

        emit EventsLib.AccrueInterest(borrowRate, interest, reserveShares);
    }

    function _isHealthy(address user) internal view returns (bool) {
        uint256 borrowShares = borrowSharesOf[user];
        if (borrowShares == 0) return true;

        uint256 price = oracle.price();
        if (price == 0) revert ErrorsLib.InconsistentOracle();

        uint256 debtAssets = borrowShares.toAssetsUp(totalBorrowAssets, totalBorrowShares);
        uint256 collateralValue = (collateralOf[user] * price) / ORACLE_PRICE_SCALE;
        uint256 maxBorrow = (collateralValue * lltvBps) / BPS;

        return maxBorrow >= debtAssets;
    }
}
