// --- Agent identity ---

export type AgentRole = 'scout' | 'analyst' | 'strategist' | 'sentinel' | 'executor' | 'memory';

export interface AgentConfig {
  role: AgentRole;
  tickIntervalMs: number;
  enabled: boolean;
}

// --- Inter-agent messaging ---

export interface AgentMessage<T = unknown> {
  id: string;
  from: AgentRole;
  to: AgentRole | 'broadcast';
  channel: string;
  payload: T;
  timestamp: number;
}

// --- LLM decisions ---

export interface AgentDecision {
  action: string;
  confidence: number; // 0-100
  reasoning: string;
  params: Record<string, unknown>;
}

// --- Scout signals ---

export interface NewLaunchSignal {
  mintAddress: string;
  deployer: string;
  timestamp: number;
  slot: number;
  bondingCurveAddress: string;
  initialVirtualSol: bigint;
  initialVirtualTokens: bigint;
}

export interface DeployerProfile {
  address: string;
  totalLaunches: number;
  rugCount: number;
  rugRate: number;
  avgTokenLifespanMs: number;
  connectedWallets: string[];
  score: number; // 0-100, higher = more trustworthy
  lastSeen: number;
}

// --- Analyst output ---

export interface TokenAnalysis {
  mintAddress: string;
  deployer: string;
  deployerScore: number;
  convictionScore: number; // 0-100
  riskProfile: 'low' | 'medium' | 'high' | 'extreme';
  holderConcentration: number; // % held by top 10
  bondingCurveProgress: number; // 0-100%
  recommendedPositionSizeSol: number;
  reasoning: string;
  timestamp: number;
}

// --- Strategist output ---

export interface ExecutionPlan {
  id: string;
  action: 'enter' | 'exit' | 'partial_exit' | 'skip';
  mintAddress: string;
  positionId?: string;
  solAmount?: number;
  sellPercentage?: number;
  maxSlippageBps: number;
  priorityFeeLamports: number;
  urgency: 'low' | 'medium' | 'high' | 'critical';
  reasoning: string;
  splitTxCount?: number;
  timestamp: number;
}

// --- Sentinel threat ---

export interface ThreatSignal {
  positionId: string;
  mintAddress: string;
  threatType: 'dev_sell' | 'lp_removal' | 'holder_dump' | 'supply_mint' | 'wallet_graph_change' | 'volume_anomaly';
  severity: 'low' | 'medium' | 'high' | 'critical';
  details: Record<string, unknown>;
  timestamp: number;
}

// --- Memory records ---

export interface DecisionOutcome {
  decisionId: string;
  agentRole: AgentRole;
  action: string;
  mintAddress: string;
  entryPrice?: number;
  exitPrice?: number;
  pnlSol?: number;
  pnlPercent?: number;
  holdDurationMs?: number;
  wasCorrect?: boolean; // retrospective assessment
  context: Record<string, unknown>;
  timestamp: number;
}

// --- Intelligence layer ---

export interface Signal {
  id: string;
  nodeId: string;
  type: 'deployer_activity' | 'rug_detected' | 'lp_change' | 'wallet_edge' | 'curve_snapshot' | 'threat';
  data: Record<string, unknown>;
  timestamp: number;
}

export interface NetworkConsensus {
  mintAddress: string;
  signalCount: number;
  nodesReporting: number;
  avgDeployerScore: number;
  rugProbability: number;
  lastUpdated: number;
}
