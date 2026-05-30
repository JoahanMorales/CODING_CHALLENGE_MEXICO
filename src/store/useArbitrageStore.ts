"use client";

import { create } from "zustand";
import { EXCHANGE_IDS, INITIAL_WALLETS } from "@/lib/config/exchanges";
import { ArbitrAIKernel } from "@/lib/services/ArbitrAIKernel";
import type {
  ExchangeId,
  GatewayCommand,
  GatewayMessage,
  ExchangeConnectionStatus,
  ExecutionRuntimeMode,
  ExecutionRuntimeState,
  NormalizedOrderBook,
  Opportunity,
  LearningSummary,
  PerformanceMetrics,
  PricePoint,
  RiskState,
  ScenarioKind,
  Trade,
  WalletBalance,
  WalletSeed
} from "@/lib/types";

type Mode = "LIVE" | "DEMO";

interface FlashState {
  bid: "up" | "down" | "flat";
  ask: "up" | "down" | "flat";
  until: number;
}

interface ArbitrageState {
  mode: Mode;
  connected: boolean;
  connectionError: string;
  lastGatewayMessageAt: number;
  initialized: boolean;
  adminAuthenticated: boolean;
  adminMessage: string;
  scannerUniverse: ExchangeId[];
  books: Record<string, NormalizedOrderBook>;
  exchangeStatuses: ExchangeConnectionStatus[];
  flashes: Record<string, FlashState>;
  opportunities: Opportunity[];
  executionQueue: Opportunity[];
  replayOpportunities: Opportunity[];
  trades: Trade[];
  wallets: WalletBalance[];
  walletSeed: WalletSeed;
  risk: RiskState;
  metrics: PerformanceMetrics;
  learning: LearningSummary;
  executionRuntime: ExecutionRuntimeState;
  priceSeries: PricePoint[];
  init: () => void;
  setMode: (mode: Mode) => void;
  updateWalletSeed: (exchange: ExchangeId, asset: "btc" | "usdt", value: string) => void;
  applyWalletSeed: () => void;
  simulateMarketCrash: () => void;
  runScenario: (scenario: ScenarioKind) => void;
  authenticateAdmin: (token: string) => void;
  setScannerUniverse: (exchanges: ExchangeId[]) => void;
  setExecutionRuntimeMode: (mode: ExecutionRuntimeMode) => void;
  refreshSandboxBalances: () => void;
  reconcileSandbox: () => void;
  setSandboxKillSwitch: (active: boolean) => void;
  resetRisk: () => void;
  replayHistory: () => void;
  exportSessionCsv: () => void;
}

const defaultRisk: RiskState = {
  status: "SCANNING",
  riskColor: "GREEN",
  circuitBreakerActive: false,
  consecutiveLosses: 0,
  dailyPnlUsd: "0.00",
  dailyLossLimitUsd: "-500.00",
  exposureBtc: "4.100000",
  maxPositionBtc: "0.100",
  haltedReason: "none",
  marketCrashMode: false,
  activeScenario: "NONE",
  scenarioRemainingMs: 0
};

const defaultMetrics: PerformanceMetrics = {
  opportunitiesDetected: 0,
  executableOpportunities: 0,
  rejectedOpportunities: 0,
  tradesExecuted: 0,
  netPnlUsd: "0.00",
  grossPnlUsd: "0.00",
  winRatePct: "0.00",
  averageProfitUsd: "0.00",
  bestTradeUsd: "0.00",
  totalFeesPaidUsd: "0.00",
  totalSlippageUsd: "0.00",
  totalExecutionRiskUsd: "0.00",
  opportunityExecutionRatioPct: "0.00",
  averageDetectionLatencyMs: "0.00",
  sharpeLikeRatio: "0.000"
};

const defaultLearning: LearningSummary = {
  evaluatedSignals: 0,
  missedProfits: 0,
  avoidedLosses: 0,
  falsePositives: 0,
  confirmedEdges: 0,
  shadowPnlUsd: "0.00",
  missedProfitUsd: "0.00",
  avoidedLossUsd: "0.00",
  opportunityCostUsd: "0.00",
  averageOutcomeUsd: "0.00",
  bestMissedUsd: "0.00",
  hitRatePct: "0.00"
};

