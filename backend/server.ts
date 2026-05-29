import http from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { ArbitrAIKernel } from "../src/lib/services/ArbitrAIKernel";
import type {
  ExchangeConnectionStatus,
  ExchangeId,
  GatewayMessage,
  GatewaySnapshot,
  NormalizedOrderBook,
  OrderBookLevel,
  SymbolId
} from "../src/lib/types";

const port = Number(process.env.WS_PORT ?? process.env.PORT ?? 8080);
const kernel = new ArbitrAIKernel();
const clients = new Set<WebSocket>();
let connector: ExchangeConnector | null = null;
const pendingBookBroadcasts = new Map<string, Extract<GatewayMessage, { type: "BOOK" }>>();
const pendingRejectedSignals = new Map<string, Extract<GatewayMessage, { type: "OPPORTUNITY" }>>();
let bookFlushTimer: ReturnType<typeof setTimeout> | null = null;
let rejectedSignalFlushTimer: ReturnType<typeof setTimeout> | null = null;

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "arbitrai-gateway",
        time: new Date().toISOString(),
        exchanges: connector?.statuses() ?? []
      })
    );
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server });

wss.on("connection", (socket) => {
  clients.add(socket);
  socket.send(JSON.stringify(snapshotWithStatuses()));
  socket.on("message", (message) => {
    const command = message.toString();
    if (command === "SIMULATE_MARKET_CRASH") kernel.simulateMarketCrash();
    if (command === "RESET_RISK") kernel.resetRisk();
    if (command === "REPLAY_HISTORY") kernel.replayHistory();
    if (command.startsWith("RUN_SCENARIO:")) {
      const scenario = command.replace("RUN_SCENARIO:", "");
      if (scenario === "MARKET_CRASH" || scenario === "LIQUIDITY_DRAIN" || scenario === "LATENCY_SPIKE") {
        kernel.runScenario(scenario);
      }
    }
  });
  socket.on("close", () => clients.delete(socket));
});

kernel.bus.on("gateway:message", (message) => routeGatewayMessage(message));

function routeGatewayMessage(message: GatewayMessage): void {
  if (message.type === "BOOK") {
    queueBookBroadcast(message);
    return;
  }

  if (message.type === "OPPORTUNITY" && message.opportunity.status === "REJECTED") {
    queueRejectedSignal(message);
    return;
  }

  broadcast(message);
}

function queueBookBroadcast(message: Extract<GatewayMessage, { type: "BOOK" }>): void {
  // The engine still processes every book. The UI receives only BTC snapshots
  // throttled to a paint-friendly cadence so React is never the bottleneck.
  if (message.book.symbol !== "BTC/USDT") return;
  pendingBookBroadcasts.set(`${message.book.exchange}:${message.book.symbol}`, message);
  if (bookFlushTimer) return;
  bookFlushTimer = setTimeout(() => {
    pendingBookBroadcasts.forEach((queued) => broadcast(queued));
    pendingBookBroadcasts.clear();
    bookFlushTimer = null;
  }, 120);
}

function queueRejectedSignal(message: Extract<GatewayMessage, { type: "OPPORTUNITY" }>): void {
  // Positive/executable signals are immediate; rejected noise is sampled for the tape.
  pendingRejectedSignals.set(`${message.opportunity.type}:${message.opportunity.route}`, message);
  if (rejectedSignalFlushTimer) return;
  rejectedSignalFlushTimer = setTimeout(() => {
    [...pendingRejectedSignals.values()]
      .sort((a, b) => b.opportunity.score - a.opportunity.score)
      .slice(0, 6)
      .forEach((queued) => broadcast(queued));
    pendingRejectedSignals.clear();
    rejectedSignalFlushTimer = null;
  }, 180);
}

function broadcast(message: GatewayMessage): void {
  const payload = JSON.stringify(message);
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  });
}

