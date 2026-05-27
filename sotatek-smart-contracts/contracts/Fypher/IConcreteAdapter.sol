// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/**
 * @title IConcreteAdapter
 * @notice Common interface for the FyusdYieldVault to talk to the
 *         Concrete (concrete.xyz) yield protocol — or a mock substitute
 *         when Concrete is not deployed on the target chain.
 *
 *         Per ADR-006:
 *           - BSC Testnet (Phase 1.0)  → MockConcreteAdapter (simulated yield)
 *           - Ethereum Mainnet (Phase 1.2) → ConcreteAdapterV1 (real protocol)
 *
 *         Both implementations share this interface so {FyusdYieldVault}
 *         is unchanged across networks; only the adapter binding differs
 *         at deploy time. Phase-2 adapter upgrades MUST preserve this
 *         signature or accept a parallel adapter v2.
 */
interface IConcreteAdapter {
    /**
     * @notice Pull `fyusdAmount` FYUSD from the caller and deposit it into
     *         the underlying Concrete pool. Returns the implementation-
     *         defined `shares` minted to the caller (vault) bookkeeping.
     */
    function deposit(uint256 fyusdAmount) external returns (uint256 shares);

    /**
     * @notice Withdraw `fyusdAmount` of underlying back to the caller
     *         (the bound vault). The adapter burns as many of its own
     *         internal shares as needed (ceil-rounded) to cover the
     *         requested asset amount.
     *
     * @dev FYP-41 patch. The signature is unchanged (selector
     *      `withdraw(uint256)`) but the parameter semantics flipped
     *      from "burn this many adapter-shares, return whatever
     *      assets that's worth" to "release this many assets, burn
     *      whatever adapter-shares are needed". The previous
     *      shares-in-shares-out shape required the vault's ERC4626
     *      share count to track the adapter's internal share count
     *      1:1, which the OZ ERC4626 inflation-protection math
     *      (`+1` / `+offset` correction) does not guarantee — the
     *      two could diverge by rounding and the vault would then
     *      over- or under-withdraw against the adapter. Asset-based
     *      withdraw lets the vault stay the single source of share
     *      accounting while the adapter handles only asset movement.
     *
     * @return fyusdAmount The amount actually delivered to the
     *         caller. Implementations MAY deliver more than the
     *         requested amount if Concrete's underlying ERC-4626
     *         math rounds the share-burn upward; callers should
     *         check the return value rather than assuming equality.
     */
    function withdraw(uint256 fyusdAmount) external returns (uint256);

    /**
     * @notice Total FYUSD currently controlled by the adapter (principal
     *         + unclaimed yield). Used by the vault for share/asset math.
     */
    function totalAssets() external view returns (uint256);

    /**
     * @notice Adapter-recorded share balance for a specific holder
     *         (typically the vault). Used by ops dashboards.
     */
    function shareOf(address holder) external view returns (uint256);

    /**
     * @notice Realized yield (in basis points, annualised) over the
     *         trailing 7 days. Used by the admin "7d realized APY" UI
     *         per spec §7. Implementations may return 0 when there is
     *         insufficient history.
     */
    function realizedYield7d() external view returns (uint256 yieldBps);

    /**
     * @notice The underlying token the adapter accepts. MUST be FYUSD
     *         in v1 — exposed for vault sanity checks at deploy time.
     */
    function asset() external view returns (address);
}
