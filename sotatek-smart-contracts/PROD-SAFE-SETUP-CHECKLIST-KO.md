# PROD 체크리스트 — Gnosis Safe 설정 → 컨트랙트 배포 (Ethereum mainnet)

2026-06-17. Get FYUSD / Earn / Redeem 런칭용. epoch + FYUSD 토큰 컨트랙트 제외(FYUSD=BitGo 발행). 담보=USDC·USDT 둘 다. 배포 런북은 `PROD-DEPLOY-RUNBOOK-2026-06-17.md` 참고.

> ⚠️ **중요**: 어드민 콘솔은 Safe를 **생성하지 않습니다**. Safe는 app.safe.global(또는 스크립트)로 만들고, 어드민은 그 Safe를 **배선(wire)** 하고 **제안/승인/실행**에 씁니다. 외부 자금흐름은 멀티시그가 아닌 relayer로 동작(설계상) — Safe는 거버넌스/권한만 통제.

---

## A. Gnosis Safe 설정 (멀티시그 협의체 만들기)

- [ ] **A-1. 오너 지갑 확정** — 하드웨어 지갑 N개(예: Ledger). 메인넷은 EOA가 아닌 HW 지갑 권장.
- [ ] **A-2. 임계값 결정** — ADR-007 기준 **3-of-5**. (소유자 3명이면 2-of-3.)
- [ ] **A-3. Safe 생성** — https://app.safe.global → Ethereum mainnet 선택 → Create new Safe → 오너 주소 + 임계값 입력 → 배포(가스 필요). *(또는 `SAFE_THRESHOLD=3 npx hardhat run scripts/deploy-operator-safe.js --network mainnet` — 단, 스크립트 오너목록은 3개라 5명이면 UI 사용 권장.)*
- [ ] **A-4. Safe 주소 기록** — `addresses/1.json`의 `OperatorSafe`, 게이트웨이 env, 대시보드 `addresses.ts`(OPERATOR_SAFE_ADDRESS[1])에 입력.
- [ ] **A-5. 백엔드 relayer를 Safe delegate로 등록** — `api.safe.global/tx-service/eth`에 등록(대시보드가 제안을 POST하려면 필요).
- [ ] **A-6. 어드민 배선** — 게이트웨이 env:
  - `FYPHERX_ADMIN_TX_MODE=safe-propose`
  - `FYPHERX_OPERATOR_SAFE_ADDRESS=<safe>`
  - `FYPHERX_SAFE_TX_SERVICE_URL=https://api.safe.global/tx-service/eth` · `FYPHERX_SAFE_CHAIN_SLUG=eth`
- [ ] **A-7. 확인** — 어드민 → Safety & controls → **Operator Safe** 페이지가 "Safe-propose mode (prod)"로 표시되는지. **Safe Queue** 페이지에서 오너/임계값이 보이는지.

> **어드민에서의 Safe 사용 흐름**: 거버넌스 액션(볼트 pause/set-keeper/set-pauser, 컨트랙트 role, 민팅 캡 등)을 어드민에서 누르면 → `safe-propose` 모드에서 **Safe 제안**이 생성됨 → **Safe Queue** 페이지에서 오너들이 "Sign in Safe ↗"(mainnet은 hosted Safe UI)로 서명 → 임계값 충족 시 "Execute ↗"로 온체인 반영.

---

## B. 배포 전 사전 준비 (1시 전)

- [ ] **B-1. hardhat 준비** — `.env`: `PRIVATE_KEY`(펀딩된 메인넷 deployer), `ETHERSCAN_API_KEY`, `MAINNET_RPC_URL`(전용 RPC). `npx hardhat compile`.
- [ ] **B-2. deployer ETH 펀딩** — 컨트랙트 ~8개 배포 + admin tx 가스.
- [ ] **B-3. 담보 토큰 주소** — USDC `0xA0b8…48`, USDT `0xdAC1…ec7` (둘 다, 6-dec).
- [ ] **B-4. Concrete 메인넷 볼트 주소 2개** — USDC용·USDT용, 각 `asset()`이 해당 스테이블과 일치 확인.
- [ ] **B-5. 감사 게이트** — FyusdEarnVault / ConcreteStableAdapter / EarnLockRegistry 외부 감사 완료 확인. (미완료면 배포는 가능하나 실자금 금지.)

---

## C. 컨트랙트 배포 (순서대로)

- [ ] **C-1. Operator Safe** (A-3에서 완료) — 주소 확보.
- [ ] **C-2. Core 부트스트랩** — `WATCHDOG_ADDRESS=0x<guardian> npx hardhat run scripts/deploy-mainnet-core.js --network mainnet`
  → SettingManagement(admin=deployer) + ReservePool + FypherCircuitBreaker + setReservePool.
- [ ] **C-3. Earn 볼트+어댑터 (USDC)** — `STABLE_ADDRESS=0x<USDC> CONCRETE_VAULT_ADDRESS=0x<Concrete USDC볼트> SETTING_MANAGEMENT_ADDRESS=0x<SM> ADMIN_ADDRESS=0x<deployer> npx hardhat run scripts/deploy-fyusd-earn-vault.js --network mainnet`
- [ ] **C-4. Earn 볼트+어댑터 (USDT)** — 위와 동일, STABLE/CONCRETE만 USDT용으로. (FyusdEarnVault+ConcreteStableAdapter 쌍 2세트 주소 기록.)
- [ ] **C-5. Lock Registry** — `RELAYER_ADDRESS=0x<백엔드 relayer> npx hardhat run scripts/deploy-earn-lock-registry.js --network mainnet`
- [ ] **C-6. (배포 안 함 확인)** — FYUSD.sol·FyusdEpochSettlement/Redemption·Minting/BurnQueue/StakingHub/YieldVault — 배포하지 않음. `deploy-mainnet.js`(깨짐)·`deploy-phase1.js`(제외 대상 배포) 사용 금지.

