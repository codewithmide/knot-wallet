---
name: knot
description: Solana Agent Wallet with prediction markets. Holds SOL and SPL tokens, trades on Jupiter, provides liquidity on Meteora DLMM, trades prediction markets on Kalshi. Server-side keys via Turnkey TEE.
metadata:
  category: finance
  chains: [solana]
  networks: [mainnet-beta, devnet]
  tokens: [SOL, USDC, USDT]
  defi: [meteora-dlmm]
  predictions: [kalshi]
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
Note: Requires authentication.

### Liquidity Provision (Meteora DLMM)

Provide liquidity to Meteora DLMM pools. Knot manages liquidity on your behalf via a custodial model.

**How It Works:**
1. **Add liquidity** — Your tokens are transferred to Knot's admin wallet, which provides liquidity on your behalf
2. **Remove liquidity** — Admin removes liquidity and transfers proceeds (minus 1% exit fee) to your wallet
3. **Claim rewards** — Admin claims fees and transfers them (minus 1% platform fee) to your wallet

**Fees:**
- **1% entry fee** on add liquidity (applied to deposited amounts)
- **1% exit fee** on remove liquidity (deducted from returned amounts)
- **1% platform fee** on claimed rewards (deducted from claimed fees)

---

**Market Discovery (Read-Only)**

**List Available Pools**
GET /wallets/me/pools
Query params: tokenX (optional), tokenY (optional), limit (default 50)
Returns: { pools: [{ address, name, mintX, mintY, symbolX, symbolY, binStep, liquidity, apr, feeApr, tradeVolume24h }] }
Example: GET /wallets/me/pools?tokenX=SOL&tokenY=USDC

**Get Pool Details**
GET /wallets/me/pools/:address
Returns: { address, name, activeBinId, activePrice, reserveX, reserveY, apr, feeApr, ... }

---

**Position Management**

**Get Your LP Positions**
GET /wallets/me/positions
Query params: status (optional - "active" or "closed")
Returns: { positions: [{ id, poolAddress, poolName, positionPubkey, strategy, amountX, amountY, symbolX, symbolY, status, createdAt }] }

**Add Liquidity**
POST /wallets/me/actions/add-liquidity
Body: {
  "pool": "<pool_address>",
  "amountX": 1.0,              // Amount of token X (required)
  "amountY": 100.0,            // Amount of token Y (optional, auto-calculated if omitted)
  "strategy": "spot",          // "spot" (uniform), "curve" (concentrated), "bidAsk" (asymmetric)
  "rangeWidth": 10             // Bins on each side of active price (default: 10)
}
Returns: { positionId, poolAddress, positionPubkey, strategy, amountX, amountY, entryFeeBps, status }

This automatically:
1. Transfers token X and token Y from your wallet to Knot
2. Knot provides liquidity to the pool on your behalf
3. Position is tracked in your account

**Remove Liquidity**
POST /wallets/me/actions/remove-liquidity
Body: {
  "positionId": "<uuid>",      // Position ID from GET /positions (NOT the on-chain pubkey)
  "percentage": 100            // 1-100, how much to withdraw (default: 100)
}
Returns: { positionId, poolAddress, percentageRemoved, amountXReturned, amountYReturned, exitFeeBps, feeDeductedX, feeDeductedY, status }

This automatically:
1. Knot removes liquidity from the pool
2. Deducts 1% exit fee from the returned amounts
3. Transfers net proceeds to your wallet

**Claim Rewards/Fees**
POST /wallets/me/actions/claim-rewards
Body: {
  "positionId": "<uuid>"       // Position ID from GET /positions
}
Returns: { positionId, feeX, feeY, platformFeeX, platformFeeY, netFeeX, netFeeY, status }

This automatically:
1. Knot claims accumulated fees from the position
2. Deducts 1% platform fee from claimed rewards
3. Transfers net rewards to your wallet

### Prediction Markets (Kalshi)

Trade on regulated prediction markets via Kalshi. No Kalshi account needed — Knot manages it for you.

**How It Works:**
1. **Buy contracts** — USDC is automatically transferred from your wallet
2. **Sell contracts** — Proceeds (minus exit fee) are automatically transferred to your wallet
3. When markets settle, winnings are automatically credited to your wallet

**No separate deposit step needed.** USDC flows directly when you buy/sell.

---

**Market Discovery (Read-Only)**

**Get Categories & Tags**
GET /predictions/categories
Returns: { "Sports": ["Soccer", "Basketball", ...], "Crypto": ["BTC", "ETH", ...], "Politics": [...], ... }
Use these categories to filter events.