const defaultExecutionRuntime: ExecutionRuntimeState = {
  mode: "PAPER",
  sandboxEnabled: false,
  orderMode: "DRY_RUN",
  maxNotionalUsd: "25.00",
  killSwitchActive: false,
  killSwitchReason: "",
  ledger: { executions: 0, wins: 0, losses: 0, grossPnlUsd: "0.00000000", feesUsd: "0.00000000", realizedPnlUsd: "0.00000000" },
  venues: [
    { exchange: "binance", configured: false, environment: "spot-testnet", lastError: "", balances: [{ asset: "BTC", available: "0", locked: "0" }, { asset: "USDT", available: "0", locked: "0" }] },
    { exchange: "okx", configured: false, environment: "demo-trading", lastError: "", balances: [{ asset: "BTC", available: "0", locked: "0" }, { asset: "USDT", available: "0", locked: "0" }] }
  ]
};

let localKernel: ArbitrAIKernel | null = null;
let gateway: WebSocket | null = null;
let gatewayGeneration = 0;
let gatewayReconnectTimer: number | null = null;
let lastGatewayHeartbeatPaintAt = 0;

export const useArbitrageStore = create<ArbitrageState>((set, get) => ({
  mode: "LIVE",
  connected: false,
  connectionError: "",
  lastGatewayMessageAt: 0,
  initialized: false,
  adminAuthenticated: false,
  adminMessage: "",
  scannerUniverse: EXCHANGE_IDS,
  books: {},
  exchangeStatuses: [],
  flashes: {},
  opportunities: [],
  executionQueue: [],
  replayOpportunities: [],
  trades: [],
  wallets: [],
  walletSeed: INITIAL_WALLETS,
  risk: defaultRisk,
  metrics: defaultMetrics,
  learning: defaultLearning,
  executionRuntime: defaultExecutionRuntime,
  priceSeries: [],

  init: () => {
    if (get().initialized) return;
    set({ initialized: true });
    startGateway(set, get().walletSeed);
  },

  setMode: (mode) => {
    if (mode === get().mode) return;
    stopGateway();
    stopLocalKernel();
    set({ mode, connected: false, connectionError: mode === "LIVE" ? "Conectando con el gateway de mercado..." : "", books: {}, opportunities: [], executionQueue: [], trades: [], priceSeries: [], metrics: defaultMetrics, learning: defaultLearning });
    if (mode === "LIVE") startGateway(set, get().walletSeed);
    else startDemo(set, get().walletSeed);
  },

  updateWalletSeed: (exchange, asset, value) => {
    set((state) => ({
      walletSeed: {
        ...state.walletSeed,
        [exchange]: {
          ...state.walletSeed[exchange],
          [asset]: value
        }
      }
    }));
  },

  applyWalletSeed: () => {
    if (get().mode === "LIVE") return;
    stopLocalKernel();
    set({ connected: false, books: {}, opportunities: [], executionQueue: [], trades: [], priceSeries: [], metrics: defaultMetrics, learning: defaultLearning });
    startDemo(set, get().walletSeed);
  },

  simulateMarketCrash: () => {
    get().runScenario("MARKET_CRASH");
  },

  runScenario: (scenario) => {
    if (get().mode === "LIVE" && gateway?.readyState === WebSocket.OPEN) {
      set({ connectionError: "Scenario Lab is intentionally disabled on real market data. Switch to Demo to run controlled drills." });
      return;
    }
    localKernel?.runScenario(scenario);
  },

  authenticateAdmin: (token) => {
    if (typeof window !== "undefined") window.sessionStorage.setItem("arbitrai-admin-token", token);
    sendGatewayCommand({ type: "ADMIN_AUTH", token });
  },

  setScannerUniverse: (exchanges) => {
    sendGatewayCommand({ type: "SET_SCANNER_UNIVERSE", exchanges });
  },

  setExecutionRuntimeMode: (mode) => {
    if (get().mode === "LIVE" && gateway?.readyState === WebSocket.OPEN) {
      sendGatewayCommand({ type: "SET_EXECUTION_MODE", mode });
      return;
    }
    localKernel?.setExecutionMode(mode);
    set({ executionRuntime: localKernel?.snapshot().executionRuntime ?? defaultExecutionRuntime });
  },

  refreshSandboxBalances: () => {
    if (get().mode === "LIVE" && gateway?.readyState === WebSocket.OPEN) {
      sendGatewayCommand({ type: "REFRESH_SANDBOX_BALANCES" });
      return;
    }
    void localKernel?.refreshSandboxBalances();
  },

  reconcileSandbox: () => {
    if (get().mode === "LIVE" && gateway?.readyState === WebSocket.OPEN) {
      sendGatewayCommand({ type: "RECONCILE_SANDBOX" });
      return;
    }
    void localKernel?.reconcileSandbox();
  },

  setSandboxKillSwitch: (active) => {
    if (get().mode === "LIVE" && gateway?.readyState === WebSocket.OPEN) {
      sendGatewayCommand({ type: "SET_SANDBOX_KILL_SWITCH", active });
      return;
    }
    localKernel?.setSandboxKillSwitch(active);
  },

  resetRisk: () => {
    if (get().mode === "LIVE" && gateway?.readyState === WebSocket.OPEN) {
      sendGatewayCommand({ type: "RESET_RISK" });
      return;
    }
    localKernel?.resetRisk();
  },

  replayHistory: () => {
    if (get().mode === "LIVE" && gateway?.readyState === WebSocket.OPEN) {
      sendGatewayCommand({ type: "REPLAY_HISTORY" });
      return;
    }
    const history = get().opportunities.filter((opportunity) => Date.now() - opportunity.createdAt <= 5 * 60 * 1000);
    set({ replayOpportunities: history.slice(0, 50) });
    window.setTimeout(() => set({ replayOpportunities: [] }), 6000);
  },

  exportSessionCsv: () => {
    const rows = [
      ["timestamp", "kind", "type", "route", "status", "size_btc", "net_pnl_usd", "gross_pnl_usd", "fees_usd", "slippage_usd", "execution_risk_usd", "score", "net_spread_pct", "edge_survival", "edge_quality"],
      ...get().trades.map((trade) => [
        new Date(trade.executedAt).toISOString(),
        "trade",
        trade.type,
        trade.route,
        trade.status,
        trade.sizeBtc,
        trade.pnlUsd,
        trade.grossPnlUsd,
        trade.feesUsd,
        trade.slippageUsd,
        trade.executionRiskUsd,
        "",
        "",
        "",
        ""
      ]),
      ...get().opportunities.map((opportunity) => [
        new Date(opportunity.createdAt).toISOString(),
        "opportunity",
        opportunity.type,
        opportunity.route,
        opportunity.status,
        opportunity.tradeSizeBtc,
        opportunity.expectedProfitUsd,
        opportunity.grossProfitUsd,
        opportunity.totalFeesUsd,
        opportunity.slippageUsd,
        opportunity.networkCostUsd,
        String(opportunity.score),
        opportunity.netSpreadPct,
        opportunity.edgeModel?.survivalProbability ?? "",
        opportunity.edgeModel?.edgeQuality ?? ""
      ])
    ];
    const csv = rows.map((row) => row.map(csvCell).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `arbitrai-session-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }
}));

function startDemo(set: StoreSet, walletSeed: WalletSeed): void {
  localKernel = new ArbitrAIKernel(walletSeed);
  localKernel.bus.on("gateway:message", (message) => applyGatewayMessage(set, message));
  localKernel.startDemo();
  set({ connected: true, connectionError: "", lastGatewayMessageAt: Date.now(), risk: localKernel.snapshot().risk, wallets: localKernel.snapshot().wallets });
}

function startGateway(set: StoreSet, walletSeed: WalletSeed): void {
  const url = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080";
  const generation = ++gatewayGeneration;
  const socket = new WebSocket(url);
  gateway = socket;
  socket.addEventListener("open", () => {
    if (gateway !== socket || generation !== gatewayGeneration) return;
    set({ connected: true, connectionError: "" });
    const token = window.sessionStorage.getItem("arbitrai-admin-token");
    if (token) sendGatewayCommand({ type: "ADMIN_AUTH", token });
  });
  socket.addEventListener("message", (event) => {
    if (gateway !== socket || generation !== gatewayGeneration) return;
    const now = Date.now();
    if (now - lastGatewayHeartbeatPaintAt > 450) {
      lastGatewayHeartbeatPaintAt = now;
      set({ connected: true, connectionError: "", lastGatewayMessageAt: now });
    }
    try {
      applyGatewayMessage(set, JSON.parse(event.data as string) as GatewayMessage);
    } catch {
      set({ connectionError: "El gateway envió un mensaje inválido. Reintentando sincronización." });
    }
  });
  socket.addEventListener("close", () => {
    if (gateway !== socket || generation !== gatewayGeneration) return;
    gateway = null;
    set({ connected: false, connectionError: "El gateway WebSocket se cerró. Verifica npm run dev:ws o el servicio de Railway." });
    gatewayReconnectTimer = window.setTimeout(() => {
      if (generation === gatewayGeneration && useArbitrageStore.getState().mode === "LIVE") {
        startGateway(set, useArbitrageStore.getState().walletSeed);
      }
    }, 1200);
  });
  socket.addEventListener("error", () => {
    if (gateway !== socket || generation !== gatewayGeneration) return;
    set({ connected: false, connectionError: `No se pudo alcanzar ${url}. El backend está apagado o bloqueado.` });
    socket.close();
  });
}

function stopGateway(): void {
  gatewayGeneration += 1;
  if (gatewayReconnectTimer) {
    clearTimeout(gatewayReconnectTimer);
    gatewayReconnectTimer = null;
  }
  const socket = gateway;
  gateway = null;
  socket?.close();
}

function stopLocalKernel(): void {
  localKernel?.stopDemo();
  localKernel = null;
}

function sendGatewayCommand(command: GatewayCommand): void {
  if (gateway?.readyState === WebSocket.OPEN) gateway.send(JSON.stringify(command));
}

type StoreSet = Parameters<typeof useArbitrageStore.setState>[0] extends never
  ? never
  : (partial: Partial<ArbitrageState> | ((state: ArbitrageState) => Partial<ArbitrageState>)) => void;

function applyGatewayMessage(set: StoreSet, message: GatewayMessage): void {
  if (message.type === "SNAPSHOT") {
    set({
      books: Object.fromEntries(message.books.map((book) => [bookKey(book), book])),
      exchangeStatuses: message.exchangeStatuses ?? stateExchangeStatuses(message.books),
      opportunities: message.opportunities,
      executionQueue: message.executionQueue,
      trades: message.trades,
      wallets: message.wallets,
      risk: message.risk,
      metrics: message.metrics,
      priceSeries: message.priceSeries,
      learning: message.learning,
      executionRuntime: message.executionRuntime,
      scannerUniverse: message.scannerUniverse ?? EXCHANGE_IDS,
      adminAuthenticated: message.adminAuthenticated ?? useArbitrageStore.getState().adminAuthenticated
    });
    return;
  }

  if (message.type === "BOOK") {
    applyBookBatch(set, [message.book]);
    return;
  }

  if (message.type === "BOOK_BATCH") {
    applyBookBatch(set, message.books);
    return;
  }

  if (message.type === "EXCHANGE_STATUS") {
    set({ exchangeStatuses: message.statuses });
    return;
  }

  if (message.type === "OPPORTUNITY") {
    set((state) => ({
      opportunities: [message.opportunity, ...state.opportunities.filter((item) => item.id !== message.opportunity.id)].slice(0, 50),
      executionQueue: message.queue
    }));
    return;
  }

  if (message.type === "TRADE") {
    set((state) => ({
      trades: [message.trade, ...state.trades].slice(0, 100),
      wallets: message.wallets,
      metrics: message.metrics,
      risk: message.risk
    }));
    return;
  }

  if (message.type === "LEARNING") {
    set({ learning: message.summary });
    return;
  }

  if (message.type === "EXECUTION_RUNTIME") {
    set({ executionRuntime: message.runtime });
    return;
  }

  if (message.type === "ADMIN_STATE") {
    if (!message.authenticated && typeof window !== "undefined") window.sessionStorage.removeItem("arbitrai-admin-token");
    set({ adminAuthenticated: message.authenticated, adminMessage: message.reason });
    return;
  }

  if (message.type === "SCANNER_UNIVERSE") {
    set({ scannerUniverse: message.exchanges });
    return;
  }

  if (message.type === "COMMAND_ERROR") {
    set({ adminMessage: message.reason });
    return;
  }

  if (message.type === "REPLAY") {
    set({ replayOpportunities: message.opportunities, trades: message.trades.length ? message.trades : useArbitrageStore.getState().trades });
    window.setTimeout(() => set({ replayOpportunities: [] }), 8000);
    return;
  }

  if (message.type === "RISK") set({ risk: message.risk });
  if (message.type === "METRICS") set({ metrics: message.metrics });
}

function applyBookBatch(set: StoreSet, incomingBooks: NormalizedOrderBook[]): void {
  const btcBooks = incomingBooks.filter((book) => book.symbol === "BTC/USDT");
  if (!btcBooks.length) return;
  set((state) => {
    const books = { ...state.books };
    const flashes = { ...state.flashes };
    let exchangeStatuses = state.exchangeStatuses;
    let priceSeries = state.priceSeries;
    btcBooks.forEach((book) => {
      const key = bookKey(book);
      const previous = books[key];
      books[key] = book;
      flashes[key] = {
        bid: direction(previous?.bids[0]?.price, book.bids[0]?.price),
        ask: direction(previous?.asks[0]?.price, book.asks[0]?.price),
        until: Date.now() + 420
      };
      if (localKernel) exchangeStatuses = updateStatusFromBook(exchangeStatuses, book, "demo");
      priceSeries = localKernel?.marketData.priceHistory() ?? updateLivePriceSeries(priceSeries, book);
    });
    return { books, exchangeStatuses, flashes, priceSeries };
  });
}

function bookKey(book: NormalizedOrderBook): string {
  return `${book.exchange}:${book.symbol}`;
}

function direction(previous?: string, next?: string): "up" | "down" | "flat" {
  if (!previous || !next) return "flat";
  const prev = Number(previous);
  const curr = Number(next);
  if (curr > prev) return "up";
  if (curr < prev) return "down";
  return "flat";
}

export function btcBookKey(exchange: ExchangeId): string {
  return `${exchange}:BTC/USDT`;
}

function updateLivePriceSeries(series: PricePoint[], book: NormalizedOrderBook): PricePoint[] {
  if (book.symbol !== "BTC/USDT") return series;
  const bid = Number(book.bids[0]?.price ?? 0);
  const ask = Number(book.asks[0]?.price ?? 0);
  if (!bid || !ask) return series;
  const nextPrice = (bid + ask) / 2;
  const previous = series.at(-1);
  const next = previous && Date.now() - previous.time < 750 ? { ...previous } : { time: Date.now() };
  next[book.exchange] = nextPrice;
  const updated = previous && previous.time === next.time ? [...series.slice(0, -1), next] : [...series, next];
  return updated.slice(-160);
}

function stateExchangeStatuses(books: NormalizedOrderBook[]): ExchangeConnectionStatus[] {
  return EXCHANGE_IDS.map((exchange) => {
    const exchangeBooks = books.filter((book) => book.exchange === exchange);
    const lastMessageAt = exchangeBooks.reduce((latest, book) => Math.max(latest, book.receivedAt), 0);
    return {
      exchange,
      transport: "websocket",
      status: lastMessageAt ? "live" : "connecting",
      lastMessageAt,
      messageCount: exchangeBooks.length,
      lastError: "",
      reliabilityScore: lastMessageAt ? 92 : 55
    };
  });
}

function updateStatusFromBook(
  statuses: ExchangeConnectionStatus[],
  book: NormalizedOrderBook,
  transport: ExchangeConnectionStatus["transport"]
): ExchangeConnectionStatus[] {
  const existing = statuses.find((status) => status.exchange === book.exchange);
  const next: ExchangeConnectionStatus = {
    exchange: book.exchange,
    transport,
    status: transport === "rest-polling" ? "polling" : "live",
    lastMessageAt: book.receivedAt,
    messageCount: (existing?.messageCount ?? 0) + 1,
    lastError: "",
    reliabilityScore: transport === "rest-polling" ? 76 : 96
  };
  const merged = statuses.filter((status) => status.exchange !== book.exchange);
  return [...merged, next].sort((a, b) => a.exchange.localeCompare(b.exchange));
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
