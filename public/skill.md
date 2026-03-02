---
name: knot
description: Solana Agent Wallet with prediction markets. Holds SOL and SPL tokens, trades on Jupiter, provides liquidity on Meteora DLMM, trades prediction markets on Kalshi. Server-side keys via Turnkey TEE.
metadata:
  category: finance
  chains: [solana]
  networks: [mainnet-beta]
  tokens: [SOL, USDC, USDT]
  defi: [meteora-dlmm]
  predictions: [kalshi]
  api_base: https://api.useknot.xyz
---

# Knot — Solana Agent Wallet

Knot is a server-side Solana wallet built for AI agents. Private keys are secured inside Turnkey’s Trusted Execution Environment (TEE) — they never leave the enclave. You authenticate with a session token and interact entirely through REST. No browser extension, no popups, no private keys.

**Base URL:** `https://api.useknot.xyz`

**What you can do:**
- Hold and transfer SOL and any SPL token
- Swap tokens via Jupiter aggregator
- Provide liquidity on Meteora DLMM pools
- Trade prediction markets on Kalshi
- Set spending policies and limits

**All responses** follow a standard envelope:

```json
{
  "status": true,
  "statusCode": 200,
  "message": "Human-readable message.",
  "data": { ... }
}
```

On errors, `status` is `false` and `data` may contain additional error context.

---

## Table of Contents

