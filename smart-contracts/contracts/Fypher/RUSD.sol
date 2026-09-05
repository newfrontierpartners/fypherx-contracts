// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20BurnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @title RUSD
 * @notice Synthetic stablecoin — the primary unit of the Fypher protocol.
 *         Mintable by a designated minter (FypherMinting contract).
 *
 * @dev Upgradeable (TransparentProxy). Deployed at: 0x43Ce624915C0cCf9389b8db8716f6A3615d7DBF5
 *      Implementation: 0xcF0f6785f5dd858728393371d8fe439aa768b389
 */
contract RUSD is
    Initializable,
    ERC20Upgradeable,
    ERC20BurnableUpgradeable,
    ERC20PermitUpgradeable,
    OwnableUpgradeable
{
    address private _minter;

    event MinterUpdated(address indexed oldMinter, address indexed newMinter);

    error NotMinter();
    error ZeroAddress();

    modifier onlyMinter() {
        if (msg.sender != _minter) revert NotMinter();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_) external initializer {
        __ERC20_init("RUSD", "RUSD");
        __ERC20Burnable_init();
        __ERC20Permit_init("RUSD");
        __Ownable_init(owner_);
    }

    function minter() external view returns (address) {
        return _minter;
    }

    function setMinter(address newMinter) external onlyOwner {
        if (newMinter == address(0)) revert ZeroAddress();
        // FYP-39: skip the SSTORE + event when the value is unchanged.
        if (newMinter == _minter) return;
        emit MinterUpdated(_minter, newMinter);
        _minter = newMinter;
    }

    function mint(address to, uint256 amount) external onlyMinter {
        _mint(to, amount);
    }
}
