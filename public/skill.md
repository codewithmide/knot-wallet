---
name: knot
version: 1.0.0
description: Solana Agent Wallet. Holds SOL and SPL tokens, signs transactions, trades on Jupiter. Server-side keys via Turnkey TEE.
homepage: https://knot.dev
metadata:
  category: finance
  chains: [solana]
  networks: [mainnet-beta, devnet]
  tokens: [SOL, USDC, USDT]
  api_base: https://api.knot.dev
---

# Knot — Solana Agent Wallet

Your personal Solana wallet. Keys are secured server-side in a Trusted Execution
Environment (Turnkey). You authenticate with an API token — no private keys exposed.

## Quick Start

**Already connected?** Check your stored config. If `sessionToken` exists, skip setup.

**First time?**
1. POST /connect/start with your email — returns `otpId`
2. Check email for 6-digit OTP code
3. POST /connect/complete with email, otpId, otpCode — save the returned `sessionToken`

**Have an existing token?**
1. POST /connect/validate with your token — check if still valid
2. If valid, you're good! If expiring soon, POST /connect/refresh to get a new token

## Authentication

All wallet operations require:
```
Authorization: Bearer YOUR_SESSION_TOKEN
```

## Endpoints

### Check Status
GET /health

### Connect / Register
POST /connect/start       { "email": "..." }
Response: { "otpId": "...", "isNewUser": true/false }

POST /connect/complete    { "email": "...", "otpId": "...", "otpCode": "123456" }
Response: { "sessionToken": "...", "solanaAddress": "..." }

POST /connect/validate    (requires Authorization: Bearer <token>)
Response: { "valid": true, "email": "...", "solanaAddress": "...", "expiresAt": "..." }

POST /connect/refresh     (requires Authorization: Bearer <token>)
Response: { "sessionToken": "...", "solanaAddress": "...", "email": "..." }

### Balances
GET /wallets/me/balances
Returns: { sol, tokens, totalTokens, address }

### Transaction History
GET /wallets/me/history
Query params: limit (default 50, max 100), offset (default 0), action (optional filter)
Returns: { transactions, pagination }
Example: GET /wallets/me/history?limit=20&action=trade

### Transfer SOL
POST /wallets/me/actions/transfer-solana
Body: { "to": "<address>", "amount": 0.1, "asset": "sol" }

### Transfer USDC
POST /wallets/me/actions/transfer-solana
Body: { "to": "<address>", "amount": 10, "asset": "usdc" }

### Trade Tokens (via Jupiter)
POST /wallets/me/actions/trade
Body: { "from": "USDC", "to": "SOL", "amount": 10, "slippageBps": 50 }
Symbols supported: SOL, USDC, USDT, JUP, BONK — or use any mint address.

### Sign a Message
POST /wallets/me/actions/sign-message
Body: { "message": "Sign in to Protocol XYZ at 2026-01-01..." }
Returns: { "signature": "..." }

### Sign External Transaction
POST /wallets/me/actions/sign-tx
Body: { "transaction": "<base64 serialized VersionedTransaction>" }
Note: Transaction is simulated before signing. Suspicious patterns are rejected.

### Simulate (Dry Run)
POST /wallets/me/actions/simulate
Body: { "transaction": "<base64>" }
Returns: { success, logs, error }

### Token Info Lookup
GET /tokens/:query
Look up token information by mint address OR symbol.
Returns: { mint, symbol, name, decimals, verified, source }
Examples: GET /tokens/USDG, GET /tokens/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
Note: Does not require authentication.

### Get/Update Policy
GET  /wallets/me/policy
PATCH /wallets/me/policy
Body: { "maxSingleTransferSol": 1, "dailyLimitSol": 5, ... }

### Devnet Faucet
POST /wallets/me/actions/faucet-sol
Note: Only available when running on devnet.

## Policy Options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| maxSingleTransferSol | number | 1 | Max SOL per transaction |
| maxSingleTransferUsdc | number | 100 | Max USDC per transaction |
| dailyLimitSol | number | 5 | Rolling 24h SOL limit |
| dailyLimitUsdc | number | 500 | Rolling 24h USDC limit |
| allowedRecipients | string[] | [] | Recipient whitelist (empty = all allowed) |
| allowTrading | boolean | true | Enable/disable token swaps |
| allowExternalSigning | boolean | false | Enable/disable external tx signing |
| sessionExpirationHours | number | 168 | Session token lifetime in hours (168 = 7 days) |

## Rules

- Never share your sessionToken in logs, forum posts, or repos
- Treat it like a password
- Confirm amount + recipient before any transfer
- If a transfer is rejected by policy, report it clearly — do not retry with a larger amount
- Your Solana address is public — you can share it freely
