# CyclAwps Node

Autonomous intelligence node for Solana. Runs a swarm of specialized AI agents that discover, evaluate, enter, monitor, and exit token positions — learning from every trade.

Each node contributes raw on-chain observations to a shared intelligence layer. Every node benefits from the collective. Strategy stays private. Intelligence is shared.

Built on top of the [CyclAwps](https://github.com/controlborgs/cyclawps) core engine.

## Architecture

```
 ┌──────────────────────────────────────────┐
 │         Shared Intelligence Layer        │
 │     (Redis Streams across all nodes)     │
 │                                          │
 │  Deployer Scores │ Wallet Graph          │
 │  Rug Signals     │ Pattern Database      │
 └─────────┬────────────────────┬───────────┘
           │                    │
    ┌──────┴──────┐      ┌─────┴───────┐
    │   Node A    │      │   Node B    │
    └──────┬──────┘      └─────┬───────┘
           │                   │
   ┌───────┴───────────────────┘
   │
   │  Scout ──▶ Analyst ──▶ Strategist ──▶ Executor
   │                                          │
   │  Sentinel ───────────────────────────────┘
   │       │
   │  Memory ◀─── (outcomes from all agents)
   │
```

## Agents

| Agent | Role | LLM | Tick |
|-------|------|-----|------|
| **Scout** | Crawls PumpFun for new launches, scores deployers, builds watchlist | No | 3s |
| **Analyst** | Deep token analysis — conviction scoring, risk profiling | Yes | 2s |
| **Strategist** | Portfolio-level decisions — position sizing, entry/skip | Yes | 2s |
| **Sentinel** | Monitors open positions for threats — dev sells, LP removal, graph changes | Yes | 5s |
| **Executor** | Builds, simulates, and sends transactions with priority queuing | No | 1s |
| **Memory** | Records outcomes, tracks P&L, feeds learning back to agents | No | 10s |

## Intelligence Layer

Every node contributes to and reads from a shared intelligence network:

- **IntelBus** — Redis Streams for durable, ordered signal publishing across nodes
- **DeployerScoreEngine** — Aggregated deployer reputation (rug rate, launch history, wallet clusters)
- **WalletGraph** — Directed graph of wallet relationships with BFS cluster detection
- **PatternDatabase** — Historical patterns with outcomes, queryable by agents before decisions

## Dual Mode

The node runs in two modes:

- **Policy mode** (`SWARM_ENABLED=false`) — static rule-based automation, no LLM required. Uses the core [PolicyEngine](https://github.com/controlborgs/cyclawps#policy-engine) and [RiskEngine](https://github.com/controlborgs/cyclawps#risk-engine) only.
- **Swarm mode** (`SWARM_ENABLED=true`) — all six agents active, LLM reasoning enabled, intelligence layer connected.

## Quick Start

```bash
# Clone
git clone https://github.com/controlborgs/cyclawps-node.git
cd cyclawps-node

# Dependencies
npm install

# Start Postgres and Redis
docker compose up -d postgres redis

# Configure
cp .env.example .env
```

Edit `.env` with your keys:

```bash
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_WS_URL=wss://api.mainnet-beta.solana.com
WALLET_PRIVATE_KEY=<base64-encoded-keypair>
DATABASE_URL=postgresql://clawops:clawops@localhost:5432/clawops
REDIS_URL=redis://localhost:6379

# Enable agent swarm
SWARM_ENABLED=true
LLM_API_KEY=sk-ant-...
LLM_MODEL=claude-sonnet-4-5-20250929
```

```bash
# Run migrations
npx prisma migrate dev

# Start
npm run dev
```

## Usage

**Track a token:**

```bash
curl -X POST http://localhost:3100/wallets/:walletId/tokens \
  -H "Content-Type: application/json" \
  -d '{
    "mintAddress": "FKPvoUKtnWwPi73SGLQrAux9DeP9RD8eGqrzcwynpump",
    "devWalletAddress": "optional-dev-wallet-address"
  }'
```

**Open a position via PumpFun bonding curve:**

```bash
curl -X POST http://localhost:3100/positions \
  -H "Content-Type: application/json" \
  -d '{
    "walletId": "your-wallet-uuid",
    "mintAddress": "FKPvoUKtnWwPi73SGLQrAux9DeP9RD8eGqrzcwynpump",
    "solAmount": 0.5,
    "maxSlippageBps": 300,
    "priorityFeeLamports": 50000
  }'
```

**Set up a policy for auto-exit:**

```bash
curl -X POST http://localhost:3100/policies \
  -H "Content-Type: application/json" \
  -d '{
    "walletId": "your-wallet-uuid",
    "mintAddress": "FKPvoUKtnWwPi73SGLQrAux9DeP9RD8eGqrzcwynpump",
    "trigger": "DEV_SELL_PERCENTAGE",
    "threshold": 30,
    "windowSeconds": 600,
    "action": "EXIT_POSITION"
  }'
```

In swarm mode, the Scout discovers new launches and the full agent pipeline handles entry/exit autonomously. Manual positions and policies via API are also supported.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SOLANA_RPC_URL` | Solana RPC endpoint | — |
| `SOLANA_WS_URL` | Solana WebSocket endpoint | — |
| `WALLET_PRIVATE_KEY` | Base64 encoded private key | — |
| `WALLET_KEYPAIR_PATH` | Path to keypair JSON file | — |
| `DATABASE_URL` | Postgres connection string | — |
| `REDIS_URL` | Redis connection string | — |
| `API_HOST` | API bind address | `0.0.0.0` |
| `API_PORT` | API port | `3100` |
| `MAX_POSITION_SIZE_SOL` | Max SOL per position | `1.0` |
| `MAX_SLIPPAGE_BPS` | Max slippage in basis points | `300` |
| `MAX_PRIORITY_FEE_LAMPORTS` | Max priority fee | `100000` |
| `EXECUTION_COOLDOWN_MS` | Min time between executions | `5000` |
| `SWARM_ENABLED` | Enable agent swarm mode | `false` |
| `LLM_PROVIDER` | LLM provider | `anthropic` |
| `LLM_API_KEY` | LLM API key (required for swarm) | — |
| `LLM_MODEL` | Model for agent reasoning | `claude-sonnet-4-5-20250929` |
| `LLM_MAX_TOKENS` | Max tokens per LLM call | `1024` |
| `NODE_ID` | Unique node ID in the swarm | `node-{pid}` |
| `INTEL_CHANNEL_PREFIX` | Redis stream prefix | `cyclawps` |
| `LOG_LEVEL` | Pino log level | `info` |
| `NODE_ENV` | Environment | `development` |

Either `WALLET_PRIVATE_KEY` or `WALLET_KEYPAIR_PATH` must be set.

Set `SWARM_ENABLED=true` and `LLM_API_KEY` to activate the agent swarm. Without these, the node runs in policy-only mode.

## Benchmarks

| Metric | Value | Notes |
|--------|-------|-------|
| Event ingestion latency | **8ms** p95 | Solana WS to EventBus |
| Policy evaluation | **0.3ms** | Cached state, deterministic rules |
| TX simulation + send | **120ms** | Including Solana RPC round-trip |
| Scout tick (3s) | **300+** launches/hr | New token discovery rate |
| Analyst reasoning | **1.8s** avg | LLM analysis + risk profiling |
| DeployerScore lookup | **0.8ms** | Redis sorted set + graph cache |
| WalletGraph BFS | **4.2ms** | 3-depth cluster detection |
| IntelBus signal latency | **12ms** p95 | Cross-node Redis Streams |

*Measured on mainnet-beta, Helius RPC, m6i.large*

## Network Metrics

```
GET /metrics/network
```

```json
{
  "nodesOnline": 12,
  "agentsRunning": 72,
  "deployersScored24h": 847,
  "walletGraphEdges": 15293,
  "patternsRecorded24h": 342,
  "signalsShared24h": 4891,
  "lastSignalAt": "2026-02-16T08:23:45.123Z"
}
```

Aggregate network telemetry. No strategy data exposed.

## Core Engine

For details on the underlying policy engine, risk engine, execution engine, API endpoints, and database schema, see [cyclawps](https://github.com/controlborgs/cyclawps).

## Testing

```bash
npm test
```

47 unit tests covering policy evaluation, risk enforcement, state management, event dispatch, and PumpFun bonding curve math.

## Tech Stack

- TypeScript (strict mode, ESM)
- Node 22+
- Fastify 5
- Prisma 6 / PostgreSQL
- ioredis / Redis
- @solana/web3.js v1
- @anthropic-ai/sdk (agent reasoning)
- Pino (structured JSON logging)
- Zod (runtime validation)
- Vitest