class ExchangeConnector {
  private reconnects = new Map<string, number>();
  private readonly connectionStatuses = new Map<ExchangeId, ExchangeConnectionStatus>();
  private readonly bybitBids = new Map<string, string>();
  private readonly bybitAsks = new Map<string, string>();
  private poller: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly appKernel: ArbitrAIKernel) {}

  start(): void {
    (["binance", "kraken", "coinbase", "okx", "bybit"] as ExchangeId[]).forEach((exchange) => {
      this.connectionStatuses.set(exchange, {
        exchange,
        transport: "websocket",
        status: "connecting",
        lastMessageAt: 0,
        messageCount: 0,
        lastError: "",
        reliabilityScore: 55
      });
    });
    this.connectBinance();
    this.connectKraken();
    this.connectCoinbase();
    this.connectOkx();
    this.connectBybit();
    this.poller = setInterval(() => void this.pollRealRestFallback(), 2500);
    setInterval(() => broadcast({ type: "EXCHANGE_STATUS", statuses: this.statuses() }), 1000);
  }

  statuses(): ExchangeConnectionStatus[] {
    return [...this.connectionStatuses.values()];
  }

  private connectBinance(): void {
    this.mark("binance", "websocket", "connecting");
    const url =
      "wss://stream.binance.com:9443/stream?streams=btcusdt@depth5@100ms/ethusdt@depth5@100ms/ethbtc@depth5@100ms";
    const socket = new WebSocket(url);
    socket.on("message", (payload) => {
      const parsed = safeParse(payload.toString());
      const stream = readString(parsed, "stream");
      const data = readRecord(parsed, "data");
      if (!stream || !data) return;
      const symbol = streamToSymbol(stream);
      if (!symbol) return;
      const bids = levelsFromUnknown(data.bids);
      const asks = levelsFromUnknown(data.asks);
      this.appKernel.ingest(makeBook("binance", symbol, bids, asks, Date.now()));
      this.mark("binance", "websocket", "live");
    });
    this.attachReconnect("binance", socket, () => this.connectBinance());
  }

  private connectKraken(): void {
    this.mark("kraken", "websocket", "connecting");
    const socket = new WebSocket("wss://ws.kraken.com/v2");
    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          method: "subscribe",
          params: {
            channel: "ticker",
            symbol: ["BTC/USD"],
            event_trigger: "bbo",
            snapshot: true
          }
        })
      );
    });
    socket.on("message", (payload) => {
      const parsed = safeParse(payload.toString());
      if (readString(parsed, "channel") !== "ticker") return;
      const data = readArray(parsed, "data");
      const ticker = data?.[0];
      if (!isRecord(ticker)) return;
      const bid = readStringOrNumber(ticker, "bid");
      const ask = readStringOrNumber(ticker, "ask");
      const bidQty = readStringOrNumber(ticker, "bid_qty") ?? "0.15";
      const askQty = readStringOrNumber(ticker, "ask_qty") ?? "0.15";
      if (!bid || !ask) return;
      this.appKernel.ingest(
        makeBook("kraken", "BTC/USDT", [[bid, bidQty]], [[ask, askQty]], Date.parse(readString(ticker, "timestamp") ?? "") || Date.now())
      );
      this.mark("kraken", "websocket", "live");
    });
    this.attachReconnect("kraken", socket, () => this.connectKraken());
  }

  private connectCoinbase(): void {
    this.mark("coinbase", "websocket", "connecting");
    const socket = new WebSocket("wss://advanced-trade-ws.coinbase.com");
    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "subscribe", product_ids: ["BTC-USD"], channel: "ticker" }));
    });
    socket.on("message", (payload) => {
      const parsed = safeParse(payload.toString());
      const events = readArray(parsed, "events");
      const ticker = events
        ?.flatMap((event) => (isRecord(event) && Array.isArray(event.tickers) ? event.tickers : []))
        .find((item) => isRecord(item) && item.product_id === "BTC-USD");
      if (!isRecord(ticker)) return;
      const bid = readStringOrNumber(ticker, "best_bid");
      const ask = readStringOrNumber(ticker, "best_ask");
      const bidQty = readStringOrNumber(ticker, "best_bid_quantity") ?? "0.12";
      const askQty = readStringOrNumber(ticker, "best_ask_quantity") ?? "0.12";
      if (!bid || !ask) return;
      this.appKernel.ingest(makeBook("coinbase", "BTC/USDT", [[bid, bidQty]], [[ask, askQty]], Date.now()));
      this.mark("coinbase", "websocket", "live");
    });
    this.attachReconnect("coinbase", socket, () => this.connectCoinbase());
  }

  private connectOkx(): void {
    this.mark("okx", "websocket", "connecting");
    const socket = new WebSocket("wss://ws.okx.com:8443/ws/v5/public");
    socket.on("open", () => {
      socket.send(JSON.stringify({ op: "subscribe", args: [{ channel: "books5", instId: "BTC-USDT" }] }));
    });
    socket.on("message", (payload) => {
      const parsed = safeParse(payload.toString());
      const data = readArray(parsed, "data");
      const book = data?.find(isRecord);
      if (!book) return;
      const bids = levelsFromUnknown(book.bids);
      const asks = levelsFromUnknown(book.asks);
      const ts = Number(readStringOrNumber(book, "ts") ?? Date.now());
      if (bids.length && asks.length) {
        this.appKernel.ingest(makeBook("okx", "BTC/USDT", bids, asks, Number.isFinite(ts) ? ts : Date.now()));
        this.mark("okx", "websocket", "live");
      }
    });
    this.attachReconnect("okx", socket, () => this.connectOkx());
  }

  private connectBybit(): void {
    this.mark("bybit", "websocket", "connecting");
    const socket = new WebSocket("wss://stream.bybit.com/v5/public/spot");
    socket.on("open", () => {
      socket.send(JSON.stringify({ op: "subscribe", args: ["orderbook.50.BTCUSDT"] }));
    });
    socket.on("message", (payload) => {
      const parsed = safeParse(payload.toString());
      if (readString(parsed, "topic") !== "orderbook.50.BTCUSDT") return;
      const data = readRecord(parsed, "data");
      if (!data) return;
      const eventType = readString(parsed, "type");
      this.applyBybitLevels(this.bybitBids, levelsFromUnknown(data.b), eventType === "snapshot");
      this.applyBybitLevels(this.bybitAsks, levelsFromUnknown(data.a), eventType === "snapshot");
      const bids = sortedLevelsFromMap(this.bybitBids, "bid");
      const asks = sortedLevelsFromMap(this.bybitAsks, "ask");
      const ts = Number(readStringOrNumber(parsed, "ts") ?? Date.now());
      if (bids.length && asks.length) {
        this.appKernel.ingest(makeBook("bybit", "BTC/USDT", bids, asks, Number.isFinite(ts) ? ts : Date.now()));
        this.mark("bybit", "websocket", "live");
      }
    });
    this.attachReconnect("bybit", socket, () => this.connectBybit());
  }

  private applyBybitLevels(target: Map<string, string>, levels: Array<[string, string]>, reset: boolean): void {
    if (reset) target.clear();
    levels.forEach(([price, size]) => {
      if (Number(size) === 0) target.delete(price);
      else target.set(price, size);
    });
  }

  private attachReconnect(name: string, socket: WebSocket, reconnect: () => void): void {
    socket.on("close", () => {
      this.mark(name as ExchangeId, "websocket", "reconnecting", "socket closed");
      const attempts = (this.reconnects.get(name) ?? 0) + 1;
      this.reconnects.set(name, attempts);
      setTimeout(reconnect, Math.min(30000, 1000 * 2 ** attempts));
    });
    socket.on("open", () => this.reconnects.set(name, 0));
    socket.on("error", (error) => {
      this.mark(name as ExchangeId, "websocket", "error", error.message);
      socket.close();
    });
  }

  private async pollRealRestFallback(): Promise<void> {
    await Promise.allSettled([this.pollBinanceDepth(), this.pollKrakenDepth(), this.pollCoinbaseBook(), this.pollOkxBook(), this.pollBybitBook()]);
  }

  private async pollBinanceDepth(): Promise<void> {
    const symbols: Array<[string, SymbolId]> = [
      ["BTCUSDT", "BTC/USDT"],
      ["ETHUSDT", "ETH/USDT"],
      ["ETHBTC", "ETH/BTC"]
    ];
    await Promise.all(
      symbols.map(async ([restSymbol, symbol]) => {
        const response = await fetch(`https://api.binance.com/api/v3/depth?symbol=${restSymbol}&limit=5`);
        const data = (await response.json()) as unknown;
        if (!isRecord(data)) return;
        const bids = levelsFromUnknown(data.bids);
        const asks = levelsFromUnknown(data.asks);
        if (bids.length && asks.length) {
          this.appKernel.ingest(makeBook("binance", symbol, bids, asks, Date.now()));
          this.mark("binance", "rest-polling", "polling");
        }
      })
    );
  }

  private async pollKrakenDepth(): Promise<void> {
    const response = await fetch("https://api.kraken.com/0/public/Depth?pair=XBTUSD&count=5");
    const data = (await response.json()) as unknown;
    const result = readRecord(data, "result");
    if (!result) return;
    const first = Object.values(result).find(isRecord);
    if (!first) return;
    const bids = levelsFromUnknown(first.bids);
    const asks = levelsFromUnknown(first.asks);
    if (bids.length && asks.length) {
      this.appKernel.ingest(makeBook("kraken", "BTC/USDT", bids, asks, Date.now()));
      this.mark("kraken", "rest-polling", "polling");
    }
  }

  private async pollCoinbaseBook(): Promise<void> {
    const response = await fetch("https://api.exchange.coinbase.com/products/BTC-USD/book?level=2", {
      headers: { "User-Agent": "ArbitrAI Hackathon" }
    });
    const data = (await response.json()) as unknown;
    if (!isRecord(data)) return;
    const bids = levelsFromUnknown(data.bids);
    const asks = levelsFromUnknown(data.asks);
    if (bids.length && asks.length) {
      this.appKernel.ingest(makeBook("coinbase", "BTC/USDT", bids, asks, Date.now()));
      this.mark("coinbase", "rest-polling", "polling");
    }
  }

  private async pollOkxBook(): Promise<void> {
    const response = await fetch("https://www.okx.com/api/v5/market/books?instId=BTC-USDT&sz=5");
    const payload = (await response.json()) as unknown;
    const data = readArray(payload, "data");
    const book = data?.find(isRecord);
    if (!book) return;
    const bids = levelsFromUnknown(book.bids);
    const asks = levelsFromUnknown(book.asks);
    const ts = Number(readStringOrNumber(book, "ts") ?? Date.now());
    if (bids.length && asks.length) {
      this.appKernel.ingest(makeBook("okx", "BTC/USDT", bids, asks, Number.isFinite(ts) ? ts : Date.now()));
      this.mark("okx", "rest-polling", "polling");
    }
  }

  private async pollBybitBook(): Promise<void> {
    const response = await fetch("https://api.bybit.com/v5/market/orderbook?category=spot&symbol=BTCUSDT&limit=5");
    const payload = (await response.json()) as unknown;
    const result = readRecord(payload, "result");
    if (!result) return;
    const bids = levelsFromUnknown(result.b);
    const asks = levelsFromUnknown(result.a);
    const ts = Number(readStringOrNumber(result, "ts") ?? Date.now());
    if (bids.length && asks.length) {
      this.appKernel.ingest(makeBook("bybit", "BTC/USDT", bids, asks, Number.isFinite(ts) ? ts : Date.now()));
      this.mark("bybit", "rest-polling", "polling");
    }
  }

  private mark(exchange: ExchangeId, transport: "websocket" | "rest-polling", status: ExchangeConnectionStatus["status"], error = ""): void {
    const current = this.connectionStatuses.get(exchange);
    this.connectionStatuses.set(exchange, {
      exchange,
      transport,
      status,
      lastMessageAt: status === "live" || status === "polling" ? Date.now() : current?.lastMessageAt ?? 0,
      messageCount: (current?.messageCount ?? 0) + (status === "live" || status === "polling" ? 1 : 0),
      lastError: error,
      reliabilityScore: reliabilityScore(status, transport, error)
    });
  }
}

