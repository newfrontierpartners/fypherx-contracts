// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20BurnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @title InstitutionalRUSD (iRUSD)
 * @notice Institutional-only RUSD token, gatekept by INSTITUTIONAL_ROLE
 *         from SettingManagement. Supports minting by MINTER_ROLE.
 *
 * @dev Deployed at: 0x37B48945Fb8b6607b5386d35b3472c12E8374dfb
 */
contract InstitutionalRUSD is
    Initializable,
    ERC20Upgradeable,
    ERC20BurnableUpgradeable,
    ERC20PausableUpgradeable,
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
        __ERC20_init("iRUSD", "iRUSD");
        __ERC20Burnable_init();
        __ERC20Pausable_init();
        __ERC20Permit_init("iRUSD");
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

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function _update(
        address from,
        address to,
        uint256 value
    ) internal override(ERC20Upgradeable, ERC20PausableUpgradeable) {
        super._update(from, to, value);
    }
}
