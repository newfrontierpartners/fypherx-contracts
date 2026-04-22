# Fypher Protocol — Smart Contract Flows

## Table of Contents

1. [System Architecture Overview](#1-system-architecture-overview)
2. [Contract Dependency Map](#2-contract-dependency-map)
3. [Access Control & Roles](#3-access-control--roles)
4. [Minting Flow (RUSD)](#4-minting-flow-rusd)
5. [Redemption Flow (RUSD → Collateral)](#5-redemption-flow-rusd--collateral)
6. [Staking Flows (ERC-4626 Vaults)](#6-staking-flows-erc-4626-vaults)
7. [Vault-Specific Flows](#7-vault-specific-flows)
8. [Reserve Pool Flow](#8-reserve-pool-flow)
9. [Admin / Configuration Flows](#9-admin--configuration-flows)
10. [Key Data Structures](#10-key-data-structures)
11. [Deployed Addresses (BSC Testnet)](#11-deployed-addresses-bsc-testnet)

---

## 1. System Architecture Overview

Fypher Protocol is a stablecoin system on BSC Testnet built around four layers:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Off-Chain Backend                            │
│  (Order signing, price feeds, reward calculation)               │
└──────────────────────────────┬──────────────────────────────────┘
                               │ signed orders / calls
┌──────────────────────────────▼──────────────────────────────────┐
│                     FypherMinting                               │
│  • ECDSA order verification                                     │
│  • Collateral → Custodians routing                              │
│  • RUSD minting / redemption with per-block rate limits         │
└──────┬──────────────┬────────────────────────┬──────────────────┘
       │ mint         │ read roles             │ reserve
       ▼              ▼                        ▼
┌────────────┐ ┌──────────────────┐ ┌────────────────────┐
│    RUSD    │ │ SettingManagement│ │    ReservePool     │
│    FYUSD   │ │ (role registry,  │ │  (emergency fund,  │
│    FYP     │ │  fees, configs)  │ │   3% collateral)   │
│    iRUSD   │ └──────────────────┘ └────────────────────┘
└────────────┘
       │ underlying token
       ▼
┌──────────────────────────────────────────────────────────────────┐
│                   Staking Vaults (ERC-4626)                      │
│  StakedRUSD (sRUSD) │ StakedIRUSD (siRUSD) │ StakedFYP (sFYP)   │
│  StakedAUSD (stAUSD)                                             │
└──────────────────────────┬───────────────────────────────────────┘
                           │ cooldown escrow
                           ▼
              ┌─────────────────────────┐
              │  Silo Contracts         │
              │  RUSDSilo / SIRUSDSilo  │
              │  (7-day lockup escrow)  │
              └─────────────────────────┘
```

**Token Map**:

| Token  | Role               | Vault     | Silo               |
|--------|--------------------|-----------|--------------------|
| RUSD   | Retail stablecoin  | sRUSD     | RUSDSilo           |
| iRUSD  | Institutional USD  | siRUSD    | SIRUSDSilo         |
| FYP    | Governance token   | sFYP      | RUSDSilo (FYP)     |
| FYUSD  | Utility stablecoin | stAUSD    | RUSDSilo (FYUSD)   |

---

## 2. Contract Dependency Map

```
SingleAdminAccessControl
        │ inherits
        ▼
SettingManagement ◄──────────────────────────────────────┐
                                                         │ ISettingManagement
        ▲ reads roles/configs                            │
        │                                                │
FypherMinting ──── RUSD.mint() ──────────────────► RUSD  │
        │                                                │
        └── transfers collateral ──────────────► Custodian addresses
        └── reads rate limits ──────────────────► globalMaxMintPerBlock

StakedRUSD ──────────────────── reads roles ──────► SettingManagement
        │
        └── transfers to silo ─────────────────► RUSDSilo
        └── reads from silo ──────────────────► RUSDSilo.withdraw()

StakedIRUSD ─── reads INSTITUTIONAL_ROLE ────────► SettingManagement
        └── transfers to silo ─────────────────► SIRUSDSilo

StakedFYP ──────────────────── reads roles ──────► SettingManagement
        └── transfers to silo ─────────────────► RUSDSilo (FYP)

StakedAUSD ─────────────────── reads roles ──────► SettingManagement
        └── transfers to stAUSDSilo ───────────► RUSDSilo (FYUSD)
        └── transfers to iRUSDSilo ────────────► SIRUSDSilo (iRUSD)

ReservePool ─── reads RELEASE_TOKEN_ROLE ────────► SettingManagement
```

---

## 3. Access Control & Roles

All roles are managed centrally in **SettingManagement** (SingleAdminAccessControl base).

### Role Table

| Role constant                 | Who holds it                  | Permissions                                        |
|-------------------------------|-------------------------------|----------------------------------------------------|
| `ADMIN_ROLE`                  | Deployer / multisig           | Grant/revoke all roles; change protocol config     |
| `REWARDER_ROLE`               | Backend reward distributor    | Call `transferInRewards()` on vaults               |
| `MINTER_ROLE`                 | FypherMinting contract        | Mint RUSD (via `RUSD.mint()`)                      |
| `BURNER_ROLE`                 | FypherMinting contract        | Burn RUSD during redemption                        |
| `INSTITUTIONAL_ROLE`          | Whitelisted institutions      | Deposit into siRUSD vault                          |
| `RETAIL_ROLE`                 | Retail users                  | Deposit into sRUSD vault (no restriction check)    |
| `SOFT_RESTRICTED_STAKER_ROLE` | Partially restricted accounts | Blocked from receiving shares in StakedRUSD        |
| `FULL_RESTRICTED_STAKER_ROLE` | Fully restricted accounts     | Blocked from deposit AND transfer in StakedRUSD    |
| `WHITELISTED_STAKER_ROLE`     | Approved stakers              | Bypasses soft restriction                          |
| `TRANSFER_FEE_ROLE`           | Protocol fee module           | Reserved for transfer fee logic                    |
| `RELEASE_TOKEN_ROLE`          | Emergency operator            | Call `releaseToken()` on vaults / ReservePool      |

### Role Check Flow

```
User → Vault.deposit()
              │
              ▼
  settingManagement.hasRole(FULL_RESTRICTED_STAKER_ROLE, receiver)
              │
        ┌─────┴─────┐
       yes          no
        │            │
     revert       continue
                     │
       settingManagement.hasRole(SOFT_RESTRICTED_STAKER_ROLE, receiver)
                     │
               ┌─────┴──────┐
              yes            no
               │              │
       settingManagement.hasRole(WHITELISTED_STAKER_ROLE, receiver)
                     │
               ┌─────┴──────┐
              no             yes
               │              │
            revert         continue → mint shares
```

---

## 4. Minting Flow (RUSD)

RUSD is minted when a user deposits collateral (USDT, USDC, WETH, BTC, BNB) via a backend-signed order.

### Participants

| Actor             | Role                                         |
|-------------------|----------------------------------------------|
| User              | Provides collateral, receives RUSD           |
| Backend Signer    | Signs off-chain Order with price/amount      |
| Backend Executor  | Can optionally relay the tx                  |
| Custodians        | Receive and hold collateral                  |
| FypherMinting     | Orchestrates the mint                        |

### Mint Sequence

```
User                Backend              FypherMinting           RUSD
 │                     │                       │                   │
 │ ── request quote ──►│                       │                   │
 │ ◄── signed Order ───│                       │                   │
 │                                             │                   │
 │ ── approve(collateral, FypherMinting) ───── │ (ERC-20 approve)  │
 │                                             │                   │
 │ ── mint(order, route, signature) ─────────► │                   │
 │                                             │                   │
 │                                   verifyOrder(order, sig)       │
 │                                   verifyNonce(benefactor, nonce)│
 │                                   verifyRoute(route)            │
 │                                   check block mint limit        │
 │                                   check collateral whitelisted  │
 │                                             │                   │
 │                                   ── transferFrom(benefactor,   │
 │                                        custodian[i], portion) ─►│ (per route)
 │                                             │                   │
 │                                   ── RUSD.mint(beneficiary,     │
 │                                             rusd_amount) ──────►│
 │                                             │                   │
 │ ◄── RUSD received ──────────────────────────────────────────────│
```

### Order Struct

```solidity
struct Order {
    address benefactor;        // Provides collateral (approves FypherMinting)
    address beneficiary;       // Receives minted RUSD
    address collateral_asset;  // Token address (USDT, USDC, WETH, BTC, BNB)
    uint256 collateral_amount; // Amount of collateral to deposit
    uint256 rusd_amount;       // Amount of RUSD to mint
    uint256 nonce;             // Unique per benefactor (replay protection)
    uint256 expiry;            // Unix timestamp; tx reverts after expiry
}
```

### Route Struct

```solidity
struct Route {
    address[] addresses;  // Custodian wallet addresses
    uint256[] ratios;     // Basis points allocations; must sum to 10000
}
// Example: 50% to custodian A, 50% to custodian B
// addresses = [0xAAA, 0xBBB], ratios = [5000, 5000]
```

### Validations Performed

| Check                        | Revert condition                                        |
|------------------------------|---------------------------------------------------------|
| Signature valid              | `ecrecover(hash, sig) != backendSigner`                 |
| Nonce not used               | `nonces[benefactor][nonce] == true`                     |
| Order not expired            | `block.timestamp > order.expiry`                        |
| Collateral whitelisted       | `!supportedAssets[collateral_asset]`                    |
| Mint not disabled            | `mintRedeemDisabled == true`                            |
| Per-block limit not exceeded | `mintedPerBlock[block.number] + amount > globalMaxMint` |
| Route ratios sum             | `sum(ratios) != 10000`                                  |
| Custodians authorized        | Any route address not in `custodianAddresses`           |

### Native BNB Minting (`mintWETH`)

Same flow as `mint()` but:
- `msg.value` is sent instead of `transferFrom`
- Collateral asset must be the WETH mock (wrapped BNB)
- FypherMinting wraps native BNB before routing to custodians

---

## 5. Redemption Flow (RUSD → Collateral)

Redemption is a two-step process: user locks RUSD, then backend executor releases collateral.

### Step 1 — Request Redeem

```
User                             FypherMinting              RUSD
 │                                     │                      │
 │── approve(RUSD, FypherMinting) ────►│                      │
 │                                     │                      │
 │── requestRedeem(rusdAmount, nonce)─►│                      │
 │                                     │── transferFrom(user, │
 │                                     │    contract, amount)►│
 │                                     │                      │
 │                           pendingRedemptions[user][nonce]  │
 │                                = rusdAmount                │
 │◄── tx confirmed ────────────────────│                      │
```

### Step 2 — Execute Redeem (Backend)

```
BackendExecutor              FypherMinting               Collateral
       │                           │                          │
       │── executeRedeem(          │                          │
       │     order, signature)────►│                          │
       │                           │                          │
       │                  verifyOrder(order, sig)             │
       │                  check backendSigner                 │
       │                  check block redeem limit            │
       │                  verify pendingRedemptions[          │
       │                    benefactor][nonce] >= amount      │
       │                           │                          │
       │                  burn RUSD locked in contract        │
       │                           │                          │
       │                  ── transferFrom(custodian,          │
       │                       beneficiary, collateral) ─────►│
       │◄── tx confirmed ──────────│                          │
```

### Step 3 — Cancel Redeem (Optional)

```
User                             FypherMinting              RUSD
 │                                     │                      │
 │── cancelRedeem(rusdAmount, nonce)──►│                      │
 │                                     │── transfer(user,     │
 │                                     │    rusdAmount) ─────►│
 │◄── RUSD returned ───────────────────│                      │
```

---

## 6. Staking Flows (ERC-4626 Vaults)

All vaults follow the ERC-4626 standard. Share price increases as rewards vest.

### 6.1 Deposit

```
User                      Vault (e.g. StakedRUSD)          SettingManagement
 │                                  │                               │
 │── approve(token, vault) ─────────│                               │
 │                                  │                               │
 │── deposit(assets, receiver) ────►│                               │
 │                                  │── hasRole(FULL_RESTRICTED,    │
 │                                  │    receiver) ────────────────►│
 │                                  │◄── false ─────────────────────│
 │                                  │── hasRole(SOFT_RESTRICTED,    │
 │                                  │    receiver) ────────────────►│
 │                                  │◄── false ─────────────────────│
 │                                  │                               │
 │                                  │── transferFrom(user, vault)   │
 │                                  │── _mint(receiver, shares)     │
 │                                  │── userStakedAmount[receiver] += assets
 │◄── shares minted ────────────────│                               │
```

**Share calculation** (ERC-4626):
```
shares = assets × totalSupply / totalAssets()
```
Where `totalAssets() = vault token balance + unvested rewards`

### 6.2 Cooldown & Unstake

The standard exit path: lock assets into the silo, wait 7 days, withdraw.

```
User                    Vault                      Silo
 │                        │                          │
 │── cooldownAssets(amt)─►│                          │
 │                        │── previewWithdraw(amt)   │
 │                        │── _burn(user, shares)    │
 │                        │── token.transfer(silo,amt)►│
 │                        │                          │ holds amt
 │                        │── cooldowns[user] = {    │
 │                        │     cooldownEnd: now+7d, │
 │                        │     underlyingAmount: amt│
 │                        │   }                      │
 │◄── tx confirmed ───────│                          │
 │                         (7 days pass)             │
 │── unstake(receiver) ──►│                          │
 │                        │── require(now >= cooldownEnd)
 │                        │── delete cooldowns[user] │
 │                        │── silo.withdraw(receiver,amt)►│
 │                        │                          │── token.transfer(receiver,amt)
 │◄── tokens received ────────────────────────────────│
```

**Cooldown by shares** (`cooldownShares`):
- Calculates `assets = previewRedeem(shares)` first
- Then identical to `cooldownAssets` flow

### 6.3 Early Unstake (with Fee)

Available in **StakedRUSD** (sRUSD) only. Exits cooldown immediately at cost of a fee.

```
User                    Vault                  SettingManagement
 │                        │                          │
 │── earlyUnstake(recv)──►│                          │
 │                        │── getFees("earlyUnstakeFee")►│
 │                        │◄── feeBps ───────────────│
 │                        │                          │
 │                        │ amount = cooldowns[user].underlyingAmount
 │                        │ fee = PoolMath.calculateFee(amount, feeBps)
 │                        │ netAmount = amount - fee │
 │                        │                          │
 │                        │── silo.withdraw(vault, amount)  (pull back)
 │                        │── token.transfer(receiver, netAmount)
 │                        │── token.transfer(feeReceiver, fee)
 │                        │── delete cooldowns[user] │
 │◄── netAmount received ─│                          │
```

### 6.4 Reward Distribution

Rewards are sent by the rewarder and vest linearly over 8 hours.

```
Rewarder                  Vault
    │                        │
    │── approve(token, vault)►│
    │                        │
    │── transferInRewards(amt)►│
    │                        │── require(REWARDER_ROLE)
    │                        │── transferFrom(rewarder, vault, amt)
    │                        │── vestingAmount += amt
    │                        │── lastDistributionTimestamp = now
    │◄── tx confirmed ───────│
    │
    │   (over next 8 hours):
    │
    │   totalAssets() = balance + vestedPortion
    │   vestedPortion = vestingAmount × elapsed / VESTING_PERIOD
    │
    │   Share price increases → depositors earn proportionally
```

**APR-based reward calculation** (helper, not enforced on-chain):
```
PoolMath.calculateReward(principal, aprBps, timeElapsed)
  = principal × aprBps × timeElapsed / (10000 × 365 days)
```

---

## 7. Vault-Specific Flows

### 7.1 StakedRUSD (sRUSD)

- **Underlying**: RUSD
- **Silo**: RUSDSilo (`withdraw(address to, uint256 amount)`)
- **Deposit restriction**: Checks FULL_RESTRICTED and SOFT_RESTRICTED roles
- **Early unstake**: Supported (deducts `earlyUnstakeFee` basis points)
- **Institutional**: No — retail only

```
RUSD ──deposit──► sRUSD vault ──cooldown──► RUSDSilo ──unstake──► receiver
```

### 7.2 StakedIRUSD (siRUSD)

- **Underlying**: iRUSD
- **Silo**: SIRUSDSilo (`withdraw(address token, address to, uint256 amount)`)
- **Deposit restriction**: Requires `INSTITUTIONAL_ROLE` on receiver
- **Early unstake**: Not supported

```
iRUSD ──deposit──► siRUSD vault ──cooldown──► SIRUSDSilo ──unstake──► receiver
```

Deposit gate:
```
deposit(assets, receiver)
    │
    ▼
settingManagement.hasRole(INSTITUTIONAL_ROLE, receiver)
    │                    │
   no                   yes
    │                    │
 revert              continue → mint shares
```

### 7.3 StakedFYP (sFYP)

- **Underlying**: FYP
- **Silo**: RUSDSilo variant holding FYP (`withdraw(address to, uint256 amount)`)
- **Deposit restriction**: None
- **Early unstake**: Not supported

```
FYP ──deposit──► sFYP vault ──cooldown──► FYPSilo ──unstake──► receiver
```

### 7.4 StakedAUSD (stAUSD)

- **Underlying**: FYUSD
- **Two silos**:
  - `stAUSDSilo` — RUSDSilo holding FYUSD (standard cooldown)
  - `iRUSDSilo` — SIRUSDSilo holding iRUSD (multi-token cooldown)
- **Deposit restriction**: None
- **Early unstake**: Not supported

```
FYUSD ──deposit──► stAUSD vault ──cooldown──► stAUSDSilo ──unstake──► receiver
                                │
                                └──────────── iRUSDSilo (iRUSD rewards path)
```

---

## 8. Reserve Pool Flow

The ReservePool holds 3% of collateral value as an emergency liquidity buffer.

### Funding the Reserve

Custodians or admin transfer collateral directly to the ReservePool address. The contract accepts any ERC-20 token and native BNB.

```
Admin / Custodian
    │
    │── token.transfer(reservePool, amount)     (direct ERC-20 transfer)
    │── or send native BNB to reservePool.address
    │
    ▼
ReservePool holds balance
```

### Distributing from Reserve

```
Admin (RELEASE_TOKEN_ROLE)
    │
    │── reservePool.distributeFunds(token, recipient, amount)
    │
    ▼
ReservePool
    │── require(settingManagement.hasRole(RELEASE_TOKEN_ROLE, msg.sender))
    │── token.transfer(recipient, amount)
    ▼
Recipient receives funds
```

### Emergency Withdraw (full balance)

```
Admin
    │── reservePool.emergencyWithdraw(token, to)
    │── token.transfer(to, token.balanceOf(address(this)))
```

### Reserve Target Check

Target is 3% (300 basis points) of redeemable RUSD supply.

```
target = (rusdTotalSupply × reserveTarget) / 10000
```

This is an off-chain metric; the contract does not enforce it automatically.

---

## 9. Admin / Configuration Flows

All admin actions require `ADMIN_ROLE` on SettingManagement unless noted.

### Fee Configuration

```solidity
settingManagement.setFees("earlyUnstakeFee", 100);  // 1% = 100 bps
settingManagement.setFees("mintFee", 0);            // 0 bps
settingManagement.setFees("redeemFee", 0);
```

### Pool Configuration

```solidity
settingManagement.setPoolConfigs("cooldownDuration", 604800); // 7 days in seconds
```

### Reserve Configuration

```solidity
settingManagement.setReservePool(reservePoolAddress);
settingManagement.setReserveTarget(300);  // 3% = 300 bps
settingManagement.setFeeReceiver(feeReceiverAddress);
```

### Minting Engine Configuration

```solidity
fypherMinting.setBackendSigner(signerAddress);
fypherMinting.setBackendExecutor(executorAddress);
fypherMinting.addSupportedAsset(usdtAddress);
fypherMinting.addCustodianAddress(custodianAddress);
fypherMinting.setGlobalMaxMintPerBlock(1_000_000e18);
fypherMinting.setGlobalMaxRedeemPerBlock(1_000_000e18);
fypherMinting.disableMintRedeem(true);   // Circuit breaker
```

### Blacklist Management

```solidity
settingManagement.addToBlacklist(userAddress);
settingManagement.removeFromBlacklist(userAddress);
```

Blacklisted addresses cannot deposit into vaults or participate in minting.

### Vault Pause

```solidity
stakedRUSD.pause();    // Suspends all deposits, transfers
stakedRUSD.unpause();
```

### Token Release (Emergency)

```solidity
// Caller must have RELEASE_TOKEN_ROLE
stakedRUSD.releaseToken(tokenAddress, recipientAddress, amount);
```

---

## 10. Key Data Structures

### FypherMinting Storage

```solidity
mapping(address => mapping(uint256 => bool)) nonces;
// nonces[benefactor][nonce] = used

mapping(address => bool) supportedAssets;
// supportedAssets[tokenAddress] = true

mapping(address => bool) custodianAddresses;
// custodianAddresses[wallet] = true

mapping(uint256 => uint256) mintedPerBlock;
// mintedPerBlock[blockNumber] = totalMintedRUSD

mapping(uint256 => uint256) redeemedPerBlock;
// redeemedPerBlock[blockNumber] = totalRedeemedRUSD

mapping(address => mapping(uint256 => uint256)) pendingRedemptions;
// pendingRedemptions[benefactor][nonce] = rusdAmount
```

### Vault Cooldown Storage

```solidity
struct UserCooldown {
    uint104 cooldownEnd;         // Unix timestamp when unstake is allowed
    uint152 underlyingAmount;    // Amount of underlying token locked in silo
}

mapping(address => UserCooldown) cooldowns;
mapping(address => uint256) userStakedAmount;
```

### Vault Reward Storage

```solidity
uint256 vestingAmount;              // Total rewards in current vesting window
uint256 lastDistributionTimestamp;  // When current vesting window started
uint256 remainingRewards;           // Cumulative total rewards ever received
uint256 currentAPRRate;             // APR in basis points (set by admin)
uint256 VESTING_PERIOD = 8 hours;   // Linear vesting window duration
```

### SettingManagement Storage

```solidity
mapping(string => uint256) _fees;
// _fees["earlyUnstakeFee"] = 100

mapping(string => uint256) _poolConfigs;
// _poolConfigs["cooldownDuration"] = 604800

mapping(address => bool) _blacklisted;

address _feeReceiver;
address _reservePool;
uint256 _reserveTarget;  // basis points (300 = 3%)
```

---

## 11. Deployed Addresses (BSC Testnet)

Chain ID: **97**

| Contract             | Address                                      | Type   |
|----------------------|----------------------------------------------|--------|
| SettingManagement    | `0x3DF5EafAd1E3979A0901dC3B24650eC745d1c9b2` | Proxy  |
| RUSD                 | `0xF3ac96da1edD17bb0e803Ad1d1c9Cbc18b42FaB5` | Proxy  |
| FYUSD                | `0x3b1f4CA20fCDf837d89b3606900a4e60C3fba6EE` | Proxy  |
| FYP                  | `0x8Ac0e5C2B3670F78039A7Ea19C9a79Ef28c65a4C` | Proxy  |
| iRUSD                | `0x6Abddeb89854bc477D680c431C18979227c64480` | Proxy  |
| FypherMinting        | `0x0Cc3De38A1ff577f23d14a4714530FCc11b24690` | Proxy  |
| ReservePool          | `0x9DDac07079537159765A6e083b1BB3A2fcFB84bB` | Direct |
| StakedRUSD (sRUSD)   | `0xd7c0921c1a18BeBEE74F9E88BF1d035Ac77b1db6` | Proxy  |
| RUSDSilo             | `0x78F42c44B94Af3692b5cD7105d50894B5da3Bc75` | Direct |
| StakedIRUSD (siRUSD) | `0x058A9E41aF4aBbd7cc4dA1951581184291ED9609` | Proxy  |
| SIRUSDSilo           | `0xDa251B730F80E03Fc22B71dd392d561A65a818e6` | Direct |
| StakedFYP (sFYP)     | `0xb43404C7Dc934743BdbFd3821617d0add6eFeBcA` | Proxy  |
| FYPSilo              | `0x5143e509911b3A9351D25dDf9d8724AFAe1E3511` | Direct |
| StakedAUSD (stAUSD)  | `0xa9401313d8DFe2FE302431A208DEFCde058E9D52` | Proxy  |
| stAUSDSilo           | `0x5Df79Bd61f49a7D55E38bCAcfdFa1dCe309e63B7` | Direct |
| iRUSDSilo            | `0xc16CeD6A317E8Ad50C36484aa6caA3fA4042C658` | Direct |
| Mock USDT            | `0x786d227a88f67E416784623EdF3603e65F0eaA99` | Direct |
| Mock USDC            | `0x7059bce7B83ec0a313E6665f5Fb4Ec5D3650757d` | Direct |
| Mock WETH            | `0x30AE1692Be64328C1738395acDfea78E1F318865` | Direct |
| Mock BTC             | `0x2230B920b8f1Bb0A2FCf28f8BD8ce9cC03C9D68C` | Direct |
| Mock BNB             | `0x9B7f04Ba34710C3A178EafE179f56596Ff0E6D17` | Direct |

All Proxy contracts use **TransparentUpgradeableProxy** (OpenZeppelin v5).
All implementations are deployed with Solidity **0.8.22**, optimizer enabled (1 run).
