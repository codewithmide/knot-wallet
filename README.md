# Knot

**Server-side Solana wallet infrastructure for AI agents.**

Knot gives AI agents a Solana wallet they can use through REST — no browser extension, no popups, no private keys. Keys live inside [Turnkey's TEE](https://turnkey.com) (Trusted Execution Environment) and never leave the enclave. Agents authenticate with email OTP, receive a JWT, and call action-based endpoints to transfer tokens, swap on Jupiter, provide liquidity on Meteora, and trade prediction markets on Kalshi.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  AI Agent                                                    │
│  reads /skill.md  →  understands capabilities                │
│  calls REST API with Bearer token                            │
└────────────────────────────┬─────────────────────────────────┘
                             │  HTTPS + JWT
                             ▼
┌──────────────────────────────────────────────────────────────┐
│  Knot API  (Hono + Node.js)                                 │
│                                                              │
│  Auth Layer       →  email OTP  →  issues JWT                │
│  Policy Engine    →  enforces spend limits before signing    │
│  Action Layer     →  transfer / trade / LP / predictions     │
│  Audit Logger     →  every action logged to PostgreSQL       │
│  Rate Limiter     →  sliding window, per-IP + per-agent      │
└──────────┬──────────────┬──────────────┬─────────────────────┘
           │              │              │
     Turnkey TEE     Jupiter API    Kalshi API
     (signing)       (swaps)       (predictions)
           │              │              │
           ▼              ▼              ▼
┌──────────────────────────────────────────────────────────────┐
│  Solana  (mainnet-beta via Helius RPC)                       │
│  Meteora DLMM  (on-chain liquidity pools)                    │
└──────────────────────────────────────────────────────────────┘
```

### Request Flow

```
Agent  →  POST /wallets/me/actions/trade
       →  Rate limit check
       →  JWT verification
       →  Policy engine (within daily limits?)
       →  Build unsigned transaction
       →  Send to Turnkey TEE for signing
       →  Broadcast via Helius RPC
       →  Audit log written
       →  Return { signature, explorerUrl }
```

---

## Features

| Feature | Description |
|---|---|
| **Wallet per agent** | Each agent gets a dedicated Solana wallet in a Turnkey sub-organization |
| **Token transfers** | Send/receive SOL and any SPL token |
| **Jupiter swaps** | Trade any token pair via Jupiter aggregator with MEV protection |
| **Meteora DLMM** | Provide liquidity to concentrated liquidity pools (custodial) |
| **Kalshi predictions** | Buy/sell prediction market contracts (custodial USDC flow) |
| **Policy engine** | Per-agent spend limits, daily caps, recipient whitelists |
| **Rate limiting** | In-memory sliding window — global, per-IP, per-agent, and OTP-specific |
| **Idempotency** | Optional deduplication on financial mutations via `Idempotency-Key` header |
| **Audit trail** | Every action logged with USD-normalised amounts |
| **skill.md** | Machine-readable API documentation — [api.useknot.xyz/skill.md](https://api.useknot.xyz/skill.md) |
| **Website** | [useknot.xyz](https://www.useknot.xyz/) |
| **Graceful shutdown** | Clean SIGTERM/SIGINT handling with DB disconnect |
| **OTP cleanup** | Automatic periodic purge of expired OTP codes |

---

## Tech Stack

| Concern | Choice |
|---|---|
| Runtime | Node.js 22 + TypeScript (ESM) |
| Framework | [Hono](https://hono.dev) |
| Key Management | [Turnkey](https://turnkey.com) — `@turnkey/sdk-server` + `@turnkey/solana` |
| Solana SDK | `@solana/web3.js` v1 + `@solana/spl-token` |
| Trading | Jupiter Ultra API |
| Liquidity | Meteora DLMM SDK (`@meteora-ag/dlmm`) |
| Predictions | Kalshi REST API (RSA-PSS-SHA256 auth) |
| RPC | [Helius](https://helius.dev) |
| Database | PostgreSQL via [Prisma](https://prisma.io) |
| Validation | [Zod](https://zod.dev) |
| Logging | [Pino](https://getpino.io) (structured JSON) |
| Auth | Email OTP → JWT |

---

## Project Structure

```
knot/
├── src/
│   ├── index.ts                    # Hono app, server, shutdown, OTP cleanup
│   ├── config.ts                   # Env validation (envalid)
│   │
│   ├── auth/
│   │   ├── middleware.ts           # JWT auth middleware
│   │   └── turnkey-auth.ts         # OTP generation, Turnkey sub-org provisioning
│   │
│   ├── turnkey/
│   │   ├── client.ts              # Turnkey SDK client singleton
│   │   ├── wallet.ts              # Wallet provisioning & lookup
│   │   └── signer.ts             # Sign + broadcast (agent & admin)
│   │
│   ├── actions/
│   │   ├── transfer.ts            # SOL + SPL token transfers
│   │   ├── trade.ts               # Jupiter swaps
│   │   ├── liquidity.ts           # Meteora LP actions
│   │   ├── kalshi.ts              # Kalshi market discovery
│   │   └── simulate.ts           # Dry-run transaction simulation
│   │
│   ├── services/
│   │   ├── liquidity/             # LP business logic (10 modules)
│   │   │   ├── index.ts           #   barrel export
│   │   │   ├── types.ts           #   constants + interfaces
│   │   │   ├── meteora.ts         #   Meteora SDK helpers
│   │   │   ├── pools.ts           #   pool discovery
│   │   │   ├── transfers.ts       #   token transfer helpers
│   │   │   ├── add.ts             #   add liquidity
│   │   │   ├── remove.ts          #   remove liquidity
│   │   │   ├── rewards.ts         #   claim rewards
│   │   │   ├── positions.ts       #   position tracking
│   │   │   └── retry.ts           #   failed transfer retry
│   │   │
│   │   └── predictions/           # Prediction market logic (9 modules)
│   │       ├── index.ts           #   barrel export
│   │       ├── types.ts           #   constants + interfaces
│   │       ├── balance.ts         #   balance management
│   │       ├── transfers.ts       #   custodial USDC transfers
│   │       ├── deposits.ts        #   fund prediction balance
│   │       ├── withdrawals.ts     #   withdraw to wallet
│   │       ├── trading.ts         #   buy/sell contracts
│   │       ├── positions.ts       #   position + order tracking
│   │       └── settlement.ts      #   market settlement
│   │
│   ├── routes/
│   │   ├── connect.ts             # POST /connect/start, /connect/complete
│   │   ├── actions.ts             # POST /wallets/me/actions/*
│   │   ├── policy.ts              # GET/PATCH /wallets/me/policy
│   │   ├── predictions.ts         # /predictions/* (agent-facing)
│   │   ├── tokens.ts              # GET /tokens/info, /tokens/price
│   │   ├── stats.ts               # GET /stats (authenticated)
│   │   ├── webhooks.ts            # POST /webhooks/helius
│   │   └── admin/                 # Admin routes (9 modules)
│   │       ├── index.ts
│   │       ├── auth.ts
│   │       ├── wallet.ts
│   │       ├── agents.ts
│   │       ├── predictions.ts
│   │       ├── liquidity.ts
│   │       ├── referral.ts
│   │       ├── transactions.ts
│   │       └── dashboard.ts
│   │
│   ├── kalshi/
│   │   └── client.ts              # Kalshi API client (RSA-PSS-SHA256)
│   │
│   ├── policy/
│   │   ├── engine.ts              # Policy check before every action
│   │   └── types.ts               # Policy interfaces + defaults
│   │
│   ├── db/
│   │   └── prisma.ts              # Prisma client singleton
│   │
│   └── utils/
│       ├── logger.ts              # Pino logger wrapper
│       ├── errors.ts              # AppError + HTTP mapping
│       ├── response.ts            # Standardised JSON envelope
│       ├── audit.ts               # Audit log helper
│       ├── balances.ts            # SOL + SPL balance fetching
│       ├── email.ts               # OTP email via Mailtrap / SMTP
│       ├── helius.ts              # Helius webhook setup
│       ├── pricing.ts             # Jupiter Price API v3
│       ├── tokens.ts              # Token metadata lookup
│       ├── rate-limit.ts          # In-memory sliding window rate limiter
│       ├── idempotency.ts         # Optional idempotency middleware
│       └── stats-cache.ts         # Aggregated platform stats
│
├── prisma/
│   └── schema.prisma              # Database schema (15 models)
│
├── public/
│   └── skill.md                   # Machine-readable API docs (served at /skill.md)
│
├── scripts/
│   ├── delete-agent.ts            # Admin: delete agent by email
│   └── migrate-withdraw-funds.ts  # Admin: migrate custodial funds
│
├── .env.example
├── package.json
└── tsconfig.json
```

---

## Getting Started

### Prerequisites

- **Node.js** 22+
- **PostgreSQL** 15+
- **Turnkey account** — [turnkey.com](https://turnkey.com)
- **Helius API key** — [helius.dev](https://helius.dev)
- **Jupiter API key** — [station.jup.ag](https://station.jup.ag)

### Installation

```bash
# Clone
git clone https://github.com/user/knot.git
cd knot

# Install dependencies (runs patch-package + prisma generate)
npm install

# Copy env and fill in values
cp .env.example .env

# Push schema to database
npx prisma db push

# Start dev server
npm run dev
```

### Production

```bash
npm run build
npx prisma db push
npm start       # runs node dist/index.js
```

---

## Environment Variables

Copy `.env.example` to `.env` and fill in the values. See the table below for all variables:

| Variable | Required | Default | Description |
|---|---|---|---|
| `TURNKEY_API_PUBLIC_KEY` | Yes | — | Turnkey parent org API public key |
| `TURNKEY_API_PRIVATE_KEY` | Yes | — | Turnkey parent org API private key |
| `TURNKEY_ORGANIZATION_ID` | Yes | — | Turnkey organization ID |
| `TURNKEY_DELEGATED_API_PUBLIC_KEY` | Yes | — | Delegated signing public key (added to sub-orgs) |
| `TURNKEY_DELEGATED_API_PRIVATE_KEY` | Yes | — | Delegated signing private key |
| `HELIUS_API_KEY` | Yes | — | Helius RPC API key |
| `HELIUS_WEBHOOK_SECRET` | Yes | — | Secret for verifying Helius webhook payloads |
| `JUPITER_API_KEY` | Yes | — | Jupiter API key for swaps + pricing |
| `JUPITER_REFERRAL_ACCOUNT` | No | `""` | Jupiter referral account public key |
| `KALSHI_API_KEY_ID` | No | `""` | Kalshi API key ID (enables predictions) |
| `KALSHI_RSA_PRIVATE_KEY` | No | `""` | Kalshi RSA private key (PEM format) |
| `KALSHI_API_BASE_URL` | No | `https://api.elections.kalshi.com/trade-api/v2` | Kalshi API base URL |
| `KNOT_KALSHI_ADMIN_KEY_ID` | No | `""` | Turnkey key ID for prediction admin wallet |
| `KNOT_KALSHI_ADMIN_WALLET_ADDRESS` | No | `""` | Solana address of prediction admin wallet |
| `KNOT_METEORA_ADMIN_KEY_ID` | No | `""` | Turnkey key ID for LP admin wallet |
| `KNOT_METEORA_ADMIN_WALLET_ADDRESS` | No | `""` | Solana address of LP admin wallet |
| `KNOT_FEE_WALLET_ADDRESS` | No | `""` | Wallet that receives platform fees |
| `STATS_API_SECRET` | Yes | — | Secret for authenticating stats endpoint |
| `STATS_TOKEN_TTL_SECONDS` | No | `300` | Stats token TTL (seconds) |
| `JWT_SECRET` | Yes | — | Secret for signing JWT session tokens |
| `OTP_TTL_MINUTES` | No | `10` | OTP code expiration (minutes) |
| `ADMIN_EMAILS` | No | `codewithmide@gmail.com` | Comma-separated admin email addresses |
| `MAILTRAP_API_KEY` | Yes | — | Mailtrap API key for sending OTP emails |
| `SMTP_HOST` | No | `""` | SMTP host (fallback email transport) |
| `SMTP_PORT` | No | `587` | SMTP port |
| `SMTP_USERNAME` | No | `""` | SMTP username |
| `SMTP_PASS` | No | `""` | SMTP password |
| `SOLANA_NETWORK` | No | `mainnet-beta` | `mainnet-beta` or `devnet` |
| `SOLANA_RPC_URL` | No | `""` | Custom RPC URL (overrides Helius) |
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `PORT` | No | `3000` | Server port |
| `API_BASE_URL` | No | `http://localhost:3000` | Public base URL |
| `LOG_LEVEL` | No | `info` | Pino log level (`trace`/`debug`/`info`/`warn`/`error`/`fatal`/`silent`) |

---

## API Overview

All responses use a standard envelope:

```json
{
  "status": true,
  "statusCode": 200,
  "message": "Human-readable message.",
  "data": { ... }
}
```

### Authentication

```
POST /connect/start              # Send OTP to email
POST /connect/complete           # Verify OTP → get JWT + wallet address
```

### Wallet Operations

```
GET  /wallets/me/balances        # SOL + all SPL token balances
POST /wallets/me/actions/transfer-solana    # Transfer SOL or SPL tokens
POST /wallets/me/actions/trade              # Swap via Jupiter
POST /wallets/me/actions/sign-message       # Sign arbitrary message
```

### Liquidity (Meteora DLMM)

```
GET  /wallets/me/actions/liquidity/pools                 # Discover pools
POST /wallets/me/actions/liquidity/add                   # Add liquidity
POST /wallets/me/actions/liquidity/remove                # Remove liquidity
POST /wallets/me/actions/liquidity/claim-rewards         # Claim rewards
GET  /wallets/me/actions/liquidity/positions              # View positions
```

### Prediction Markets (Kalshi)

```
GET  /predictions/markets                  # List markets
GET  /predictions/markets/:ticker          # Market detail
POST /predictions/deposit/initiate         # Initiate USDC deposit
POST /wallets/me/actions/fund-predictions  # Complete deposit (on-chain)
POST /predictions/buy                      # Buy contracts
POST /predictions/sell                     # Sell contracts
GET  /predictions/positions                # View positions
POST /predictions/withdraw                 # Withdraw to wallet
```

### Policy & Limits

```
GET   /wallets/me/policy          # View current policy
PATCH /wallets/me/policy          # Update policy
```

### Utility

```
GET  /health                      # Health check
GET  /skill.md                    # Machine-readable API docs
GET  /tokens/info?symbol=SOL      # Token metadata
GET  /tokens/price?ids=SOL,USDC   # Token prices (Jupiter v3)
```

> Full endpoint documentation with request/response examples is served at **GET /skill.md** (1,100+ lines).

---

## Database

Knot uses PostgreSQL via Prisma ORM. The schema contains 15 models:

```
┌─────────────────┐     ┌──────────────────┐     ┌────────────┐
│     Agent        │────▶│   AgentPolicy    │     │  OtpCode   │
│                  │     └──────────────────┘     └────────────┘
│  email           │
│  solanaAddress   │     ┌──────────────────┐
│  turnkeySubOrgId │────▶│    AuditLog      │
└────────┬─────────┘     └──────────────────┘
         │
         │  Predictions                    Liquidity
         │
         ▼                                 ▼
┌──────────────────┐              ┌──────────────────────┐
│PredictionBalance │              │ LiquidityPosition    │
│                  │              │                      │
│  deposits[]      │              │  poolAddress         │
│  withdrawals[]   │              │  positionPubkey      │
│  orders[]        │              │  strategy            │
│  positions[]     │              └──────────────────────┘
└──────────────────┘
                                  ┌──────────────────────┐
┌──────────────────┐              │ LiquidityDeposit     │
│PendingPrediction │              ├──────────────────────┤
│    Deposit       │              │ LiquidityWithdrawal  │
└──────────────────┘              ├──────────────────────┤
                                  │ LiquidityRewardClaim │
┌──────────────────┐              └──────────────────────┘
│   StatsCache     │
└──────────────────┘
```

### Common Commands

```bash
npx prisma db push       # Push schema to database (no migration)
npx prisma migrate dev   # Create + apply migration
npx prisma studio        # Open visual DB browser
npx prisma generate      # Regenerate Prisma client
```

---

## Security

- **Private keys never leave Turnkey's TEE** — the server never sees raw key material
- **Policy engine** runs before every transaction is built
- **External transactions** are simulated before signing; suspicious patterns are rejected
- **Rate limiting** on all endpoints — escalating cooldowns on OTP brute-force attempts
- **JWT tokens** are the only auth mechanism — no API keys in query params
- **All inputs** validated with Zod before processing
- **Audit log** records every action regardless of success/failure
- **OTP codes** are single-use with TTL; stale codes are purged automatically
- **Graceful shutdown** ensures DB connections are closed cleanly on SIGTERM

---

## Scripts

```bash
npm run dev          # Start dev server with hot reload (tsx watch)
npm run build        # Compile TypeScript to dist/
npm start            # Run production server
npm run db:push      # Push Prisma schema to DB
npm run db:migrate   # Create migration
npm run db:studio    # Open Prisma Studio
npm run db:generate  # Regenerate Prisma client
```

---
