# B1 smart-account feasibility and selection gate

## Network decision
- Testnet exclusively: passphrase `Test SDF Network ; September 2015`, RPC `https://soroban-testnet.stellar.org`.
- No Mainnet configuration, keys or deployed contracts in this branch.

## Preferred integration candidate
**Stellar Smart Account Kit** (https://github.com/stellar/smart-account-kit) is the preferred integration candidate for Cherry Pay Wallet. This is an architectural selection, **not** an approved or deployed contract. Before using it for spending, pin and review the exact source commit, package version, contract WASM hash, WebAuthn P-256 authorization format, recovery policy, licensing and audit status. Keep deployment and payments disabled until these gates pass.

## Candidate components
- Stellar smart-account patterns: https://developers.stellar.org/docs/build/guides/contract-accounts/smart-wallets
- **Preferred:** Stellar Smart Account Kit: https://github.com/stellar/smart-account-kit (version and contract verification pending)
- OpenZeppelin Stellar account contracts: https://docs.openzeppelin.com/stellar-contracts/accounts/smart-account
- Native XLM through Stellar Asset Contract (SAC): https://developers.stellar.org/docs/tokens/stellar-asset-contract

## Required validation before selecting/deploying
1. Contract validates WebAuthn P-256 signatures against exact transaction authorization payload, with replay prevention, expiration and signer rotation.
2. Demonstrate independent backup passkey recovery with on-chain signer policy.
3. Demonstrate C-address to G-address and C-address to C-address native XLM SAC transfer on Testnet.
4. Verify storage TTL, fee/rent and contract upgrade governance.
5. Separate relayer transaction fees from user spending authorization; relayer cannot move user assets alone.
6. Record contract artifact hash, source commit, SDK versions, contract address, deployment transaction and negative test evidence.
7. Threat-model account ID enumeration, RP/origin spoofing, duplicate submissions, recovery abuse and compromised relayer.

## Current outcome
**Not yet validated**. This branch provides an API-level WebAuthn verification foundation and explicit no-deployment guard. Do not claim B1 smart-account integration or B2 recovery is complete until actual Testnet deployment and recovery tests pass.