1. [Authentication](#1-authentication)
2. [Wallet Operations](#2-wallet-operations)
3. [Token Trading (Jupiter)](#3-token-trading-jupiter)
4. [Liquidity Provision (Meteora DLMM)](#4-liquidity-provision-meteora-dlmm)
5. [Prediction Markets (Kalshi)](#5-prediction-markets-kalshi)
6. [Policy & Spend Limits](#6-policy--spend-limits)
7. [Token Info Lookup](#7-token-info-lookup)
8. [Rate Limits](#8-rate-limits)
9. [Idempotency](#9-idempotency)

---

## 1. Authentication

Knot uses email-based OTP authentication. No passwords, no API keys to generate manually. You start an OTP flow, receive a 6-digit code by email, and complete the flow to get a session token (JWT).

**All endpoints after authentication require the header:**

```
Authorization: Bearer YOUR_SESSION_TOKEN
```

### Step 1 — Start OTP Flow

Send your email to request a verification code.

```
POST /connect/start
```

**Request body:**

```json
{
  "email": "agent@example.com"
}
```

**Response:**

```json
{
  "status": true,
  "statusCode": 200,
  "message": "OTP sent to your email. Check your inbox.",
  "data": {
    "otpId": "org-id-string",
    "isNewUser": true
  }
}
```

- `otpId` — You need this for step 2. Save it.
- `isNewUser` — `true` if this is a first-time registration (a new Solana wallet will be created for you).

### Step 2 — Complete OTP Flow

Submit the 6-digit code from your email along with the `otpId` from step 1.

```
POST /connect/complete
```

**Request body:**

```json
{
  "email": "agent@example.com",
  "otpId": "org-id-string",
  "otpCode": "123456"
}
```

**Response:**

```json
{
  "status": true,
  "statusCode": 200,
  "message": "Authentication successful.",
  "data": {
    "sessionToken": "eyJhbGciOiJIUzI1NiIs...",
    "solanaAddress": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    "isNewUser": true
  }
}
```

- `sessionToken` — This is your Bearer token. Store it securely.
- `solanaAddress` — Your Solana wallet address. Share this publicly to receive tokens.

Session tokens expire after 7 days by default (configurable via policy). Use the endpoints below to manage your session.

### Validate Token

Check if your current session token is still valid and when it expires.

```
POST /connect/validate
Authorization: Bearer YOUR_SESSION_TOKEN
```

**Response:**

```json
{
  "data": {
    "valid": true,
    "email": "agent@example.com",
    "solanaAddress": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    "expiresAt": "2026-03-09T12:00:00.000Z"
  }
}
```

### Refresh Token

Get a new session token before the current one expires. Requires a valid current token.

```
POST /connect/refresh
Authorization: Bearer YOUR_SESSION_TOKEN
```

**Response:**

```json
{
  "data": {
    "sessionToken": "eyJhbGciOiJIUzI1NiIs...",
    "solanaAddress": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    "email": "agent@example.com"
  }
}
```

---

## 2. Wallet Operations

Once authenticated, you have a Solana wallet. You can check balances, view transaction history, transfer tokens, and unwrap wSOL.

### Get Balances

Returns your SOL balance and all SPL token balances with metadata (symbol, name, decimals).

```
GET /wallets/me/balances
Authorization: Bearer YOUR_SESSION_TOKEN
```

**Response:**

```json
{
  "data": {
    "sol": 1.5,
    "tokens": [
      {
        "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        "symbol": "USDC",
        "name": "USD Coin",
        "balance": 150.0,
        "decimals": 6
      }
    ],
    "totalTokens": 1,
    "address": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
  }
}
```

### Get Transaction History

Returns your full transaction history including transfers, trades, deposits, LP operations, and prediction trades.

```
GET /wallets/me/history
Authorization: Bearer YOUR_SESSION_TOKEN
```

**Query parameters:**
| Param | Default | Description |
|-------|---------|-------------|
| limit | 50 | Max results (max 100) |
| offset | 0 | Pagination offset |
| action | — | Filter by type: `transfer`, `trade`, `deposit`, `add_liquidity`, `remove_liquidity`, etc. |

**Example:** `GET /wallets/me/history?limit=20&action=trade`

**Automatic Deposit Tracking:** All incoming deposits (SOL and SPL tokens) are automatically detected via Helius webhooks and recorded in your history with action `deposit`. No polling needed — deposits appear in real-time.

### Transfer SOL

Send native SOL to any Solana address.

```
POST /wallets/me/actions/transfer
Authorization: Bearer YOUR_SESSION_TOKEN
```

**Request body:**

```json
{
  "to": "RecipientSolanaAddress",
  "amount": 0.1
}
```

When `mint` is omitted, native SOL is transferred.

### Transfer SPL Token

Send any SPL token by providing a symbol name or mint address in the `mint` field.

```
POST /wallets/me/actions/transfer
Authorization: Bearer YOUR_SESSION_TOKEN
```

**By symbol:**

```json
{
  "to": "RecipientSolanaAddress",
  "amount": 10,
  "mint": "USDC"
}
```

**By mint address:**

```json
{
  "to": "RecipientSolanaAddress",
  "amount": 10,
  "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
}
```

**Supported symbols (local):** SOL, USDC, USDT, PYUSD, USDG, JUP, BONK, WIF, POPCAT, PYTH, JTO, TNSR, W, RAY, ORCA, mSOL, jitoSOL, bSOL, wBTC, wETH.

Any other symbol is resolved via the Jupiter API (verified tokens only). If a symbol can't be resolved, the request is rejected with a clear error.

### Unwrap wSOL

Convert wrapped SOL (wSOL) back to native SOL. This is useful after trades that leave you with wSOL.

```
POST /wallets/me/actions/unwrap-sol
Authorization: Bearer YOUR_SESSION_TOKEN
```

**Request body:**

```json
{
  "amount": 0.01
}
```

- `amount` is optional. Omit it to unwrap ALL wSOL.
- No swap needed, no fees except the Solana network fee (~0.000005 SOL).

---

## 3. Token Trading (Jupiter)

Swap any token pair on Solana via Jupiter aggregator. Jupiter handles routing across all DEXs, MEV protection, slippage management, and optimal transaction landing.

```
POST /wallets/me/actions/trade
Authorization: Bearer YOUR_SESSION_TOKEN
```

**Request body:**

```json
{
  "from": "USDC",
  "to": "SOL",
  "amount": 10,
  "slippageBps": 50
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| from | string | Yes | Input token — symbol (e.g., "USDC") or mint address |
| to | string | Yes | Output token — symbol (e.g., "SOL") or mint address |
| amount | number | Yes | Amount of the input token to swap |
| slippageBps | number | No | Slippage tolerance in basis points. Default: 50 (0.5%). Range: 1–5000 |

**Example — swap SOL to USDC:**

```json
{
  "from": "SOL",
  "to": "USDC",
  "amount": 0.5,
  "slippageBps": 100
}
```

**Example — swap by mint address (for any token):**

```json
{
  "from": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "to": "So11111111111111111111111111111111111111112",
  "amount": 50,
  "slippageBps": 50
}
```

**Response:**

```json
{
  "data": {
    "signature": "5K8v...",
    "explorerUrl": "https://solscan.io/tx/5K8v...",
    "inputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "outputMint": "So11111111111111111111111111111111111111112",
    "inputAmount": "10 USDC",
    "outputAmount": "0.071428 SOL"
  }
}
```

---

## 4. Liquidity Provision (Meteora DLMM)

Provide liquidity to Meteora Dynamic Liquidity Market Maker (DLMM) pools and earn trading fees. Knot uses a custodial model: your tokens are transferred to Knot's managed wallet, which provisions liquidity on your behalf. You retain full ownership and can withdraw at any time.

### How It Works

1. **Add liquidity** — Your tokens are transferred to Knot, which deposits them into the pool on-chain
2. **Earn fees** — As trades happen in the pool, your position accumulates trading fees
3. **Claim rewards** — Claim accumulated fees anytime; they're sent directly to your wallet
4. **Remove liquidity** — Withdraw your position; proceeds are sent to your wallet

### Fee Structure

| Operation | Fee | Description |
|-----------|-----|-------------|
| Add liquidity | 1% + $0.10 flat | Applied to deposited token amounts |
| Remove liquidity | 1% | Deducted from returned token amounts |
| Claim rewards | 1% | Deducted from claimed fee amounts |

### List Available Pools

Discover DLMM pools to provide liquidity to.

```
GET /wallets/me/pools
Authorization: Bearer YOUR_SESSION_TOKEN
```

**Query parameters:**
| Param | Default | Description |
|-------|---------|-------------|
| tokenX | — | Filter by base token (symbol or mint) |
| tokenY | — | Filter by quote token (symbol or mint) |
| limit | 50 | Max results (max 50) |

> **Important:** Do not request more than 50 pools at a time (`limit` must be ≤ 50). Use `tokenX` and `tokenY` filters to narrow results instead of increasing the limit.

**Example:** `GET /wallets/me/pools?tokenX=SOL&tokenY=USDC`

### Get Pool Details

Get detailed info about a specific pool including active price, reserves, and APR.

```
GET /wallets/me/pools/:address
Authorization: Bearer YOUR_SESSION_TOKEN
```

**Example:** `GET /wallets/me/pools/9d9mb8kooFfaD3SctgZtkxQypkshx6ezhbKio89ixyy2`

### Get Your LP Positions

View all your liquidity positions.

```
GET /wallets/me/positions
Authorization: Bearer YOUR_SESSION_TOKEN
```

**Query parameters:**
| Param | Default | Description |
|-------|---------|-------------|
| status | — | Filter: `active` or `closed` |

### Get Position Details

Get detailed info about a specific position including on-chain data, current amounts, and pending rewards.

```
GET /wallets/me/positions/:positionId
Authorization: Bearer YOUR_SESSION_TOKEN
```

Use this to check if there are rewards to claim before calling claim-rewards.

Returns:
- `currentAmountX/Y` — Current token amounts in position
- `pendingFeeX/Y` — Unclaimed fees earned from trading
- `hasRewardsToClaim` — Boolean indicating if there are fees to claim
- `entryAmountX/Y` — Original amounts deposited

### Add Liquidity

Deposit tokens into a DLMM pool. Supports three liquidity modes:

| Mode | amountX | amountY | Bin Placement | Use Case |
|------|---------|---------|---------------|----------|
| Two-sided | > 0 | > 0 | Around active price | Standard LP, earn fees in both directions |
| One-sided X | > 0 | 0 | Above active price | Selling X at higher prices (limit-sell) |
| One-sided Y | 0 | > 0 | Below active price | Buying X at lower prices (DCA into X) |

```
POST /wallets/me/actions/add-liquidity
Authorization: Bearer YOUR_SESSION_TOKEN
```

**Two-sided example (provide both tokens):**

```json
{
  "pool": "9d9mb8kooFfaD3SctgZtkxQypkshx6ezhbKio89ixyy2",
  "amountX": 1.0,
  "amountY": 100.0,
  "strategy": "spot",
  "rangeWidth": 10
}
```

**One-sided X example (only base token, e.g., SOL):**

```json
{
  "pool": "9d9mb8kooFfaD3SctgZtkxQypkshx6ezhbKio89ixyy2",
  "amountX": 1.0,
  "amountY": 0,
  "strategy": "spot",
  "rangeWidth": 10
}
```

**One-sided Y example (only quote token, e.g., USDC):**

```json
{
  "pool": "9d9mb8kooFfaD3SctgZtkxQypkshx6ezhbKio89ixyy2",
  "amountX": 0,
  "amountY": 100.0,
  "strategy": "spot",
  "rangeWidth": 10
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| pool | string | Yes | — | Pool address (get from `GET /wallets/me/pools`) |
| amountX | number | Yes | — | Amount of base token (token X). Set 0 for one-sided Y |
| amountY | number | No | — | Amount of quote token (token Y). Set 0 for one-sided X |
| strategy | string | No | "spot" | Distribution: `spot` (uniform), `curve` (concentrated), `bidAsk` (asymmetric) |
| rangeWidth | number | No | 10 | Number of bins on each side of active price (1–100) |

At least one of `amountX` or `amountY` must be greater than zero. Minimum position value is $1 USD.

### Remove Liquidity

Withdraw your position from a pool. You can remove all or a partial percentage.

```
POST /wallets/me/actions/remove-liquidity
Authorization: Bearer YOUR_SESSION_TOKEN
```

**Request body:**

```json
{
  "positionId": "position-uuid-from-get-positions",
  "percentage": 100
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| positionId | string | Yes | — | Position UUID from `GET /wallets/me/positions` |
| percentage | number | No | 100 | Percentage to withdraw (1–100) |

A 1% exit fee is deducted from the returned amounts.

### Claim Rewards

Claim accumulated trading fees from a position. Fees accumulate as trades execute in the pool through your bin range.

```
POST /wallets/me/actions/claim-rewards
Authorization: Bearer YOUR_SESSION_TOKEN
```

**Request body:**

```json
{
  "positionId": "position-uuid-from-get-positions"
}
```

Check `GET /wallets/me/positions/:positionId` first to see if `hasRewardsToClaim` is `true`. A 1% platform fee is deducted from claimed rewards.

### Retry Withdrawal

If a remove-liquidity operation succeeded on-chain but the token transfer to your wallet failed, use this to retry.

```
POST /wallets/me/actions/retry-withdrawal
Authorization: Bearer YOUR_SESSION_TOKEN
```

**Request body:**

```json
{
  "positionId": "position-uuid-from-get-positions"
}
```

---

## 5. Prediction Markets (Kalshi)

Trade on regulated prediction markets via Kalshi. You don't need a Kalshi account — Knot manages it for you. Buy and sell contracts on events in crypto, sports, politics, economics, entertainment, and more.

### How It Works

1. **Discover** — Browse categories, events, and markets to find what to trade
2. **Buy contracts** — USDC is automatically transferred from your Solana wallet to fund the trade
3. **Sell contracts** — Proceeds (minus exit fee) are automatically sent to your Solana wallet
4. **Settlement** — When a market settles, winners receive $1.00 per contract automatically

**No separate deposit step.** USDC flows directly between your wallet and the prediction platform when you buy or sell.

### Understanding Prices

- Contract prices range from $0.01 to $0.99, representing implied probability
- **Buy YES at $0.65** — Pay $0.65 to win $1.00 if the outcome is YES (65% implied probability)
- **Buy NO at $0.35** — Pay $0.35 to win $1.00 if the outcome is NO (35% implied probability)
- YES price + NO price = $1.00 always

### Fee Structure

| Operation | Fee |
|-----------|-----|
| Buy contracts | 1% of total cost |
| Sell contracts | 1% of proceeds |
| Settlement payout | No fee |

---

### Market Discovery

These endpoints help you find markets to trade. They are read-only and do not cost anything.

#### Get Categories

Returns all available market categories and their sub-tags. Use these to filter events and series.

```
GET /predictions/categories
Authorization: Bearer YOUR_SESSION_TOKEN
```

**Response (example):**

```json
{
  "data": {
    "Sports": ["Soccer", "Basketball", "Baseball", "Football", "Hockey", "Golf", "Tennis"],
    "Crypto": ["BTC", "ETH", "SOL", "DOGE", "XRP"],
    "Politics": ["US Elections", "Primaries", "Trump", "Foreign Elections"],
    "Financials": ["S&P", "Nasdaq", "Daily", "Treasuries"],
    "Economics": ["Growth", "Fed", "Inflation", "Employment"],
    "Entertainment": ["Music", "Movies", "Awards", "Television"],
    "Science and Technology": ["AI", "Space", "Energy"],
    "Climate and Weather": ["Daily temperature", "Hurricanes", "Natural disasters"]
  }
}
```

#### Get Sports Filters

Get sports-specific filters with competitions and scopes. Use this to navigate sports markets (e.g., find all Champions League soccer markets).

```
GET /predictions/sports
Authorization: Bearer YOUR_SESSION_TOKEN
```

#### List Markets

Browse prediction markets with filtering and pagination. Each market has a unique `ticker` used for trading.

```
GET /predictions/markets
Authorization: Bearer YOUR_SESSION_TOKEN
```

**Query parameters:**
| Param | Default | Description |
|-------|---------|-------------|
| status | — | `unopened`, `open`, `closed`, `settled` |
| event_ticker | — | Filter by parent event ticker |
| series_ticker | — | Filter by series ticker (e.g., `KXBTC` for Bitcoin markets) |
| limit | 50 | Max results |
| cursor | — | Pagination cursor from previous response |
| tradeable_only | — | Set `true` to filter out illiquid markets (zero liquidity) |

**Example:** `GET /predictions/markets?series_ticker=KXBTC&status=open&limit=20`

#### Get Market Details

```
GET /predictions/markets/:ticker
Authorization: Bearer YOUR_SESSION_TOKEN
```

**Example:** `GET /predictions/markets/KXBTC-24DEC31-T100000`

Returns full market data including prices, volume, liquidity, open interest, close time, and result (if settled). Check that `liquidity > 0` before attempting to trade.

#### Get Orderbook

See the current buy/sell orders for a market.

```
GET /predictions/markets/:ticker/orderbook
Authorization: Bearer YOUR_SESSION_TOKEN
```

**Query parameters:**
| Param | Default | Description |
|-------|---------|-------------|
| depth | — | Number of price levels to return |

**Example:** `GET /predictions/markets/KXBTC-24DEC31-T100000/orderbook?depth=10`

#### List Events

Events group related markets together (e.g., "Will BTC hit $100K by Dec 2024?" contains multiple strike-price markets).

```
GET /predictions/events
Authorization: Bearer YOUR_SESSION_TOKEN
```

**Query parameters:**
| Param | Default | Description |
|-------|---------|-------------|
| status | — | `open`, `closed`, `settled` |
| series_ticker | — | Filter by series |
| category | — | Top-level category (e.g., `Sports`, `Crypto`) |
| limit | 20 | Max results |
| cursor | — | Pagination cursor |
| active_markets_only | — | Set `true` to only return events with tradeable markets |

**Example:** `GET /predictions/events?category=Crypto&status=open&limit=10`

#### Get Event Details

```
GET /predictions/events/:eventTicker
Authorization: Bearer YOUR_SESSION_TOKEN
```

#### List Series

A series is a recurring collection of events (e.g., "Bitcoin Price" series contains daily/weekly/monthly BTC price events).

```
GET /predictions/series
Authorization: Bearer YOUR_SESSION_TOKEN
```

**Query parameters:**
| Param | Default | Description |
|-------|---------|-------------|
| category | — | Filter by category (e.g., `Crypto`, `Sports`) |
| tags | — | Filter by tags (comma-separated) |
| include_product_metadata | — | Set `true` for additional metadata |
| include_volume | — | Set `true` for total traded volume |
| limit | 100 | Max results |
| cursor | — | Pagination cursor |

**Example:** `GET /predictions/series?category=Crypto&include_volume=true`

#### Get Series Details

```
GET /predictions/series/:seriesTicker
Authorization: Bearer YOUR_SESSION_TOKEN
```

**Example:** `GET /predictions/series/KXBTC`

#### List Milestones

Milestones represent upcoming real-world events (games, matches, announcements) that have associated prediction markets. Use this to find what is happening and what you can trade on.

```
GET /predictions/milestones
Authorization: Bearer YOUR_SESSION_TOKEN
```

**Query parameters:**
| Param | Default | Description |
|-------|---------|-------------|
| limit | 100 | Max results (1–500) |
| minimum_start_date | Today (UTC) | Only return milestones starting after this date (RFC3339) |
| category | — | Top-level category: `Sports`, `Crypto`, `Financials`, etc. |
| competition | — | Specific competition: `Champions League`, `Premier League`, `NBA`, etc. |
| type | — | Milestone type filter |
| related_event_ticker | — | Filter by related event ticker |
| cursor | — | Pagination cursor |
| min_updated_ts | — | Unix timestamp — only milestones updated after this |

**Important:** `category` is a top-level category like `Sports` or `Crypto` (get the full list from `GET /predictions/categories`). Use `competition` to drill into specific leagues/tournaments.

**Example — find upcoming Champions League matches:**

`GET /predictions/milestones?category=Sports&competition=Champions%20League`

Each milestone contains `related_event_tickers` that link to tradeable events.

#### Get Milestone Details

```
GET /predictions/milestones/:milestoneId
Authorization: Bearer YOUR_SESSION_TOKEN
```

#### List Structured Targets

Structured targets represent specific measurable outcomes (e.g., score targets, price levels) for competitions.

```
GET /predictions/structured-targets
Authorization: Bearer YOUR_SESSION_TOKEN
```

**Query parameters:**
| Param | Default | Description |
|-------|---------|-------------|
| type | — | Filter by target type |
| competition | — | Filter by competition (e.g., `Champions League`) |
| page_size | 100 | Results per page (1–2000) |
| cursor | — | Pagination cursor |

#### Get Structured Target Details

```
GET /predictions/structured-targets/:structuredTargetId
Authorization: Bearer YOUR_SESSION_TOKEN
```

---

### Trading

#### Buy Contracts

Place a buy order. USDC is automatically transferred from your Solana wallet to cover the cost plus entry fee.

```
POST /predictions/buy
Authorization: Bearer YOUR_SESSION_TOKEN
```

**Request body:**

```json
{
  "ticker": "KXBTC-24DEC31-T100000",
  "side": "yes",
  "count": 10
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| ticker | string | Yes | Market ticker (get from market listing endpoints) |
| side | string | Yes | `yes` or `no` |
| count | number | Yes | Number of contracts to buy (positive integer) |

**What happens:**
1. The best available ask price for the chosen side is used
2. USDC equal to (price x count) + 1% fee is transferred from your wallet
3. The buy order executes on the exchange
4. You receive `count` contracts

#### Sell Contracts

Sell contracts you own. Proceeds (minus exit fee) are automatically sent to your Solana wallet as USDC.

```
POST /predictions/sell
Authorization: Bearer YOUR_SESSION_TOKEN
```

**Request body:**

```json
{
  "ticker": "KXBTC-24DEC31-T100000",
  "side": "yes",
  "count": 5
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| ticker | string | Yes | Market ticker |
| side | string | Yes | `yes` or `no` — must match the side you hold |
| count | number | Yes | Number of contracts to sell (positive integer) |

**What happens:**
1. The sell order executes at the best available bid price
2. Proceeds minus 1% exit fee are converted to USDC
3. USDC is transferred to your Solana wallet

---

### Prediction Balance

Your prediction balance is managed separately from your Solana wallet. You can withdraw it to USDC on your wallet at any time.

#### Get Prediction Balance

```
GET /predictions/balance
Authorization: Bearer YOUR_SESSION_TOKEN
```

#### Withdraw to Wallet

Withdraw USDC from your prediction balance to your Solana wallet.

```
POST /predictions/withdraw
Authorization: Bearer YOUR_SESSION_TOKEN
```

**Request body:**

```json
{
  "amountDollars": 25.0
}
```

---

### Positions & Orders

#### Get Your Positions

View your current prediction market positions with unrealized P&L.

```
GET /predictions/positions
Authorization: Bearer YOUR_SESSION_TOKEN
```

**Query parameters:**
| Param | Default | Description |
|-------|---------|-------------|
| settled | — | `true` (settled only), `false` (open only), omit for all |

#### Get Your Order History

```
GET /predictions/orders
Authorization: Bearer YOUR_SESSION_TOKEN
```

**Query parameters:**
| Param | Default | Description |
|-------|---------|-------------|
| ticker | — | Filter by market ticker |
| limit | 50 | Max results |

---

### Recommended Workflow: Finding and Trading a Market

Here is a step-by-step example of how to find and trade a Champions League match:

1. **Get categories** to confirm "Sports" exists:
   `GET /predictions/categories`

2. **Find upcoming matches** using milestones:
   `GET /predictions/milestones?category=Sports&competition=Champions%20League`

3. **Get the related event** using `related_event_tickers` from the milestone:
   `GET /predictions/events/SOME-EVENT-TICKER`

4. **Browse the event's markets** — each event contains multiple markets:
   `GET /predictions/markets?event_ticker=SOME-EVENT-TICKER&tradeable_only=true`

5. **Check the orderbook** to see prices and liquidity:
   `GET /predictions/markets/SOME-MARKET-TICKER/orderbook`

6. **Buy contracts** on the outcome you expect:
   `POST /predictions/buy` with body `{ "ticker": "SOME-MARKET-TICKER", "side": "yes", "count": 5 }`

7. **Monitor your position**:
   `GET /predictions/positions`

8. **Sell before settlement** (to lock in profit) or **wait for settlement** (to receive $1.00 per winning contract):
   `POST /predictions/sell` with body `{ "ticker": "SOME-MARKET-TICKER", "side": "yes", "count": 5 }`

---

## 6. Policy & Spend Limits

Every wallet has a policy that enforces spend limits and feature toggles. Policies are checked before every transaction is built or signed.

### Get Current Policy

```
GET /wallets/me/policy
Authorization: Bearer YOUR_SESSION_TOKEN
```

### Update Policy

Only include the fields you want to change. All fields are optional.

```
PATCH /wallets/me/policy
Authorization: Bearer YOUR_SESSION_TOKEN
```

**Request body (all fields optional):**

```json
{
  "maxSingleTransactionInUsd": 100,
  "dailyLimitInUsd": 500,
  "allowedRecipients": [],
  "allowTrading": true,
  "allowLiquidityProvision": true,
  "allowPredictionMarkets": true,
  "sessionExpirationHours": 168
}
```

### Policy Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| maxSingleTransactionInUsd | number | 100 | Max USD value per transaction (transfers, trades, LP deposits). Does not apply to removing liquidity |
| dailyLimitInUsd | number | 500 | Rolling 24-hour USD limit across all outbound operations. Does not apply to removing liquidity |
| allowedRecipients | string[] | [] | Whitelist of allowed transfer recipient addresses. Empty array means all addresses are allowed |
| allowTrading | boolean | true | Enable/disable token swaps via Jupiter |
| allowLiquidityProvision | boolean | true | Enable/disable Meteora DLMM operations |
| allowPredictionMarkets | boolean | true | Enable/disable Kalshi prediction trading |
| sessionExpirationHours | number | 168 | Session token lifetime in hours (168 = 7 days). Range: 1–8760 (1 hour to 1 year) |

---

## 7. Token Info Lookup

Look up any Solana token's metadata by symbol or mint address. Checks local directory first, then Jupiter API, then Helius DAS API.

```
GET /tokens/:query
Authorization: Bearer YOUR_SESSION_TOKEN
```

**By symbol:**

```
GET /tokens/USDC
```

**By mint address:**

```
GET /tokens/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
```

**Response:**

```json
{
  "data": {
    "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "symbol": "USDC",
    "name": "USD Coin",
    "decimals": 6,
    "verified": true,
    "source": "local"
  }
}
```

---

## 8. Rate Limits

Knot enforces rate limits to protect the service. All responses include rate limit headers:

| Header | Description |
|---|---|
| `X-RateLimit-Limit` | Maximum requests allowed in the window |
| `X-RateLimit-Remaining` | Requests remaining in the current window |
| `Retry-After` | Seconds to wait before retrying (only on 429) |

**Limits by endpoint:**

| Scope | Limit |
|---|---|
| Global (per IP) | 100 requests / minute |
| `POST /connect/start` (per email) | 3 requests / 10 minutes (escalates on repeated abuse: 1h → 6h → 24h) |
| `POST /connect/complete` (per OTP) | 5 attempts / 10 minutes |
| Authenticated endpoints (per agent) | 30 requests / minute |

When rate limited, you receive:

```json
{
  "status": false,
  "statusCode": 429,
  "message": "Too many requests. Please try again later.",
  "data": {
    "code": "RATE_LIMIT_EXCEEDED",
    "retryAfterSeconds": 42
  }
}
```

**OTP escalation:** If you exhaust the OTP start limit multiple times without completing authentication, the cooldown escalates: 10 min → 1 hour → 6 hours → 24 hours. Successfully completing authentication resets the cooldown.

---

## 9. Idempotency

All financial mutation endpoints support an optional `Idempotency-Key` header to prevent duplicate execution. **You are strongly encouraged to include it on every mutation request** — it protects against double-spending when retrying after timeouts or network errors.

**How to use:** Send an `Idempotency-Key` header with a unique value (UUID recommended) on every mutation request.

```
POST /wallets/me/actions/transfer
Authorization: Bearer YOUR_SESSION_TOKEN
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
```

**Behavior:**

| Scenario | Result |
|---|---|
| First request with key | Executes normally. Response cached for 24 hours. |
| Same key again | Returns cached response instantly (header: `Idempotency-Status: cached`). |
| Same key, concurrent request | Returns `409 Conflict` — wait and retry. |
| No key provided | Request executes normally without idempotency protection. |

**Supported endpoints:**
- `POST /wallets/me/actions/transfer`
- `POST /wallets/me/actions/unwrap-sol`
- `POST /wallets/me/actions/trade`
- `POST /wallets/me/actions/add-liquidity`
- `POST /wallets/me/actions/remove-liquidity`
- `POST /wallets/me/actions/claim-rewards`
- `POST /wallets/me/actions/retry-withdrawal`
- `POST /predictions/buy`
- `POST /predictions/sell`
- `POST /predictions/withdraw`

Keys are scoped per agent — the same key used by different agents won't collide.

**Best practice:** Generate a new UUID for each distinct operation. If your request times out or you get a network error, retry with the **same key** to safely avoid double-spending.

---

## Rules

- **Never share your sessionToken** in logs, forum posts, repos, or with other agents. Treat it like a password.
- **Confirm amount + recipient** before any transfer or trade.
- **If a transaction is rejected by policy**, report it clearly — do not retry with a larger amount or different parameters to bypass the limit.
- **Your Solana address is public** — you can share it freely to receive tokens.
- **Check balances** before submitting transfers or trades to avoid failed transactions.
- **Check market liquidity** before buying prediction contracts — if `liquidity` is 0, there are no orders to fill.
- **Always include `Idempotency-Key`** on transfers, trades, and LP/prediction operations — it is optional but strongly recommended to prevent double-execution on retries.
- **Respect rate limits** — check `Retry-After` header and wait the indicated time before retrying.
