# ADR-004: Token symbol is FYP (spec doc to be updated)

- Status: Accepted
- Date: 2026-04-26
- Spec ref: `PHASE1_SPEC.md` §2 (uses "FPY")
- Resolves: GAP_ANALYSIS Q4

## Context

`PHASE1_SPEC.md` uses **"FPY"**. Codebase + on-chain deploy uses **"FYP"** (`0x8Ac0e5C2B3670F78039A7Ea19C9a79Ef28c65a4C`). Same governance/reward token.

## Decision

Token symbol is **FYP**. The spec wording will be normalized in subsequent doc revisions.

- No new contract deploy.
- No rename in code/UI.
- Spec text "FPY" should be read as "FYP" wherever encountered.
- All future ADRs and code use FYP.

## Consequences

- Zero engineering work.
- Add to onboarding: spec ↔ code symbol mismatch resolved here.
