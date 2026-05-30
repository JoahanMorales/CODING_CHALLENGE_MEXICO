export type ExchangeId = "binance" | "kraken" | "coinbase" | "okx" | "bybit" | "bitfinex" | "gate";

export type SymbolId = "BTC/USDT" | "ETH/USDT" | "ETH/BTC";

export type OpportunityType = "CROSS_EXCHANGE" | "TRIANGULAR" | "STAT_ARB";

export type OpportunityStatus = "DETECTED" | "EVALUATING" | "EXECUTED" | "REJECTED" | "EXPIRED";

export type SystemStatus = "SCANNING" | "CIRCUIT_BREAKER" | "HALTED";

export type ExecutionStyle = "INSTANT_TAKER" | "MAKER_ASSISTED" | "TRIANGULAR_CYCLE" | "STAT_MEAN_REVERSION";

export type ScenarioKind = "MARKET_CRASH" | "LIQUIDITY_DRAIN" | "LATENCY_SPIKE";

export type ExecutionRuntimeMode = "PAPER" | "SANDBOX";

export type SandboxOrderMode = "DRY_RUN" | "TEST_ORDER" | "LIVE_SANDBOX";

export type GatewayCommand =
  | { type: "ADMIN_AUTH"; token: string }
  | { type: "SET_SCANNER_UNIVERSE"; exchanges: ExchangeId[] }
  | { type: "RUN_SCENARIO"; scenario: ScenarioKind }
  | { type: "SET_EXECUTION_MODE"; mode: ExecutionRuntimeMode }
  | { type: "REFRESH_SANDBOX_BALANCES" }
  | { type: "RECONCILE_SANDBOX" }
  | { type: "SET_SANDBOX_KILL_SWITCH"; active: boolean }
  | { type: "RESET_RISK" }
  | { type: "REPLAY_HISTORY" };

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
  bitfinex?: number;
  gate?: number;
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
  balanceFetchedAt?: number;
  balances: SandboxAssetBalance[];
}

export interface SandboxAssetBalance {
  asset: "BTC" | "USDT";
  available: string;
  locked: string;
}

export interface SandboxFill {
  exchange: "binance" | "okx";
  orderId: string;
  status: string;
  filledQuantity: string;
  quoteQuantity: string;
  averagePrice: string;
  feeUsd: string;
  feeSource: "VENUE" | "ESTIMATED";
  fetchedAt: number;
}

export interface SandboxPreflight {
  checkedAt: number;
  status: "IDLE" | "READY" | "BLOCKED";
  reason: string;
  buyNotionalUsd: string;
  sellQuantityBtc: string;
}

export interface SandboxLedgerEntry {
  id: string;
  route: string;
  recordedAt: number;
  quantityBtc: string;
  buyQuoteUsd: string;
  sellQuoteUsd: string;
  grossPnlUsd: string;
  feesUsd: string;
  netPnlUsd: string;
  feeSource: "VENUE" | "ESTIMATED";
}

export interface SandboxLedgerSummary {
  executions: number;
  wins: number;
  losses: number;
  grossPnlUsd: string;
  feesUsd: string;
  realizedPnlUsd: string;
  lastEntry?: SandboxLedgerEntry;
}

export interface SandboxReconciliation {
  checkedAt: number;
  status: "IDLE" | "TEST_ONLY" | "BALANCED" | "PARTIAL" | "FAILED";
  reason: string;
  residualBtc: string;
  hedgeAction: "NONE" | "PLANNED" | "BLOCKED";
  fills: SandboxFill[];
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
  killSwitchActive: boolean;
  killSwitchReason: string;
  lastReconciliation?: SandboxReconciliation;
  lastPreflight?: SandboxPreflight;
  ledger: SandboxLedgerSummary;
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

export interface BenchmarkSummary {
  capturedAt: string;
  durationMinutes: number;
  venueCount: number;
  routeCount: number;
  signalsScored: number;
  executableSignals: number;
  paperTrades: number;
  paperPnlUsd: string;
  averageDetectionLatencyMs: string;
  p95DetectionLatencyMs: string;
  rejectedByCause: Record<string, number>;
  shadowLearning: {
    evaluatedSignals: number;
    avoidedLosses: number;
    avoidedLossUsd: string;
    hitRatePct: string;
  };
  testOrderValidation: {
    status: "VALIDATED" | "NOT_RUN";
    venue: string;
    fundsMoved: false;
    note: string;
  };
}

export interface PublicGatewaySummary {
  ok: boolean;
  service: "arbitrai-gateway";
  time: string;
  operationalMode: SandboxOrderMode;
  scannerUniverse: ExchangeId[];
  exchanges: ExchangeConnectionStatus[];
  metrics: PerformanceMetrics;
  learning: LearningSummary;
  risk: RiskState;
  executionProof: {
    mode: ExecutionRuntimeMode;
    orderMode: SandboxOrderMode;
    configuredVenues: number;
    validationStatus: "VALIDATED" | "READY" | "NOT_CONFIGURED";
    fundsMoved: false;
  };
  recentSignals: Array<Pick<Opportunity, "createdAt" | "expectedProfitUsd" | "netSpreadPct" | "route" | "score" | "status" | "type">>;
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
  scannerUniverse?: ExchangeId[];
  adminAuthenticated?: boolean;
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
  | { type: "METRICS"; metrics: PerformanceMetrics }
  | { type: "ADMIN_STATE"; authenticated: boolean; reason: string }
  | { type: "SCANNER_UNIVERSE"; exchanges: ExchangeId[] }
  | { type: "COMMAND_ERROR"; command: GatewayCommand["type"] | "UNKNOWN"; reason: string };
