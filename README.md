# CyclAwps Node

Collective autonomous intelligence for Solana. A swarm of six AI agents that discover, analyze, enter, monitor, and exit positions across PumpFun — coordinating through a shared intelligence layer that gets smarter with every node that joins.

One node sees one chain. The network sees everything.

Built on the [CyclAwps](https://github.com/controlborgs/cyclawps) execution engine.

## How It Works

Every node runs six autonomous agents. Each agent has a single job and does it continuously. Together they form a closed-loop system — no human in the loop from discovery to exit.

Across nodes, a shared intelligence layer aggregates deployer reputations, wallet relationship graphs, rug signals, and historical pattern outcomes. Your node's strategy is private. The collective intelligence is shared. More nodes = better signal = better decisions for everyone.

```
 ┌──────────────────────────────────────────────────────┐
 │              Shared Intelligence Layer               │
 │          (Redis Streams across all nodes)            │
 │                                                      │
 │  Deployer Scores  │  Wallet Graph  │  Rug Signals   │
 │  Pattern Database │  Curve States  │  Threat Intel  │
 └──────────┬───────────────┬──────────────┬───────────┘
            │               │              │
     ┌──────┴──────┐ ┌─────┴──────┐ ┌────┴───────┐
     │   Node A    │ │   Node B   │ │   Node C   │
     │   6 agents  │ │   6 agents │ │   6 agents │
     └──────┬──────┘ └─────┬──────┘ └────┬───────┘
            │               │              │
            └───────────────┴──────────────┘
                         │
          Scout ──▶ Analyst ──▶ Strategist ──▶ Executor
                                                  │
          Sentinel ───────────────────────────────┘
               │
          Memory ◀─── (outcomes from all agents)
```

## Agents

Six agents. Three use LLM reasoning. Three run pure compute. All tick continuously.

| Agent | What it does | LLM | Tick |
|-------|-------------|-----|------|
| **Scout** | Crawls every PumpFun launch in real-time. Scores deployers against the collective reputation database. Flags anything above threshold to Analyst. | No | 3s |
| **Analyst** | Deep-dives flagged tokens. Pulls bonding curve state, wallet graph clusters, pattern matches. Outputs a conviction score 0-100 with risk profile and recommended size. | Yes | 2s |
| **Strategist** | Portfolio-level brain. Considers total exposure, win rate, consecutive losses, and correlation. Decides entry/skip with position sizing. Cuts size 50% after 3 consecutive losses. | Yes | 2s |
| **Sentinel** | Watches every open position. Monitors dev wallet sell %, bonding curve completion, wallet cluster growth. Critical threats (>50% dev sell) bypass LLM — immediate exit. | Yes | 5s |
| **Executor** | Priority queue. Critical exits first, then high, medium, low. Builds PumpFun instructions, simulates, sends with retry. Reports every outcome to Memory. | No | 1s |
| **Memory** | Records every entry, exit, and P&L. Evaluates closed positions. Feeds outcome data back to Strategist so the system learns what works and what doesn't. Persists last 500 outcomes. | No | 10s |

## Intelligence Layer

This is what separates CyclAwps from a bot. Every node contributes to and reads from a shared intelligence network that grows with the swarm:

- **IntelBus** — Durable signal bus over Redis Streams. Every deployer activity, rug detection, wallet edge, and curve snapshot is published to the network. Consumer groups ensure every node processes every signal exactly once.
- **DeployerScoreEngine** — Reputation scores 0-100 for every deployer seen on-chain. Factors: rug rate (-40), launch count (+15), average token lifespan (+20), wallet cluster size (-15), recency decay. Stored in Redis sorted sets for sub-millisecond lookups.
- **WalletGraph** — Directed graph of on-chain wallet relationships. Edge types: `funded_by`, `transferred_to`, `deployed_from`, `associated`. BFS cluster detection up to configurable depth. Finds connected wallets that on-chain explorers miss.
- **PatternDatabase** — Historical pattern conditions with tracked outcomes. Agents query before every decision. Patterns sorted by `sampleSize * hitRate` — the system trusts patterns that have proven themselves over volume.

## Benchmarks

| Metric | Value | Notes |
|--------|-------|-------|
| Event ingestion | **8ms** p95 | Solana WS to EventBus |
| Policy evaluation | **0.3ms** | Cached state, deterministic |
| TX simulation + send | **120ms** | Full Solana RPC round-trip |
| Scout throughput | **300+** launches/hr | Every PumpFun launch, scored |
| Analyst reasoning | **1.8s** avg | Full LLM analysis + risk profile |
| DeployerScore lookup | **0.8ms** | Redis sorted set |
| WalletGraph BFS | **4.2ms** | 3-depth cluster detection |
| Cross-node signal | **12ms** p95 | Intel propagation via Redis Streams |

*Mainnet-beta, Helius RPC, m6i.large. Scout throughput scales with PumpFun launch volume.*

## Network Metrics

Every node exposes aggregate telemetry. No strategy data. No positions. No wallet addresses.

```
GET /metrics/network
```

```json
{
  "nodesOnline": 47,
  "agentsRunning": 282,
  "deployersScored24h": 3841,
  "walletGraphEdges": 128490,
  "patternsRecorded24h": 1247,
  "signalsShared24h": 24019,
  "lastSignalAt": "2026-02-16T08:23:45.123Z"
}
```

## Quick Start

```bash
git clone https://github.com/controlborgs/cyclawps-node.git
cd cyclawps-node
npm install
docker compose up -d postgres redis
cp .env.example .env
```

Configure `.env`:

```bash
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_WS_URL=wss://api.mainnet-beta.solana.com
WALLET_PRIVATE_KEY=<base64-encoded-keypair>
DATABASE_URL=postgresql://clawops:clawops@localhost:5432/clawops
REDIS_URL=redis://localhost:6379

# Activate the swarm
SWARM_ENABLED=true
LLM_API_KEY=sk-ant-...
LLM_MODEL=claude-sonnet-4-5-20250929
```

```bash
npx prisma migrate dev
npm run dev
```

Without `SWARM_ENABLED=true`, the node runs in policy-only mode — deterministic rules, no LLM, no agents. Set it to `true` with an API key to activate the full swarm.

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

In swarm mode, the Scout discovers launches and the full pipeline handles everything autonomously. The API is for manual overrides and monitoring.

## Core Engine

The execution layer underneath — policy engine, risk engine, transaction building, PumpFun integration, API, database schema — lives in [cyclawps](https://github.com/controlborgs/cyclawps).

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