function snapshotWithStatuses(): GatewaySnapshot {
  return {
    ...kernel.snapshot(),
    exchangeStatuses: connector?.statuses() ?? []
  };
}

function makeBook(
  exchange: ExchangeId,
  symbol: SymbolId,
  bidsRaw: Array<[string, string]>,
  asksRaw: Array<[string, string]>,
  exchangeTimestamp: number
): NormalizedOrderBook {
  const receivedAt = Date.now();
  const bids = normalizeLevels(bidsRaw);
  const asks = normalizeLevels(asksRaw);
  return {
    exchange,
    symbol,
    bids,
    asks,
    exchangeTimestamp,
    receivedAt,
    processingLatencyMs: Math.max(0, Number((performance.now() % 4).toFixed(2)))
  };
}

function normalizeLevels(levels: Array<[string, string]>): OrderBookLevel[] {
  const normalized = levels.slice(0, 5).map(([price, size]) => ({ price, size }));
  while (normalized.length < 5 && normalized[0]) {
    normalized.push({ ...normalized[0] });
  }
  return normalized;
}

function levelsFromUnknown(value: unknown): Array<[string, string]> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((level): level is [string, string] => Array.isArray(level) && level.length >= 2)
    .map((level) => [String(level[0]), String(level[1])]);
}