---

## D. 권한 → Safe 이전 (멀티시그가 전 컨트랙트 통제)

- [ ] **D-1. admin 이전 시작** — `npx hardhat run scripts/grant-admin-to-safe.js --network mainnet` (SettingManagement.transferAdmin(safe) — 되돌릴 수 있는 단계).
- [ ] **D-2. Safe가 admin 수락** — app.safe.global(eth:`<safe>`) → New transaction → Contract interaction → `<SettingManagement>` → `acceptAdmin()` → 임계값 오너 서명 → 실행. **이 순간 Safe가 SM admin이 되고, SM.hasRole로 admin을 조회하는 모든 컨트랙트(FyusdEarnVault×2·어댑터·ReservePool·CircuitBreaker)를 자동으로 통제**.
- [ ] **D-2b. ProxyAdmin(업그레이드 권한) 이전** — `OPERATOR_SAFE_ADDRESS=0x<safe> npx hardhat run scripts/transfer-proxy-admin-to-safe.js --network mainnet` (레지스트리가 볼트 키를 하나만 보관하면 두 번째 볼트 프록시는 `PROXY_ADDRESSES=0x…`로 추가). 모든 업그레이더블 프록시(SettingManagement·CircuitBreaker·FyusdEarnVault×2)의 OZ ProxyAdmin owner를 Safe로 이전. **이게 빠지면 임시 EOA가 프록시 업그레이드 권한을 계속 보유 → 구현체를 갈아끼울 수 있어 멀티시그가 무력화됨**. (비가역 — 이후 업그레이드는 Safe만 가능.)
- [ ] **D-3. Lock Registry owner 이전** — Safe tx로 `EarnLockRegistry.setOwner(safe)`, 또는 스크립트로: `OPERATOR_SAFE_ADDRESS=0x<safe> npx hardhat run scripts/transfer-lock-registry-owner.js --network mainnet`. (단, 백엔드 relayer는 `locker` 권한만 있으면 동작 — 자금경로 비차단.)
- [ ] **D-4. 무권한 검증** — 임시 EOA 폐기/콜드보관 전에, deployer가 더 이상 (a) SettingManagement admin(`owner()`/`hasRole(0x0, deployer)` 둘 다 false), (b) 어느 ProxyAdmin의 owner(각 프록시 `erc1967.getAdminAddress` → 그 ProxyAdmin `owner()` == Safe), (c) EarnLockRegistry owner 가 아님을 **온체인으로 확인**. 셋 다 Safe로 넘어간 것을 확인한 뒤에만 임시 deployer 키를 폐기/콜드보관.

---

## E. 배포 후 설정 (이제 Safe 제안으로)

- [ ] **E-1. 볼트별 keeper/pauser** (각 USDC/USDT 볼트) — Safe 제안: `setKeeper(<백엔드 hot wallet>)`, `setPauserRole(<guardian|circuitBreaker>)`.
- [ ] **E-2. 쿨다운 설정** — `SettingManagement.setPoolConfigs("vFyusdEarnCooldown", 1209600)` (14일).
- [ ] **E-3. Concrete 화이트리스트** — Concrete가 우리 **어댑터 2개 주소**를 Earn-V2 Hook에 등록(오프체인 협의).
- [ ] **E-4. 백엔드 config** — `FYPHERX_CHAIN_ID=1`, `ETH_RPC`, `FYPHERX_EARN_VAULT_ADDRESS`(볼트들), `FYPHERX_EARN_COLLATERAL_SYMBOL=USDC|USDT`, `BETA_ALLOCATION_FYUSD_BPS=7000`(70:30, 백엔드 관리), BitGo 시크릿(`fypherx/prod/bitgo` — BVI/LLC 지갑 생성 후 값 입력).
- [ ] **E-5. 검증(Etherscan)** — `npx hardhat verify --network mainnet <addr> <ctor args>` (어댑터·ReservePool·EarnLockRegistry).

---

## 멀티시그가 통제하는 범위 (요약)
- ✅ **거버넌스/권한 전부**: SettingManagement(admin) → 그 admin을 조회하는 FyusdEarnVault×2·어댑터·ReservePool·CircuitBreaker. + EarnLockRegistry(owner 이전). 볼트 pause/keeper/pauser·role·캡·쿨다운 등.
- ✅ **업그레이드 권한**: 모든 업그레이더블 프록시(SettingManagement·CircuitBreaker·FyusdEarnVault×2)의 OZ ProxyAdmin owner도 Safe(D-2b). 즉 구현체 업그레이드도 멀티시그 통제 하. (이걸 빼면 admin만 넘기고 업그레이드는 EOA가 쥔 채라 위험.)
- ⚙️ **자금경로(설계상 relayer)**: Get FYUSD 건별 발행·커스터디 hop·분배, redeem 처리 — 멀티시그는 너무 느려 fast relayer가 담당(Safe 비차단). Safe는 이 경로의 **설정/권한**만 통제.
