// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.19;

/// @title IInsuranceFund
/// @notice Two-way interface between the lending market and a shared insurance fund.
///         - `onReservesReceived` is called AFTER the market transfers skimmed reserves in.
///         - `coverBadDebt` is called BEFORE the market socialises bad debt; the fund
///           pushes up to `amount` of `loanToken` back to the caller and returns the
///           actual amount covered (0 if underfunded).
/// @dev Only whitelisted markets should be allowed to call `coverBadDebt`; see
///      `InsuranceFundV2` for the access-control implementation.
interface IInsuranceFund {
    function onReservesReceived(address loanToken, uint256 amount) external;
    function coverBadDebt(address loanToken, uint256 amount) external returns (uint256 covered);
}
