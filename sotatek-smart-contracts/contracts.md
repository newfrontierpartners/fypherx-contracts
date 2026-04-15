# Fypher Protocol — Smart Contracts (BSC Testnet)

| Field | Value |
|-------|-------|
| Network | BNB Smart Chain Testnet (chainId: 97) |
| Deployer | `0x31B60b11533c97b5ED7b1B650D31855F3754Acb4` |
| Solidity | v0.8.22 (optimizer: 1 run) |
| Framework | Hardhat 2 + OpenZeppelin v5.0.2 |
| Source of truth | `deployed-addresses.json` |

---

## System Contracts

| Contract | Address | BscScan |
|----------|---------|---------|
| SettingManagement | `0x3DF5EafAd1E3979A0901dC3B24650eC745d1c9b2` | [View](https://testnet.bscscan.com/address/0x3DF5EafAd1E3979A0901dC3B24650eC745d1c9b2) |
| FypherMinting | `0x0Cc3De38A1ff577f23d14a4714530FCc11b24690` | [View](https://testnet.bscscan.com/address/0x0Cc3De38A1ff577f23d14a4714530FCc11b24690) |
| ReservePool | `0x9DDac07079537159765A6e083b1BB3A2fcFB84bB` | [View](https://testnet.bscscan.com/address/0x9DDac07079537159765A6e083b1BB3A2fcFB84bB) |

---

## Token Contracts (Upgradeable Proxy)

| Token | Symbol | Address | BscScan |
|-------|--------|---------|---------|
| RUSD | RUSD | `0xF3ac96da1edD17bb0e803Ad1d1c9Cbc18b42FaB5` | [View](https://testnet.bscscan.com/address/0xF3ac96da1edD17bb0e803Ad1d1c9Cbc18b42FaB5) |
| FYUSD | FYUSD | `0x3b1f4CA20fCDf837d89b3606900a4e60C3fba6EE` | [View](https://testnet.bscscan.com/address/0x3b1f4CA20fCDf837d89b3606900a4e60C3fba6EE) |
| FYP | FYP | `0x8Ac0e5C2B3670F78039A7Ea19C9a79Ef28c65a4C` | [View](https://testnet.bscscan.com/address/0x8Ac0e5C2B3670F78039A7Ea19C9a79Ef28c65a4C) |
| iRUSD | iRUSD | `0x6Abddeb89854bc477D680c431C18979227c64480` | [View](https://testnet.bscscan.com/address/0x6Abddeb89854bc477D680c431C18979227c64480) |

---

## Staking Vaults (ERC-4626, Upgradeable Proxy)

| Vault | Symbol | Underlying | Address | BscScan |
|-------|--------|-----------|---------|---------|
| StakedRUSD | sRUSD | RUSD | `0xd7c0921c1a18BeBEE74F9E88BF1d035Ac77b1db6` | [View](https://testnet.bscscan.com/address/0xd7c0921c1a18BeBEE74F9E88BF1d035Ac77b1db6) |
| StakedIRUSD | siRUSD | iRUSD | `0x058A9E41aF4aBbd7cc4dA1951581184291ED9609` | [View](https://testnet.bscscan.com/address/0x058A9E41aF4aBbd7cc4dA1951581184291ED9609) |
| StakedFYP | sFYP | FYP | `0xb43404C7Dc934743BdbFd3821617d0add6eFeBcA` | [View](https://testnet.bscscan.com/address/0xb43404C7Dc934743BdbFd3821617d0add6eFeBcA) |
| stAUSD | stAUSD | FYUSD | `0xa9401313d8DFe2FE302431A208DEFCde058E9D52` | [View](https://testnet.bscscan.com/address/0xa9401313d8DFe2FE302431A208DEFCde058E9D52) |

---

## Escrow Contracts (Silo)

| Silo | Vault | Token held | Address | BscScan |
|------|-------|-----------|---------|---------|
| RUSDSilo | StakedRUSD | RUSD | `0x78F42c44B94Af3692b5cD7105d50894B5da3Bc75` | [View](https://testnet.bscscan.com/address/0x78F42c44B94Af3692b5cD7105d50894B5da3Bc75) |
| SIRUSDSilo | StakedIRUSD | any ERC20 | `0xDa251B730F80E03Fc22B71dd392d561A65a818e6` | [View](https://testnet.bscscan.com/address/0xDa251B730F80E03Fc22B71dd392d561A65a818e6) |
| FYPSilo | StakedFYP | FYP | `0x5143e509911b3A9351D25dDf9d8724AFAe1E3511` | [View](https://testnet.bscscan.com/address/0x5143e509911b3A9351D25dDf9d8724AFAe1E3511) |
| stAUSDSilo | stAUSD | FYUSD | `0x5Df79Bd61f49a7D55E38bCAcfdFa1dCe309e63B7` | [View](https://testnet.bscscan.com/address/0x5Df79Bd61f49a7D55E38bCAcfdFa1dCe309e63B7) |
| iRUSDSilo | stAUSD | iRUSD | `0xc16CeD6A317E8Ad50C36484aa6caA3fA4042C658` | [View](https://testnet.bscscan.com/address/0xc16CeD6A317E8Ad50C36484aa6caA3fA4042C658) |

---

## Mock Collateral Tokens

| Token | Symbol | Decimals | Address | BscScan |
|-------|--------|----------|---------|---------|
| USDT | USDT | 18 | `0x786d227a88f67E416784623EdF3603e65F0eaA99` | [View](https://testnet.bscscan.com/address/0x786d227a88f67E416784623EdF3603e65F0eaA99) |
| USDC | USDC | 18 | `0x7059bce7B83ec0a313E6665f5Fb4Ec5D3650757d` | [View](https://testnet.bscscan.com/address/0x7059bce7B83ec0a313E6665f5Fb4Ec5D3650757d) |
| WETH | WETH | 18 | `0x30AE1692Be64328C1738395acDfea78E1F318865` | [View](https://testnet.bscscan.com/address/0x30AE1692Be64328C1738395acDfea78E1F318865) |
| BTC | BTC | 18 | `0x2230B920b8f1Bb0A2FCf28f8BD8ce9cC03C9D68C` | [View](https://testnet.bscscan.com/address/0x2230B920b8f1Bb0A2FCf28f8BD8ce9cC03C9D68C) |
| BNB | BNB | 18 | `0x9B7f04Ba34710C3A178EafE179f56596Ff0E6D17` | [View](https://testnet.bscscan.com/address/0x9B7f04Ba34710C3A178EafE179f56596Ff0E6D17) |

Anyone can mint these tokens for testing: `mint(address to, uint256 amount)`.

---

## Post-Deploy Configuration

| Setting | Value |
|---------|-------|
| Cooldown duration | 7 days (604800 seconds) |
| Reserve target | 3% (300 basis points) |
| RUSD minter | FypherMinting |
| Fee receiver | Deployer |
| Supported collateral | USDT, USDC, WETH, BTC, BNB |
| Backend signer | `0x31B60b11533c97b5ED7b1B650D31855F3754Acb4` |

---

## Commands

```bash
cd sotatek-smart-contracts
npm run compile            # Compile all contracts
npm run deploy:testnet     # Deploy to BSC Testnet
node setup-contracts.js    # Setup contract state (assets, signer, custodian)
```
