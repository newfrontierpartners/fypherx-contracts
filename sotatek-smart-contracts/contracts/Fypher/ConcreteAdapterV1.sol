// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./IConcreteAdapter.sol";

/**
 * @title ConcreteAdapterV1
 * @notice Ethereum mainnet binding to the Concrete (concrete.xyz)
 *         protocol. Per ADR-006 this is a stub at S1.5 — the actual
 *         protocol contract address + ABI is sourced at mainnet
 *         readiness. The point of having the file land at S1.5 is:
 *
 *           1. The interface is locked (see {IConcreteAdapter}).
 *           2. The vault wiring path is exercised by tests against
 *              {MockConcreteAdapter} on BSC; swapping to this adapter
 *              on mainnet is purely a deploy-script concern.
 *
 *         All methods revert {NotImplemented} so accidental BSC-Testnet
 *         deployment of this stub is fail-loud. Implementation lands in
 *         a follow-up PR coordinated with Concrete protocol metadata.
 */
contract ConcreteAdapterV1 is IConcreteAdapter {
    IERC20 public immutable fyusd;
    /// @notice Address of the live Concrete vault on the target network.
    ///         Constructor-set; immutable. Implementation-time integration
    ///         maps the IConcreteAdapter calls to the actual Concrete
    ///         contract methods (deposit / withdraw / preview*).
    address public immutable concretePool;

    error NotImplemented();

    constructor(IERC20 _fyusd, address _concretePool) {
        fyusd = _fyusd;
        concretePool = _concretePool;
    }

    function asset() external view returns (address) {
        return address(fyusd);
    }

    function totalAssets() external pure returns (uint256) {
        revert NotImplemented();
    }

    function shareOf(address) external pure returns (uint256) {
        revert NotImplemented();
    }

    function realizedYield7d() external pure returns (uint256) {
        revert NotImplemented();
    }

    function deposit(uint256) external pure returns (uint256) {
        revert NotImplemented();
    }

    function withdraw(uint256) external pure returns (uint256) {
        revert NotImplemented();
    }
}
