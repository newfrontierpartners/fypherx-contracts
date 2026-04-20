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
 * @notice Institutional-only RUSD token. The companion StakedIRUSD
 *         vault gatekeeps deposits via `INSTITUTIONAL_ROLE` from
 *         SettingManagement; this token itself uses a single-`_minter`
 *         slot (set by the owner) rather than `MINTER_ROLE`.
 *
 * @dev Deployed at: 0x37B48945Fb8b6607b5386d35b3472c12E8374dfb.
 *
 *      April-audit L-6 patch: `initialize` now emits {Initialized}
 *      and rejects the zero address. April-audit L-5 patch (companion):
 *      `setMinter` emits {MinterUpdated}.
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

    /// @notice Emitted exactly once when {initialize} sets the initial owner.
    /// @dev April-audit L-6 patch. The OZ initializers fire low-level
    ///      `OwnershipTransferred(0, owner_)` events, but they get lost
    ///      among the four upgradeable extensions' init events. A
    ///      single explicit signal makes the deploy block trivial to
    ///      identify in off-chain audit trails (no need to grep across
    ///      `OwnershipTransferred` on multiple proxies).
    event Initialized(address indexed initialOwner);

    /// @notice Emitted whenever the single-minter slot is reassigned.
    /// @dev April-audit L-5 patch (companion to FYUSD). Same observability
    ///      rationale as on FYUSD.setMinter.
    event MinterUpdated(address indexed previousMinter, address indexed newMinter);

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
        if (owner_ == address(0)) revert ZeroAddress();
        __ERC20_init("iRUSD", "iRUSD");
        __ERC20Burnable_init();
        __ERC20Pausable_init();
        __ERC20Permit_init("iRUSD");
        __Ownable_init(owner_);
        emit Initialized(owner_);
    }

    function minter() external view returns (address) {
        return _minter;
    }

    function setMinter(address newMinter) external onlyOwner {
        if (newMinter == address(0)) revert ZeroAddress();
        emit MinterUpdated(_minter, newMinter);
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
