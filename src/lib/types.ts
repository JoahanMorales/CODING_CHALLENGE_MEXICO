export type ExchangeId = "binance" | "kraken" | "coinbase" | "okx" | "bybit";

export type SymbolId = "BTC/USDT" | "ETH/USDT" | "ETH/BTC";

export type OpportunityType = "CROSS_EXCHANGE" | "TRIANGULAR" | "STAT_ARB";

export type OpportunityStatus = "DETECTED" | "EVALUATING" | "EXECUTED" | "REJECTED" | "EXPIRED";

export type SystemStatus = "SCANNING" | "CIRCUIT_BREAKER" | "HALTED";

export type ExecutionStyle = "INSTANT_TAKER" | "MAKER_ASSISTED" | "TRIANGULAR_CYCLE" | "STAT_MEAN_REVERSION";

export type ScenarioKind = "MARKET_CRASH" | "LIQUIDITY_DRAIN" | "LATENCY_SPIKE";

export type ExecutionRuntimeMode = "PAPER" | "SANDBOX";

export type SandboxOrderMode = "DRY_RUN" | "TEST_ORDER" | "LIVE_SANDBOX";

export interface EdgeModelSignal {
  adverseSelectionBps: string;
  edgeQuality: "EXPLOIT" | "WATCH" | "AVOID";
  liquidityScore: string;
  micropriceSkewBps: string;
  modelScore: number;
  orderFlowImbalance: string;
  riskAdjustedProfitUsd: string;
  suggestedSizeScale: string;
  survivalProbability: string;
  volatilityBps: string;
}

export interface OrderBookLevel {
  price: string;
  size: string;
}

export interface NormalizedOrderBook {
  exchange: ExchangeId;
  symbol: SymbolId;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  receivedAt: number;
  exchangeTimestamp: number;
  processingLatencyMs: number;
}

export interface PricePoint {
  time: number;
  binance?: number;
  kraken?: number;
  coinbase?: number;
  okx?: number;
  bybit?: number;
}

export interface ExchangeConnectionStatus {
  exchange: ExchangeId;
  transport: "websocket" | "rest-polling" | "demo";
  status: "connecting" | "live" | "polling" | "reconnecting" | "error";
  lastMessageAt: number;
  messageCount: number;
  lastError: string;
  reliabilityScore?: number;
}

export interface ExecutionPlan {
  buyLevels: OrderBookLevel[];
  sellLevels: OrderBookLevel[];
  buyLiquidityRole: "maker" | "taker";
  sellLiquidityRole: "maker" | "taker";
  referenceBuyPrice: string;
  referenceSellPrice: string;
}

export interface Opportunity {
  id: string;
  type: OpportunityType;
  executionStyle: ExecutionStyle;
  status: OpportunityStatus;
  route: string;
  createdAt: number;
  expiresAt: number;
  detectionLatencyMs: number;
  buyExchange?: ExchangeId;
  sellExchange?: ExchangeId;
  exchange?: ExchangeId;
  grossSpreadPct: string;
  netSpreadPct: string;
  tradeSizeBtc: string;
  expectedProfitUsd: string;
  grossProfitUsd: string;
  totalFeesUsd: string;
  slippageUsd: string;
  networkCostUsd: string;
  score: number;
  confidence: number;
  highImpact: boolean;
  impactRatio: number;
  reason: string;
  edgeModel?: EdgeModelSignal;
  executionPlan?: ExecutionPlan;
}

export interface CounterfactualOutcome {
  id: string;
  opportunityId: string;
  route: string;
  type: OpportunityType;
  evaluatedAt: number;
  horizonMs: number;
  originalStatus: OpportunityStatus;
  entryExpectedProfitUsd: string;
  realizedProfitUsd: string;
  deltaUsd: string;
  predictedSurvival: string;
  label: "MISSED_PROFIT" | "AVOIDED_LOSS" | "FALSE_POSITIVE" | "CONFIRMED_REJECT" | "CONFIRMED_EDGE";
}

export interface LearningSummary {
  evaluatedSignals: number;
  missedProfits: number;
  avoidedLosses: number;
  falsePositives: number;
  confirmedEdges: number;
  shadowPnlUsd: string;
  missedProfitUsd: string;
  avoidedLossUsd: string;
  opportunityCostUsd: string;
  averageOutcomeUsd: string;
  bestMissedUsd: string;
  hitRatePct: string;
  lastOutcome?: CounterfactualOutcome;
}

