# CyclAwps Node — Data Flows

How data moves through the intelligence node — from chain scanning through agent reasoning to executed transactions and shared network intelligence.

---

## Architecture Overview

```
                    ┌─────────────────────────────────────────┐
                    │              Other Nodes                 │
                    └──────────────┬──────────────────────────┘
                                   │ Redis Streams
                                   ▼
┌─────────────┐    ┌──────────────────────────────┐
│ Solana RPC   │    │       Intelligence Layer      │
│ (WebSocket)  │    │  IntelBus · DeployerScores    │
└──────┬──────┘    │  WalletGraph · PatternDB       │
       │           └──────┬───────────────┬────────┘
       ▼                  │               │
┌─────────────────┐       │               │
│ EventIngestion   │       │               │
└────────┬────────┘       │               │
         │                │               │
         ▼                ▼               ▼
┌──────────────────────────────────────────────────┐
│                    EventBus                       │
│   on-chain events + inter-agent messages          │
└──┬─────┬─────┬──────┬──────┬──────┬─────────────┘
   │     │     │      │      │      │
   ▼     ▼     ▼      ▼      ▼      ▼
 Scout Analyst Strat Sentinel Exec Memory
   │     │      │      │       │     │
   │     │      │      │       ▼     │
   │     │      │      │   ┌───────┐ │
   │     │      │      └──►│Solana │ │
   │     │      └─────────►│  TX   │ │
   │     │                 └───────┘ │
   │     │                           │
   └─────┴───────────────────────────┘
         feedback loop
```

---

## Core Engine Flows

