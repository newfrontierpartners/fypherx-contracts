// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.19;

/// @title IFypherLendingMarket
/// @notice External surface of the Fypher per-market lending contract.
/// @dev Matches the ABI consumed by the frontend (`src/lib/defi/contracts/abis/fypherMarket.ts`)
///      and the backend (`LendingMarketChainReader`). Keep in sync if either side changes.
interface IFypherLendingMarket {
    /* WRITES */
    function supply(uint256 assets, address onBehalf) external returns (uint256 shares);
    function withdraw(uint256 shares, address to) external returns (uint256 assets);
    function supplyCollateral(uint256 assets, address onBehalf) external;
    function withdrawCollateral(uint256 assets, address to) external;
    function borrow(uint256 assets, address to) external returns (uint256 shares);
    function repay(uint256 shares, address onBehalf) external returns (uint256 assets);
    function liquidate(address borrower, uint256 repayAssets)
        external
        returns (uint256 seizedCollateral, uint256 badDebtCovered, uint256 badDebtSocialised);
    function skimReservesToFund() external returns (uint256 skimmed);

    /* READS — token + parameters */
    function loanToken() external view returns (address);
    function collateralToken() external view returns (address);
    function lltvBps() external view returns (uint256);
    function liquidationBonusBps() external view returns (uint256);
    function reserveFactorBps() external view returns (uint256);
    function supplyCap() external view returns (uint256);
    function borrowCap() external view returns (uint256);

    /* READS — aggregate state */
    function totalSupplyAssets() external view returns (uint256);
    function totalSupplyShares() external view returns (uint256);
    function totalBorrowAssets() external view returns (uint256);
    function totalBorrowShares() external view returns (uint256);
    function accumulatedReserve() external view returns (uint256);
    function lastAccrualTimestamp() external view returns (uint64);
    function paused() external view returns (bool);

    /* READS — per-user state */
    function supplySharesOf(address user) external view returns (uint256);
    function borrowSharesOf(address user) external view returns (uint256);
    function collateralOf(address user) external view returns (uint256);
    function supplyAssetsOf(address user) external view returns (uint256);
    function debtAssetsOf(address user) external view returns (uint256);
    function healthFactor(address user) external view returns (uint256);
}