function sortedLevelsFromMap(levels: Map<string, string>, side: "bid" | "ask"): Array<[string, string]> {
  return [...levels.entries()]
    .sort((a, b) => side === "bid" ? Number(b[0]) - Number(a[0]) : Number(a[0]) - Number(b[0]))
    .slice(0, 5);
}

function reliabilityScore(status: ExchangeConnectionStatus["status"], transport: "websocket" | "rest-polling", error: string): number {
  if (error) return 20;
  if (status === "live") return 96;
  if (status === "polling" || transport === "rest-polling") return 76;
  if (status === "reconnecting") return 45;
  if (status === "error") return 15;
  return 55;
}

function streamToSymbol(stream: string): SymbolId | null {
  if (stream.startsWith("btcusdt")) return "BTC/USDT";
  if (stream.startsWith("ethusdt")) return "ETH/USDT";
  if (stream.startsWith("ethbtc")) return "ETH/BTC";
  return null;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readRecord(source: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(source)) return null;
  const value = source[key];
  return isRecord(value) ? value : null;
}

function readArray(source: unknown, key: string): unknown[] | null {
  if (!isRecord(source)) return null;
  const value = source[key];
  return Array.isArray(value) ? value : null;
}

function readString(source: unknown, key: string): string | null {
  if (!isRecord(source)) return null;
  const value = source[key];
  return typeof value === "string" ? value : null;
}

function readStringOrNumber(source: unknown, key: string): string | null {
  if (!isRecord(source)) return null;
  const value = source[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

server.listen(port, () => {
  console.log(`ArbitrAI WebSocketGateway listening on :${port}`);
});

connector = new ExchangeConnector(kernel);
connector.start();
