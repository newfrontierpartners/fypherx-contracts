// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20BurnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @title FYUSD
 * @notice FYUSD token — underlying asset for the stAUSD vault.
 *
 * @dev Upgradeable (TransparentProxy). Deployed at: 0x9FC6C8eAeB305BE708b957d7cfF7E424D6F2bEd9
 */
contract FYUSD is
    Initializable,
    ERC20Upgradeable,
    ERC20BurnableUpgradeable,
    ERC20PermitUpgradeable,
    OwnableUpgradeable
{
    address private _minter;

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
        __ERC20_init("FYUSD", "FYUSD");
        __ERC20Burnable_init();
        __ERC20Permit_init("FYUSD");
        __Ownable_init(owner_);
    }

    function minter() external view returns (address) {
        return _minter;
    }

    function setMinter(address newMinter) external onlyOwner {
        if (newMinter == address(0)) revert ZeroAddress();
        _minter = newMinter;
    }

    function mint(address to, uint256 amount) external onlyMinter {
        _mint(to, amount);
    }
}
