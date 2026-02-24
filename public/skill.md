---
name: knot
version: 1.0.0
description: Solana Agent Wallet. Holds SOL and SPL tokens, signs transactions, trades on Jupiter. Server-side keys via Turnkey TEE.
homepage: https://useknot.xyz
metadata:
  category: finance
  chains: [solana]
  networks: [mainnet-beta, devnet]
  tokens: [SOL, USDC, USDT]
  api_base: https://api.useknot.xyz
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

**Automatic Deposit Tracking**
All incoming deposits (SOL transfers, SPL token transfers) are automatically detected
and logged via Helius webhooks. When someone sends you tokens, it's automatically
recorded in your transaction history with the action `deposit`. No polling or manual
intervention needed — deposits appear in real-time.

### Transfer SOL
POST /wallets/me/actions/transfer
Body: { "to": "<address>", "amount": 0.1 }

### Transfer SPL Token (USDC, etc.)
POST /wallets/me/actions/transfer
Body: { "to": "<address>", "amount": 10, "mint": "USDC" }
Note: `mint` can be a symbol (USDC, USDT, JUP) or mint address. Omit for native SOL.

### Trade Tokens (via Jupiter Ultra)
POST /wallets/me/actions/trade
Body: { "from": "USDC", "to": "SOL", "amount": 10, "slippageBps": 50 }
Symbols supported: SOL, USDC, USDT, JUP, BONK — or use any mint address.
Note: Jupiter handles routing, MEV protection, and transaction landing.

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

### Export Private Key
POST /wallets/me/actions/export-private-key
Returns: { privateKey, address }
⚠️ Handle with extreme care! Never share or log the private key.

### Export Seed Phrase
POST /wallets/me/actions/export-seed-phrase
Returns: { seedPhrase }
⚠️ Handle with extreme care! Never share or log the seed phrase.

## Policy Options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| maxSingleTransferSol | number | 1 | Max SOL per transaction |
| dailyLimitSol | number | 5 | Rolling 24h SOL limit |
| allowedRecipients | string[] | [] | Recipient whitelist (empty = all allowed) |
| allowTrading | boolean | true | Enable/disable token swaps |
| sessionExpirationHours | number | 168 | Session token lifetime in hours (168 = 7 days) |

## Rules

- Never share your sessionToken in logs, forum posts, or repos
- Treat it like a password
- Confirm amount + recipient before any transfer
- If a transfer is rejected by policy, report it clearly — do not retry with a larger amount
- Your Solana address is public — you can share it freely
