// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.19;

/// @title EventsLib
/// @notice Canonical event signatures emitted by the Fypher lending market.
/// @dev Kept in a single library so off-chain indexers (backend `Lending*ChainReader`)
///      and on-chain code share a single source of truth for topics.
library EventsLib {
    /* LIFECYCLE */
    event MarketInitialized(
        address indexed loanToken,
        address indexed collateralToken,
        address oracle,
        address irm,
        uint256 lltvBps,
        uint256 liquidationBonusBps
    );
    event PausedSet(bool paused);
    event ParameterUpdated(bytes32 indexed key, uint256 oldValue, uint256 newValue);
    event InsuranceFundSet(address oldFund, address newFund);

    /* INTEREST */
    event AccrueInterest(uint256 prevBorrowRate, uint256 interestAssets, uint256 reserveShares);

    /* SUPPLY / WITHDRAW */
    event Supply(address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares);
    event Withdraw(address indexed caller, address indexed onBehalf, address indexed to, uint256 assets, uint256 shares);

    /* COLLATERAL */
    event SupplyCollateral(address indexed caller, address indexed onBehalf, uint256 assets);
    event WithdrawCollateral(address indexed caller, address indexed onBehalf, address indexed to, uint256 assets);

    /* BORROW / REPAY */
    event Borrow(address indexed caller, address indexed onBehalf, address indexed to, uint256 assets, uint256 shares);
    event Repay(address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares);

    /* LIQUIDATION */
    event Liquidate(
        address indexed liquidator,
        address indexed borrower,
        uint256 repaidAssets,
        uint256 repaidShares,
        uint256 seizedCollateral,
        uint256 badDebtCovered,
        uint256 badDebtSocialised
    );

    /* RESERVES */
    event ReservesSkimmed(address indexed fund, uint256 skimmed);
}