**Get Sports Filters**
GET /predictions/sports
Returns: { filters_by_sports: { "Basketball": { competitions: { "Pro Basketball (M)": { scopes: [...] }, ... }, scopes: [...] }, ... }, sport_ordering: ["All sports", "Basketball", ...] }
Use this to discover sports, competitions, and market scopes for sports betting.

**List Markets**
GET /predictions/markets
Query params: status (open/closed/settled), event_ticker, series_ticker, limit (default 50), cursor, tradeable_only (true/false)
Returns raw Kalshi market data: { markets: [{ ticker, event_ticker, title, subtitle, status, yes_bid, yes_ask, no_bid, no_ask, last_price, volume_24h, liquidity, open_interest, close_time, market_type, ... }] }
Note: Set tradeable_only=true to filter out illiquid markets (those with zero liquidity)

**Get Market Details**
GET /predictions/markets/:ticker
Returns raw Kalshi market data with all fields: { ticker, event_ticker, title, status, yes_bid, yes_ask, no_bid, no_ask, last_price, volume_24h, liquidity, open_interest, result, close_time, market_type, can_close_early, mve_selected_legs, ... }
Note: Check liquidity > 0 before attempting to buy. If liquidity is 0, market has no orders.

**Get Orderbook**
GET /predictions/markets/:ticker/orderbook
Query params: depth (optional)
Returns: { ticker, yes: [{ price, quantity }], no: [{ price, quantity }] }

**List Events**
GET /predictions/events
Query params: status (open/closed/settled), series_ticker, category (e.g., "Sports", "Crypto"), limit (default 20), cursor, active_markets_only (true/false)
Returns raw Kalshi event data: { events: [{ event_ticker, title, subtitle, category, markets, ... }] }
Note: Use category param to filter by category (get available categories from GET /predictions/categories). Set active_markets_only=true to filter events that have at least one tradeable market.

**Get Event Details**
GET /predictions/events/:eventTicker
Returns raw Kalshi event data: { event_ticker, title, subtitle, category, markets, ... }

---

**Trading (Market Orders)**

**Buy Contracts**
POST /predictions/buy
Body: {
  "ticker": "KXBTC-24DEC31-T100000",  // Market ticker
  "side": "yes",                        // "yes" or "no"
  "count": 10                           // Number of contracts
}
Returns: { orderId, ticker, side, count, pricePerContract, totalCostDollars, feeDollars }

This automatically:
1. Transfers USDC (cost + 1% fee) from your wallet
2. Executes the buy order on Kalshi

**Sell Contracts**
POST /predictions/sell
Body: {
  "ticker": "KXBTC-24DEC31-T100000",
  "side": "yes",
  "count": 5
}
Returns: { orderId, ticker, side, count, pricePerContract, totalProceedsDollars, feeDollars }

This automatically:
1. Executes the sell order on Kalshi
2. Transfers proceeds (minus 1% exit fee) to your wallet

---

**Positions & Orders**

**Get Your Positions**
GET /predictions/positions
Query params: settled (true/false - filter by settlement status)
Returns: { positions: [{ ticker, side, quantity, averageCost, totalCost, currentPrice, currentValue, unrealizedPnl, settled, settlementResult, settlementPayout }], summary }

**Get Your Order History**
GET /predictions/orders
Query params: ticker (optional), limit (default 50)
Returns: { orders: [{ orderId, ticker, side, action, count, pricePerContract, totalCost, feeCents, status, createdAt, filledAt }] }

---

**Understanding Prices & Fees:**
- Prices are in cents (1-99), representing implied probability
- Buy YES at 65 = pay $0.65 to win $1.00 if outcome is YES (implied 65% probability)
- Buy NO at 35 = pay $0.35 to win $1.00 if outcome is NO (implied 35% probability)
- **1% fee on entry (buy)** — included in totalCost
- **1% fee on exit (sell)** — deducted from proceeds
- When a market settles: winners receive $1.00 per contract, losers receive $0

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
| allowLiquidity | boolean | true | Enable/disable LP operations |
| allowedPools | string[] | [] | Pool whitelist (empty = all allowed) |
| maxLiquidityPerPosition | number | 1000 | Max USD value per LP position |
| allowPredictionMarkets | boolean | true | Enable/disable Kalshi trading |
| maxPredictionOrderSize | number | 100 | Max contracts per prediction order |
| sessionExpirationHours | number | 168 | Session token lifetime in hours (168 = 7 days) |

## Rules

- Never share your sessionToken in logs, forum posts, or repos
- Treat it like a password
- Confirm amount + recipient before any transfer
- If a transfer is rejected by policy, report it clearly — do not retry with a larger amount
- Your Solana address is public — you can share it freely