The node includes the full CyclAwps core engine. See the [core data flows](https://github.com/controlborgs/cyclawps/blob/main/docs/data-flows.md) for details on:

- Event Ingestion → EventBus → State Engine
- Policy Engine evaluation
- Orchestrator → Risk Engine → Execution Engine
- Position lifecycle and database writes

Everything below is additive — the agent swarm runs alongside the core policy engine.

---

## Agent Pipeline

### Message Flow

```
Scout ──► Analyst ──► Strategist ──► Executor ──► Memory
                                        ▲            │
                          Sentinel ─────┘            │
                                                     │
                          Strategist ◄───────────────┘
                           (outcome feedback)
```

### EventBus Agent Channels

| From | To | Channel | Payload |
|------|----|---------|---------|
| Scout | Analyst | `agent:analyst:new-launch` | NewLaunchSignal + DeployerProfile |
| Analyst | Strategist | `agent:strategist:token-analysis` | TokenAnalysis |
| Strategist | Executor | `agent:executor:execution-plan` | ExecutionPlan |
| Sentinel | Executor | `agent:executor:threat-exit` | ThreatExit (priority queue) |
| Executor | Memory | `agent:memory:execution-result` | ExecutionResult |
| Memory | Strategist | `agent:strategist:outcome` | pnlPercent, wasCorrect |

All agent messages route through the EventBus using the pattern `agent:{role}:{channel}`. Broadcast messages use `agent:broadcast:{channel}`.

---

## Agent Details

### Scout

Scans Solana for new PumpFun token launches. First agent in the pipeline.

| Direction | What |
|-----------|------|
| **In** | Solana RPC — recent signatures for PumpFun program (`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`) |
| **In** | IntelBus `launches` channel — launches detected by other nodes |
| **Out** | Message to Analyst (`new-launch`) if deployer score ≥ 20 |
| **Out** | IntelBus publish to `launches` channel |
| **Out** | WalletGraph edge: deployer → mint (`deployed_from`) |
| **Out** | DeployerScoreEngine profile update |

**Tick**: 3000ms. On each tick, fetches recent PumpFun program signatures, parses token balance changes to identify new mints, queries deployer connections via WalletGraph, scores the deployer, and forwards qualifying launches to the Analyst.

---

### Analyst

Deep analysis of token launches. LLM-powered conviction scoring.

| Direction | What |
|-----------|------|
| **In** | Scout message on `new-launch` channel |
| **Out** | Message to Strategist (`token-analysis`) if conviction > 0 and position size > 0 |
| **Reads** | PumpFun bonding curve state |
| **Reads** | WalletGraph cluster (deployer, depth=2) |
| **Reads** | PatternDatabase matches |
| **Reads** | DeployerScoreEngine profile |

**Processing**: Queues launches FIFO. For each:
1. Fetch bonding curve state (skip if already complete/migrated)
2. Get wallet cluster size via WalletGraph BFS
3. Find matching patterns from PatternDatabase
4. Build LLM prompt with all context
5. LLM returns `TokenAnalysis`: convictionScore (0-100), riskProfile, recommendedPositionSizeSol, reasoning

**Tick**: 2000ms. Processes one queued launch per tick.

---

### Strategist

Portfolio-aware position sizing. Decides whether to enter.

| Direction | What |
|-----------|------|
| **In** | Analyst message on `token-analysis` channel |
| **In** | Memory message on `outcome` channel (learning feedback) |
| **Out** | Message to Executor (`execution-plan`) |
| **Reads** | StateEngine — all open positions |

**Filters applied before LLM**:
- Skip if riskProfile = `extreme`
- Skip if conviction < 30
- Skip if already holding the same mint
- Track losing streaks (last 3 trades all losses)

**LLM reasoning context**: Current portfolio state, win rate from recent outcomes, losing streak status, token analysis details. Returns enter/skip decision with position sizing.

**Position size adjustments**:
- Capped to `maxPositionSizeSol` from risk params
- Reduced 50% if on a losing streak

**Tick**: 2000ms.

---

### Sentinel

Continuous threat monitoring for open positions. The defensive agent.

| Direction | What |
|-----------|------|
| **In** | StateEngine — all open positions (checked every tick) |
| **In** | IntelBus `rugs` channel — rug alerts from other nodes |
| **Out** | Message to Executor (`threat-exit`) with priority |
| **Out** | IntelBus publish to `rugs` channel for high/critical threats |
| **Reads** | PumpFun bonding curve state |
| **Reads** | StateEngine dev wallet sell metrics |
| **Reads** | WalletGraph cluster size |

**Threat detection per position**:

| Threat | Source | Severity |
|--------|--------|----------|
| Dev selling > 5% in 10min | StateEngine | medium |
| Dev selling > 30% in 10min | StateEngine | critical |
| Bonding curve complete | PumpFun | high |
| Wallet cluster > 10 | WalletGraph | high |
| Network rug signal for mint | IntelBus | critical |

**Critical threats** → immediate exit plan to Executor (front of priority queue).
**Non-critical threats** → LLM assessment → partial_exit / full_exit / hold decision.

**Tick**: 5000ms.

---

### Executor

Transaction builder and sender. Handles both entries and exits.

| Direction | What |
|-----------|------|
| **In** | Strategist message on `execution-plan` channel (entries) |
| **In** | Sentinel message on `threat-exit` channel (exits) |
| **Out** | Signed transaction → Solana blockchain |
| **Out** | Message to Memory (`execution-result`) |
| **Reads** | PumpFun bonding curve (quote) |
| **Reads** | StateEngine (position data) |
| **Uses** | RiskEngine (pre-execution validation) |
| **Uses** | ExecutionEngine (for sell transactions) |

**Priority queue**: Orders by urgency — critical > high > medium > low. Critical exits (from Sentinel) are inserted at the front.

**For entries**: Builds PumpFun buy instruction, simulates, sends with priority fee.
**For exits**: Delegates to the core ExecutionEngine.execute() which handles the full sell pipeline.

**Tick**: 1000ms. Processes one queued plan per tick.

---

### Memory

Learning agent. Tracks outcomes and feeds performance data back to the Strategist.

| Direction | What |
|-----------|------|
| **In** | Executor message on `execution-result` channel |
| **Out** | Message to Strategist (`outcome`) when a position closes |
| **Writes** | Redis `cyclawps:memory:outcomes` (last 500) |
| **Writes** | Redis `cyclawps:memory:stats` (aggregate metrics) |
| **Reads** | StateEngine (position status for closure detection) |

**Processing**: Queues execution results. Creates `DecisionOutcome` records. When a position closes, calculates P&L and sends the outcome to the Strategist for learning. Persists outcomes and aggregate stats (win rate, avg P&L, total trades) to Redis every 10 ticks.

**Tick**: 10000ms.

---

## Intelligence Layer

### IntelBus

Cross-node signal sharing via Redis Streams.

| Direction | What |
|-----------|------|
| **In** | Signals published by local agents |
| **In** | Signals from other nodes via Redis Streams |
| **Out** | Signals delivered to local subscribers |

**Channels**: `launches`, `rugs` (extensible).
**Redis key pattern**: `cyclawps:signals:{channel}`
**Stream config**: MAXLEN ~10000 per channel.
**Consumer groups**: Each node has a unique consumer ID. Signals from own nodeId are skipped.
**Polling**: 500ms XREADGROUP interval.

---

### Deployer Score Engine

Reputation scoring for token deployers. Score range: 0–100.

| Direction | What |
|-----------|------|
| **In** | Launch events (deployer address, mint, connected wallets) |
| **In** | Rug events (deployer, token lifespan) |
| **Out** | DeployerProfile with computed score |

**Scoring formula** (base = 50):

| Factor | Weight | Cap |
|--------|--------|-----|
| Rug rate | -40 × rugRate | -40 |
| Launch count | +1.5 per launch | +15 |
| Avg token lifespan | +2 per hour | +20 |
| Connected wallets | -3 per wallet | -15 |
| Recency decay | -0.5 per day after 7 days | -10 |

**Redis keys**:
- `cyclawps:deployer:{address}` — profile JSON (24h TTL)
- `cyclawps:deployer:scores` — sorted set for leaderboard queries

---

### Wallet Graph

Directed graph of wallet relationships stored in Redis.

| Direction | What |
|-----------|------|
| **In** | Edge additions (from, to, type) |
| **Out** | Connection queries, cluster detection (BFS) |

**Edge types**: `funded_by`, `transferred_to`, `deployed_from`, `associated`
**Cluster detection**: BFS traversal up to N hops. Used by Analyst (depth=2) and Sentinel (cluster size monitoring).

**Redis keys**:
- `cyclawps:graph:edge:{from}:{to}` — edge JSON (7d TTL)
- `cyclawps:graph:out:{wallet}` — outgoing adjacency set
- `cyclawps:graph:in:{wallet}` — incoming adjacency set

---

### Pattern Database

Historical pattern storage and matching.

| Direction | What |
|-----------|------|
| **In** | Pattern definitions (name, conditions, outcomes) |
| **In** | Outcome recordings (positive/negative, return %) |
| **Out** | PatternMatch arrays sorted by signal strength |

**Conditions**: `gt`, `lt`, `eq`, `gte`, `lte`, `between` — evaluated against context objects.
**Signal strength**: `sampleSize × hitRate` — patterns with more data and higher accuracy rank first.
**Rolling stats**: Hit rate, avg return, avg hold duration — updated on each outcome recording.

**Redis key**: `cyclawps:patterns:all` (hash)

---

## End-to-End Flows

### New Token Entry (Offensive)

```
1.  Scout detects new PumpFun launch on Solana
2.  Scout → WalletGraph: get deployer connections
3.  Scout → DeployerScoreEngine: update profile, get score
4.  Scout → IntelBus: publish launch signal to network
5.  Score ≥ 20 → Scout sends to Analyst

6.  Analyst fetches bonding curve state
7.  Analyst → WalletGraph: get cluster (depth=2)
8.  Analyst → PatternDatabase: find matching patterns
9.  Analyst → LLM: full context prompt → TokenAnalysis
10. Conviction > 0 → Analyst sends to Strategist

11. Strategist checks portfolio (open positions, duplicates)
12. Strategist checks recent outcomes (win rate, losing streak)
13. Strategist → LLM: portfolio-aware decision → ExecutionPlan
14. Enter decision → Strategist sends to Executor

15. Executor queues plan (medium priority)
16. Executor builds PumpFun buy transaction
17. Executor simulates → sends → confirms on Solana
18. Executor → Memory: report execution result
```

### Threat Exit (Defensive)

```
1.  Sentinel monitors open positions (5s tick)
2.  Sentinel → StateEngine: check dev sell % in 10min window
3.  Dev selling 35% → CRITICAL threat

4.  Sentinel → IntelBus: publish rug signal to network
5.  Sentinel → Executor: threat-exit (critical priority, front of queue)

6.  Executor processes immediately (critical = front of queue)
7.  Executor → RiskEngine: validate
8.  Executor → ExecutionEngine: full exit
9.  ExecutionEngine → PumpFun sell → Solana TX
10. Executor → Memory: report result

11. Memory calculates P&L on closed position
12. Memory → Strategist: outcome feedback (pnlPercent, wasCorrect)
13. Strategist adjusts future sizing based on result
```

### Network Intelligence Propagation

```
Node A: Scout detects new launch
  → IntelBus.publish("launches", { deployer, mint, score })
  → Redis Stream: XADD cyclawps:signals:launches

Node B: IntelBus consumer reads stream
  → Skips own nodeId signals
  → Delivers to Scout's launch handler
  → Scout processes as if locally detected

Node C: Sentinel detects rug (dev dump)
  → IntelBus.publish("rugs", { mint, threat, severity })
  → Redis Stream: XADD cyclawps:signals:rugs

Node A: IntelBus consumer reads rug signal
  → Sentinel checks if holding that mint
  → If yes → immediate threat-exit to Executor
```

---

## Redis Key Reference

| Component | Key Pattern | Purpose | TTL |
|-----------|-------------|---------|-----|
| StateEngine | `clawops:state:snapshot` | Position/metric warm cache | 300s |
| DeployerScores | `cyclawps:deployer:{address}` | Profile JSON | 24h |
| DeployerScores | `cyclawps:deployer:scores` | Score leaderboard (sorted set) | — |
| WalletGraph | `cyclawps:graph:edge:{from}:{to}` | Edge data | 7d |
| WalletGraph | `cyclawps:graph:out:{wallet}` | Outgoing adjacency | — |
| WalletGraph | `cyclawps:graph:in:{wallet}` | Incoming adjacency | — |
| PatternDB | `cyclawps:patterns:all` | Pattern definitions (hash) | — |
| Memory | `cyclawps:memory:outcomes` | Last 500 outcomes | — |
| Memory | `cyclawps:memory:stats` | Aggregate performance | — |
| IntelBus | `cyclawps:signals:{channel}` | Cross-node signals (stream) | ~10k entries |

## Database Tables

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `wallet` | Tracked wallet addresses | address, label, isActive |
| `trackedToken` | Mint addresses linked to wallets | mintAddress, symbol, decimals, devWallet |
| `position` | Open/closed positions | walletId, mintAddress, tokenBalance, status |
| `policy` | Declarative risk policies | trigger, threshold, action, priority, isActive |
| `execution` | Execution audit trail | positionId, policyId, txSignature, status |
| `eventLog` | Raw event log | type, payload, source, processedAt |

## Agent Dependency Matrix

| Agent | LLM | StateEngine | IntelBus | DeployerScores | WalletGraph | PatternDB | PumpFun | RiskEngine | ExecutionEngine |
|-------|-----|-------------|----------|----------------|-------------|-----------|---------|------------|-----------------|
| Scout | | | write | write | write | | read | | |
| Analyst | yes | | | read | read | read | read | | |
| Strategist | yes | read | | | | read | | | |
| Sentinel | yes | read | write | | read | | read | | |
| Executor | | read | | | | | read | read | read |
| Memory | | read | | write | | write | | | |
