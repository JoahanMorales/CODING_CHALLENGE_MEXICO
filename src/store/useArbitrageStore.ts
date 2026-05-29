"use client";

import { create } from "zustand";
import { INITIAL_WALLETS } from "@/lib/config/exchanges";
import { ArbitrAIKernel } from "@/lib/services/ArbitrAIKernel";
import type {
  ExchangeId,
  GatewayMessage,
  ExchangeConnectionStatus,
  NormalizedOrderBook,
  Opportunity,
  PerformanceMetrics,
  PricePoint,
  RiskState,
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
  priceSeries: PricePoint[];
  init: () => void;
  setMode: (mode: Mode) => void;
  updateWalletSeed: (exchange: ExchangeId, asset: "btc" | "usdt", value: string) => void;
  applyWalletSeed: () => void;
  simulateMarketCrash: () => void;
  resetRisk: () => void;
  replayHistory: () => void;
}

const defaultRisk: RiskState = {
  status: "SCANNING",
  riskColor: "GREEN",
  circuitBreakerActive: false,
  consecutiveLosses: 0,
  dailyPnlUsd: "0.00",
  dailyLossLimitUsd: "-500.00",
  exposureBtc: "2.500000",
  maxPositionBtc: "0.100",
  haltedReason: "none",
  marketCrashMode: false
};

const defaultMetrics: PerformanceMetrics = {
  opportunitiesDetected: 0,
  executableOpportunities: 0,
  rejectedOpportunities: 0,
  tradesExecuted: 0,
  netPnlUsd: "0.00",
  winRatePct: "0.00",
  averageProfitUsd: "0.00",
  bestTradeUsd: "0.00",
  totalFeesPaidUsd: "0.00",
  opportunityExecutionRatioPct: "0.00",
  averageDetectionLatencyMs: "0.00",
  sharpeLikeRatio: "0.000"
};

let localKernel: ArbitrAIKernel | null = null;
let gateway: WebSocket | null = null;

export const useArbitrageStore = create<ArbitrageState>((set, get) => ({
  mode: "LIVE",
  connected: false,
  connectionError: "",
  lastGatewayMessageAt: 0,
  initialized: false,
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
    set({ mode, connected: false, connectionError: "", books: {}, opportunities: [], executionQueue: [], priceSeries: [] });
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
    set({ connected: false, books: {}, opportunities: [], executionQueue: [], trades: [], priceSeries: [], metrics: defaultMetrics });
    startDemo(set, get().walletSeed);
  },

  simulateMarketCrash: () => {
    if (get().mode === "LIVE" && gateway?.readyState === WebSocket.OPEN) {
      gateway.send("SIMULATE_MARKET_CRASH");
      return;
    }
    localKernel?.simulateMarketCrash();
  },

  resetRisk: () => {
    if (get().mode === "LIVE" && gateway?.readyState === WebSocket.OPEN) {
      gateway.send("RESET_RISK");
      return;
    }
    localKernel?.resetRisk();
  },

  replayHistory: () => {
    const history = get().opportunities.filter((opportunity) => Date.now() - opportunity.createdAt <= 5 * 60 * 1000);
    set({ replayOpportunities: history.slice(0, 50) });
    window.setTimeout(() => set({ replayOpportunities: [] }), 6000);
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
  gateway = new WebSocket(url);
  gateway.addEventListener("open", () => set({ connected: true, connectionError: "" }));
  gateway.addEventListener("message", (event) => {
    set({ connected: true, connectionError: "", lastGatewayMessageAt: Date.now() });
    applyGatewayMessage(set, JSON.parse(event.data as string) as GatewayMessage);
  });
  gateway.addEventListener("close", () => {
    set({ connected: false, connectionError: "Backend WebSocket closed. Start npm run dev:ws or check Railway service." });
    window.setTimeout(() => {
      if (useArbitrageStore.getState().mode === "LIVE") startGateway(set, useArbitrageStore.getState().walletSeed);
    }, 1200);
  });
  gateway.addEventListener("error", () => {
    set({ connected: false, connectionError: "Cannot reach ws://localhost:8080. Backend is offline or blocked." });
    gateway?.close();
  });
}

function stopGateway(): void {
  gateway?.close();
  gateway = null;
}

function stopLocalKernel(): void {
  localKernel?.stopDemo();
  localKernel = null;
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
      priceSeries: message.priceSeries
    });
    return;
  }

  if (message.type === "BOOK") {
    if (message.book.symbol !== "BTC/USDT") return;
    set((state) => {
      const key = bookKey(message.book);
      const previous = state.books[key];
      return {
        books: { ...state.books, [key]: message.book },
        exchangeStatuses: updateStatusFromBook(state.exchangeStatuses, message.book, localKernel ? "demo" : "websocket"),
        flashes: {
          ...state.flashes,
          [key]: {
            bid: direction(previous?.bids[0]?.price, message.book.bids[0]?.price),
            ask: direction(previous?.asks[0]?.price, message.book.asks[0]?.price),
            until: Date.now() + 420
          }
        },
        priceSeries: localKernel?.marketData.priceHistory() ?? updateLivePriceSeries(state.priceSeries, message.book)
      };
    });
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

  if (message.type === "RISK") set({ risk: message.risk });
  if (message.type === "METRICS") set({ metrics: message.metrics });
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
  const exchanges: ExchangeId[] = ["binance", "kraken", "coinbase"];
  return exchanges.map((exchange) => {
    const exchangeBooks = books.filter((book) => book.exchange === exchange);
    const lastMessageAt = exchangeBooks.reduce((latest, book) => Math.max(latest, book.receivedAt), 0);
    return {
      exchange,
      transport: "websocket",
      status: lastMessageAt ? "live" : "connecting",
      lastMessageAt,
      messageCount: exchangeBooks.length,
      lastError: ""
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
    lastError: ""
  };
  const merged = statuses.filter((status) => status.exchange !== book.exchange);
  return [...merged, next].sort((a, b) => a.exchange.localeCompare(b.exchange));
}