export interface SandboxVenueStatus {
  exchange: "binance" | "okx";
  configured: boolean;
  environment: "spot-testnet" | "demo-trading";
  lastError: string;
  lastOrderId?: string;
  lastLatencyMs?: number;
}

export interface SandboxExecutionReport {
  id: string;
  opportunityId: string;
  route: string;
  createdAt: number;
  mode: SandboxOrderMode;
  status: "SKIPPED" | "DRY_RUN" | "SUBMITTED" | "FAILED";
  reason: string;
  legs: Array<{
    exchange: "binance" | "okx";
    side: "BUY" | "SELL";
    symbol: "BTCUSDT" | "BTC-USDT";
    price: string;
    quantity: string;
    orderId?: string;
    status: "PLANNED" | "SUBMITTED" | "FAILED";
  }>;
}

export interface ExecutionRuntimeState {
  mode: ExecutionRuntimeMode;
  sandboxEnabled: boolean;
  orderMode: SandboxOrderMode;
  maxNotionalUsd: string;
  venues: SandboxVenueStatus[];
  lastReport?: SandboxExecutionReport;
}

export interface RecordedEvent {
  id: string;
  time: number;
  message: GatewayMessage;
}

export interface Trade {
  id: string;
  opportunityId: string;
  type: OpportunityType;
  route: string;
  executedAt: number;
  latencyMs: number;
  sizeBtc: string;
  pnlUsd: string;
  feesUsd: string;
  fillRatio: number;
  status: "FILLED" | "PARTIAL" | "REJECTED";
  highImpact: boolean;
}

export interface WalletBalance {
  exchange: ExchangeId;
  btc: string;
  usdt: string;
  rebalancingNeeded: boolean;
  rebalancingCostUsd: string;
}

export type WalletSeed = Record<ExchangeId, { btc: string; usdt: string }>;

export interface RiskState {
  status: SystemStatus;
  riskColor: "GREEN" | "AMBER" | "RED";
  circuitBreakerActive: boolean;
  consecutiveLosses: number;
  dailyPnlUsd: string;
  dailyLossLimitUsd: string;
  exposureBtc: string;
  maxPositionBtc: string;
  haltedReason: string;
  marketCrashMode: boolean;
  activeScenario: ScenarioKind | "NONE";
  scenarioRemainingMs: number;
}

export interface PerformanceMetrics {
  opportunitiesDetected: number;
  executableOpportunities: number;
  rejectedOpportunities: number;
  tradesExecuted: number;
  netPnlUsd: string;
  winRatePct: string;
  averageProfitUsd: string;
  bestTradeUsd: string;
  totalFeesPaidUsd: string;
  opportunityExecutionRatioPct: string;
  averageDetectionLatencyMs: string;
  sharpeLikeRatio: string;
}

export interface GatewaySnapshot {
  type: "SNAPSHOT";
  books: NormalizedOrderBook[];
  opportunities: Opportunity[];
  executionQueue: Opportunity[];
  trades: Trade[];
  wallets: WalletBalance[];
  risk: RiskState;
  metrics: PerformanceMetrics;
  priceSeries: PricePoint[];
  learning: LearningSummary;
  executionRuntime: ExecutionRuntimeState;
  exchangeStatuses?: ExchangeConnectionStatus[];
}

export type GatewayMessage =
  | GatewaySnapshot
  | { type: "BOOK"; book: NormalizedOrderBook }
  | { type: "EXCHANGE_STATUS"; statuses: ExchangeConnectionStatus[] }
  | { type: "OPPORTUNITY"; opportunity: Opportunity; queue: Opportunity[] }
  | { type: "TRADE"; trade: Trade; wallets: WalletBalance[]; metrics: PerformanceMetrics; risk: RiskState }
  | { type: "LEARNING"; summary: LearningSummary; outcome: CounterfactualOutcome }
  | { type: "EXECUTION_RUNTIME"; runtime: ExecutionRuntimeState; report?: SandboxExecutionReport }
  | { type: "REPLAY"; opportunities: Opportunity[]; trades: Trade[]; events: RecordedEvent[] }
  | { type: "RISK"; risk: RiskState }
  | { type: "METRICS"; metrics: PerformanceMetrics };
