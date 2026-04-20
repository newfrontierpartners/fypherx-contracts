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

    /// @notice Emitted whenever the single-minter slot is reassigned.
    /// @dev April-audit L-5 patch. The companion RUSD token already
    ///      emits an analogous event on rotation; FYUSD was the only
    ///      sibling token without it, leaving a silent observability
    ///      gap that off-chain monitors of "who can mint FYUSD" had no
    ///      cheap signal for.
    event MinterUpdated(address indexed previousMinter, address indexed newMinter);

    /// @notice Emitted exactly once when {initialize} sets the initial owner.
    /// @dev April-audit L-6 patch (companion to InstitutionalRUSD). Same
    ///      audit-trail rationale: a dedicated single signal is cheaper
    ///      to grep for than the OZ stack's `OwnershipTransferred(0, x)`
    ///      pattern.
    event Initialized(address indexed initialOwner);

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
        __ERC20_init("FYUSD", "FYUSD");
        __ERC20Burnable_init();
        __ERC20Permit_init("FYUSD");
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
}
