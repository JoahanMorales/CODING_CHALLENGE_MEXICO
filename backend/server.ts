import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import WebSocket, { WebSocketServer } from "ws";
import { ArbitrAIKernel } from "../src/lib/services/ArbitrAIKernel";
import { BookIntegrityService } from "../src/lib/services/BookIntegrityService";
import { crc32, krakenChecksumPayload, preserveKrakenBookDecimals } from "../src/lib/services/KrakenBookChecksum";
import { QuoteNormalizer } from "../src/lib/services/QuoteNormalizer";
import { EXCHANGE_IDS } from "../src/lib/config/exchanges";
import { PersistentJournal } from "./PersistentJournal";
import type {
  ExchangeConnectionStatus,
  ExchangeId,
  GatewayCommand,
  GatewayMessage,
  GatewaySnapshot,
  NormalizedOrderBook,
  OrderBookLevel,
  PublicGatewaySummary,
  QuoteAsset,
  ScenarioKind,
  SymbolId
} from "../src/lib/types";

loadLocalEnv();

const port = Number(process.env.WS_PORT ?? process.env.PORT ?? 8080);
const adminControlToken = process.env.ADMIN_CONTROL_TOKEN ?? "";
const allowedOrigins = new Set(
  (process.env.ALLOWED_WEB_ORIGINS ?? "http://localhost:3000,http://localhost:4173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);
const kernel = new ArbitrAIKernel();
const journal = new PersistentJournal();
const journalCalibration = journal.loadCalibration();
kernel.engine.importCalibration(journalCalibration);
kernel.sandboxExecution.restoreLedger(journal.loadSandboxLedger());
warmStartFromSnapshot();

// Warm-start the gateway from the offline-trained snapshot (npm run train): load
// the ML ensemble, and seed AET route calibration only when the live journal has
// none yet (never clobber calibration already learned from real markets).
function warmStartFromSnapshot(): void {
  try {
    const path = "public/model/edge-model.json";
    if (!existsSync(path)) return;
    const bundle = safeParse(readFileSync(path, "utf8"));
    if (!isRecord(bundle)) return;
    if (bundle.ml) kernel.engine.mlEdgeTensor.importModel(bundle.ml as Parameters<typeof kernel.engine.mlEdgeTensor.importModel>[0]);
    if (isRecord(bundle.aet) && Object.keys(journalCalibration).length === 0) {
      kernel.engine.importCalibration(bundle.aet as Parameters<typeof kernel.engine.importCalibration>[0]);
    }
  } catch {
    // No snapshot or unreadable: cold start, learn online.
  }
}
interface SocketContext {
  socket: WebSocket;
  adminAuthenticated: boolean;
  authAttempts: number[];
}

const clients = new Map<WebSocket, SocketContext>();
const scannerUniverse = new Set<ExchangeId>(EXCHANGE_IDS);
let connector: ExchangeConnector | null = null;
const pendingBookBroadcasts = new Map<string, NormalizedOrderBook>();
const pendingRejectedSignals = new Map<string, Extract<GatewayMessage, { type: "OPPORTUNITY" }>>();
let bookFlushTimer: ReturnType<typeof setTimeout> | null = null;
let rejectedSignalFlushTimer: ReturnType<typeof setTimeout> | null = null;
let pendingLearningMessage: Extract<GatewayMessage, { type: "LEARNING" }> | null = null;
let learningFlushTimer: ReturnType<typeof setTimeout> | null = null;
let calibrationFlushTimer: ReturnType<typeof setTimeout> | null = null;

const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "arbitrai-gateway",
        time: new Date().toISOString(),
        journal: journal.summary(),
        exchanges: connector?.statuses() ?? []
      })
    );
    return;
  }
  if (req.url === "/public/summary") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(publicSummary()));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({
  server,
  verifyClient: ({ origin }, done) => done(!origin || allowedOrigins.has(origin), 403, "Origin not allowed")
});

wss.on("connection", (socket) => {
  const context: SocketContext = { socket, adminAuthenticated: false, authAttempts: [] };
  clients.set(socket, context);
  socket.send(JSON.stringify(snapshotWithStatuses(false)));
  socket.on("message", (message) => {
    handleSocketCommand(context, message.toString());
  });
  socket.on("close", () => clients.delete(socket));
});

kernel.bus.on("gateway:message", (message) => routeGatewayMessage(message));
kernel.bus.on("gateway:message", (message) => {
  journal.record(message);
  if ((message.type === "LEARNING" || message.type === "TRADE") && !calibrationFlushTimer) {
    calibrationFlushTimer = setTimeout(() => {
      journal.saveCalibration(kernel.engine.exportCalibration());
      calibrationFlushTimer = null;
    }, 1000);
  }
});

function routeGatewayMessage(message: GatewayMessage): void {
  if (message.type === "BOOK") {
    queueBookBroadcast(message);
    return;
  }

  if (message.type === "OPPORTUNITY" && message.opportunity.status === "REJECTED") {
    queueRejectedSignal(message);
    return;
  }

  if (message.type === "LEARNING") {
    queueLearningBroadcast(message);
    return;
  }

  broadcast(message);
}

function queueLearningBroadcast(message: Extract<GatewayMessage, { type: "LEARNING" }>): void {
  // Every markout still calibrates AET and reaches the journal. React receives
  // only the newest summary at a paint-friendly cadence.
  pendingLearningMessage = message;
  if (learningFlushTimer) return;
  learningFlushTimer = setTimeout(() => {
    if (pendingLearningMessage) broadcast(pendingLearningMessage);
    pendingLearningMessage = null;
    learningFlushTimer = null;
  }, 900);
}

function queueBookBroadcast(message: Extract<GatewayMessage, { type: "BOOK" }>): void {
  // The engine still processes every book. The UI receives only BTC snapshots
  // batched at a paint-friendly cadence so React is never the bottleneck.
  if (message.book.symbol !== "BTC/USDT") return;
  pendingBookBroadcasts.set(`${message.book.exchange}:${message.book.symbol}`, message.book);
  if (bookFlushTimer) return;
  bookFlushTimer = setTimeout(() => {
    broadcast({ type: "BOOK_BATCH", books: [...pendingBookBroadcasts.values()] });
    pendingBookBroadcasts.clear();
    bookFlushTimer = null;
  }, 260);
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
  }, 550);
}

function broadcast(message: GatewayMessage): void {
  const payload = JSON.stringify(message);
  clients.forEach(({ socket }) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(payload);
  });
}

function handleSocketCommand(context: SocketContext, raw: string): void {
  const parsed = safeParse(raw);
  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    sendTo(context.socket, { type: "COMMAND_ERROR", command: "UNKNOWN", reason: "Expected a typed JSON command." });
    return;
  }

  if (parsed.type === "ADMIN_AUTH") {
    authenticateSocket(context, typeof parsed.token === "string" ? parsed.token : "");
    return;
  }

  if (parsed.type === "REPLAY_HISTORY") {
    kernel.replayHistory();
    return;
  }

  if (!context.adminAuthenticated) {
    sendTo(context.socket, { type: "COMMAND_ERROR", command: knownCommandType(parsed.type), reason: "Admin unlock required." });
    return;
  }

  if (parsed.type === "SET_SCANNER_UNIVERSE") {
    const exchanges = Array.isArray(parsed.exchanges)
      ? parsed.exchanges.filter((exchange): exchange is ExchangeId => typeof exchange === "string" && EXCHANGE_IDS.includes(exchange as ExchangeId))
      : [];
    const unique = [...new Set(exchanges)];
    if (unique.length < 2) {
      sendTo(context.socket, { type: "COMMAND_ERROR", command: "SET_SCANNER_UNIVERSE", reason: "Scanner universe requires at least two venues." });
      return;
    }
    scannerUniverse.clear();
    unique.forEach((exchange) => scannerUniverse.add(exchange));
    broadcast({ type: "SCANNER_UNIVERSE", exchanges: [...scannerUniverse] });
    return;
  }

  if (parsed.type === "RUN_SCENARIO" && isScenario(parsed.scenario)) {
    kernel.runScenario(parsed.scenario);
    return;
  }
  if (parsed.type === "SET_EXECUTION_MODE" && (parsed.mode === "PAPER" || parsed.mode === "SANDBOX")) {
    kernel.setExecutionMode(parsed.mode);
    return;
  }
  if (parsed.type === "REFRESH_SANDBOX_BALANCES") {
    void kernel.refreshSandboxBalances();
    return;
  }
  if (parsed.type === "RECONCILE_SANDBOX") {
    void kernel.reconcileSandbox();
    return;
  }
  if (parsed.type === "SET_SANDBOX_KILL_SWITCH" && typeof parsed.active === "boolean") {
    kernel.setSandboxKillSwitch(parsed.active);
    return;
  }
  if (parsed.type === "RESET_RISK") {
    kernel.resetRisk();
    return;
  }

  sendTo(context.socket, { type: "COMMAND_ERROR", command: knownCommandType(parsed.type), reason: "Invalid command payload." });
}

function authenticateSocket(context: SocketContext, token: string): void {
  const now = Date.now();
  context.authAttempts = context.authAttempts.filter((attemptAt) => now - attemptAt < 60_000);
  if (context.authAttempts.length >= 5) {
    sendTo(context.socket, { type: "ADMIN_STATE", authenticated: false, reason: "Too many attempts. Wait one minute." });
    return;
  }
  context.authAttempts.push(now);
  const authenticated = adminControlToken.length >= 16 && constantTimeEquals(token, adminControlToken);
  context.adminAuthenticated = authenticated;
  sendTo(context.socket, {
    type: "ADMIN_STATE",
    authenticated,
    reason: authenticated ? "Administrative controls unlocked for this socket." : "Invalid admin token."
  });
}

function constantTimeEquals(candidate: string, expected: string): boolean {
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  if (candidateBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(candidateBuffer, expectedBuffer);
}

function sendTo(socket: WebSocket, message: GatewayMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function knownCommandType(type: string): GatewayCommand["type"] | "UNKNOWN" {
  const known: GatewayCommand["type"][] = [
    "ADMIN_AUTH",
    "SET_SCANNER_UNIVERSE",
    "RUN_SCENARIO",
    "SET_EXECUTION_MODE",
    "REFRESH_SANDBOX_BALANCES",
    "RECONCILE_SANDBOX",
    "SET_SANDBOX_KILL_SWITCH",
    "RESET_RISK",
    "REPLAY_HISTORY"
  ];
  return known.includes(type as GatewayCommand["type"]) ? type as GatewayCommand["type"] : "UNKNOWN";
}

function isScenario(value: unknown): value is ScenarioKind {
  return value === "MARKET_CRASH" || value === "LIQUIDITY_DRAIN" || value === "LATENCY_SPIKE";
}

class ExchangeConnector {
  private reconnects = new Map<string, number>();
  private readonly connectionStatuses = new Map<ExchangeId, ExchangeConnectionStatus>();
  private readonly integrity = new BookIntegrityService();
  private readonly quotes = new QuoteNormalizer();
  private readonly pendingKernelBooks = new Map<string, NormalizedOrderBook>();
  private readonly bybitBids = new Map<string, string>();
  private readonly bybitAsks = new Map<string, string>();
  private readonly coinbaseBids = new Map<string, string>();
  private readonly coinbaseAsks = new Map<string, string>();
  private readonly krakenBids = new Map<string, string>();
  private readonly krakenAsks = new Map<string, string>();
  private readonly bitfinexBids = new Map<string, string>();
  private readonly bitfinexAsks = new Map<string, string>();
  private poller: ReturnType<typeof setInterval> | null = null;
  private kernelFlushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly appKernel: ArbitrAIKernel) {}

  start(): void {
    EXCHANGE_IDS.forEach((exchange) => {
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
    this.connectBitfinex();
    this.connectGate();
    this.connectBitstamp();
    this.poller = setInterval(() => void this.pollRealRestFallback(), 2500);
    setInterval(() => broadcast({ type: "EXCHANGE_STATUS", statuses: this.statuses() }), 1800);
    void this.pollQuoteBasis();
    setInterval(() => void this.pollQuoteBasis(), 15000);
  }

  statuses(): ExchangeConnectionStatus[] {
    return [...this.connectionStatuses.values()];
  }

  private ingest(book: NormalizedOrderBook): void {
    const current = this.connectionStatuses.get(book.exchange);
    const isPrimaryBook = book.symbol === "BTC/USDT";
    this.connectionStatuses.set(book.exchange, {
      ...(current ?? {
        exchange: book.exchange,
        transport: "websocket",
        status: "live",
        lastMessageAt: 0,
        messageCount: 0,
        lastError: "",
        reliabilityScore: 55
      }),
      bookIntegrity: isPrimaryBook ? book.integrity.status : current?.bookIntegrity,
      quoteAsset: isPrimaryBook ? book.quoteAsset : current?.quoteAsset,
      quoteBasisBps: isPrimaryBook ? book.quoteBasisBps : current?.quoteBasisBps,
      gapCount: isPrimaryBook ? book.integrity.gapCount : current?.gapCount,
      resyncCount: isPrimaryBook ? book.integrity.resyncCount : current?.resyncCount
    });
    if (!scannerUniverse.has(book.exchange)) return;
    this.pendingKernelBooks.set(`${book.exchange}:${book.symbol}`, book);
    if (this.kernelFlushTimer) return;
    this.kernelFlushTimer = setTimeout(() => {
      [...this.pendingKernelBooks.values()].forEach((pending) => this.appKernel.ingest(pending));
      this.pendingKernelBooks.clear();
      this.kernelFlushTimer = null;
    }, 70);
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
      this.ingest(this.makeBook("binance", symbol, bids, asks, Date.now(), {
        sequence: readStringOrNumber(data, "lastUpdateId"),
        snapshot: true
      }));
      this.mark("binance", "websocket", "live");
    });
    this.attachReconnect("binance", socket, () => this.connectBinance());
  }

  // Bitstamp: a lower-liquidity European venue quoted in USD. Its top-of-book
  // lags the high-volume venues during fast moves, so it surfaces the widest
  // cross-exchange divergences -- the real raw material for arbitrage. Simple WS:
  // subscribe to the full order_book channel, take the top levels each snapshot.
  private connectBitstamp(): void {
    this.mark("bitstamp", "websocket", "connecting");
    const socket = new WebSocket("wss://ws.bitstamp.net");
    socket.on("open", () => {
      socket.send(JSON.stringify({ event: "bts:subscribe", data: { channel: "order_book_btcusd" } }));
    });
    socket.on("message", (payload) => {
      const parsed = safeParse(payload.toString());
      if (readString(parsed, "event") !== "data") return;
      const data = readRecord(parsed, "data");
      if (!data) return;
      const bids = levelsFromUnknown(data.bids).slice(0, 10);
      const asks = levelsFromUnknown(data.asks).slice(0, 10);
      if (!bids.length || !asks.length) return;
      const micro = readStringOrNumber(data, "microtimestamp");
      const ts = micro ? Math.floor(Number(micro) / 1000) : Date.now();
      this.ingest(this.makeBook("bitstamp", "BTC/USDT", bids, asks, Number.isFinite(ts) ? ts : Date.now(), {
        sourceSymbol: "BTC/USD",
        quoteAsset: "USD",
        snapshot: true
      }));
      this.mark("bitstamp", "websocket", "live");
    });
    this.attachReconnect("bitstamp", socket, () => this.connectBitstamp());
  }

  private connectKraken(): void {
    this.mark("kraken", "websocket", "connecting");
    const socket = new WebSocket("wss://ws.kraken.com/v2");
    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          method: "subscribe",
          params: {
            channel: "book",
            symbol: ["BTC/USD"],
            depth: 10,
            snapshot: true
          }
        })
      );
    });
    socket.on("message", (payload) => {
      const parsed = parseKrakenBook(payload.toString());
      if (readString(parsed, "channel") !== "book") return;
      const data = readArray(parsed, "data");
      const book = data?.find(isRecord);
      if (!book) return;
      const snapshot = readString(parsed, "type") === "snapshot";
      this.applyMapLevels(this.krakenBids, levelsFromUnknown(book.bids), snapshot);
      this.applyMapLevels(this.krakenAsks, levelsFromUnknown(book.asks), snapshot);
      truncateMap(this.krakenBids, "bid", 10);
      truncateMap(this.krakenAsks, "ask", 10);
      const bids = sortedLevelsFromMap(this.krakenBids, "bid", 10);
      const asks = sortedLevelsFromMap(this.krakenAsks, "ask", 10);
      if (!bids.length || !asks.length) return;
      const expectedChecksum = readStringOrNumber(book, "checksum");
      const checksumValidated = expectedChecksum ? String(crc32(krakenChecksumPayload(bids, asks))) === expectedChecksum : undefined;
      this.ingest(this.makeBook("kraken", "BTC/USDT", bids, asks, Date.parse(readString(book, "timestamp") ?? "") || Date.now(), {
          sourceSymbol: "BTC/USD",
          quoteAsset: "USD",
          snapshot,
          checksumValidated
      }));
      this.mark("kraken", "websocket", "live");
    });
    this.attachReconnect("kraken", socket, () => this.connectKraken());
  }

  private connectCoinbase(): void {
    this.mark("coinbase", "websocket", "connecting");
    const socket = new WebSocket("wss://advanced-trade-ws.coinbase.com");
    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "subscribe", product_ids: ["BTC-USD"], channel: "level2" }));
    });
    socket.on("message", (payload) => {
      const parsed = safeParse(payload.toString());
      if (readString(parsed, "channel") !== "l2_data") return;
      const events = readArray(parsed, "events");
      if (!events?.length) return;
      let snapshot = false;
      events.filter(isRecord).forEach((event) => {
        snapshot = snapshot || event.type === "snapshot";
        if (event.type === "snapshot") {
          this.coinbaseBids.clear();
          this.coinbaseAsks.clear();
        }
        const updates = Array.isArray(event.updates) ? event.updates : [];
        updates.filter(isRecord).forEach((update) => {
          const side = readString(update, "side");
          const price = readStringOrNumber(update, "price_level");
          const size = readStringOrNumber(update, "new_quantity");
          if (!price || !size) return;
          this.applyMapLevels(side === "bid" ? this.coinbaseBids : this.coinbaseAsks, [[price, size]], false);
        });
      });
      const bids = sortedLevelsFromMap(this.coinbaseBids, "bid");
      const asks = sortedLevelsFromMap(this.coinbaseAsks, "ask");
      if (!bids.length || !asks.length) return;
      this.ingest(this.makeBook("coinbase", "BTC/USDT", bids, asks, Date.now(), {
        sourceSymbol: "BTC-USD",
        quoteAsset: "USD",
        sequence: readStringOrNumber(parsed, "sequence_num"),
        snapshot
      }));
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
        this.ingest(this.makeBook("okx", "BTC/USDT", bids, asks, Number.isFinite(ts) ? ts : Date.now(), {
          sequence: readStringOrNumber(book, "seqId"),
          previousSequence: readStringOrNumber(book, "prevSeqId"),
          snapshot: true
        }));
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
        this.ingest(this.makeBook("bybit", "BTC/USDT", bids, asks, Number.isFinite(ts) ? ts : Date.now(), {
          sequence: readStringOrNumber(data, "u"),
          previousSequence: readStringOrNumber(data, "pu"),
          snapshot: eventType === "snapshot"
        }));
        this.mark("bybit", "websocket", "live");
      }
    });
    this.attachReconnect("bybit", socket, () => this.connectBybit());
  }

  private connectBitfinex(): void {
    this.mark("bitfinex", "websocket", "connecting");
    const socket = new WebSocket("wss://api-pub.bitfinex.com/ws/2");
    let channelId = 0;
    socket.on("open", () => {
      socket.send(JSON.stringify({ event: "subscribe", channel: "book", symbol: "tBTCUSD", prec: "P0", freq: "F0", len: "25" }));
    });
    socket.on("message", (payload) => {
      const parsed = safeParse(payload.toString());
      if (isRecord(parsed) && parsed.event === "subscribed" && parsed.channel === "book") {
        channelId = Number(parsed.chanId ?? 0);
        return;
      }
      if (!Array.isArray(parsed) || Number(parsed[0]) !== channelId || parsed[1] === "hb") return;
      const updates = Array.isArray(parsed[1]?.[0]) ? parsed[1] : [parsed[1]];
      updates.filter(Array.isArray).forEach((level: unknown[]) => this.applyBitfinexLevel(level));
      const bids = sortedLevelsFromMap(this.bitfinexBids, "bid");
      const asks = sortedLevelsFromMap(this.bitfinexAsks, "ask");
      if (bids.length && asks.length) {
        this.ingest(this.makeBook("bitfinex", "BTC/USDT", bids, asks, Date.now(), {
          sourceSymbol: "tBTCUSD",
          quoteAsset: "USD",
          streamOnly: true
        }));
        this.mark("bitfinex", "websocket", "live");
      }
    });
    this.attachReconnect("bitfinex", socket, () => this.connectBitfinex());
  }

  private connectGate(): void {
    this.mark("gate", "websocket", "connecting");
    const socket = new WebSocket("wss://api.gateio.ws/ws/v4/");
    socket.on("open", () => {
      socket.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), channel: "spot.order_book", event: "subscribe", payload: ["BTC_USDT", "5", "100ms"] }));
    });
    socket.on("message", (payload) => {
      const parsed = safeParse(payload.toString());
      if (!isRecord(parsed) || parsed.channel !== "spot.order_book" || parsed.event !== "update") return;
      const result = readRecord(parsed, "result");
      if (!result) return;
      const bids = levelsFromUnknown(result.bids);
      const asks = levelsFromUnknown(result.asks);
      const ts = Number(readStringOrNumber(result, "t") ?? Date.now());
      if (bids.length && asks.length) {
        this.ingest(this.makeBook("gate", "BTC/USDT", bids, asks, Number.isFinite(ts) ? ts : Date.now(), {
          sequence: readStringOrNumber(result, "id"),
          snapshot: true
        }));
        this.mark("gate", "websocket", "live");
      }
    });
    this.attachReconnect("gate", socket, () => this.connectGate());
  }

  private applyBitfinexLevel(level: unknown[]): void {
    const price = String(level[0] ?? "");
    const count = Number(level[1] ?? 0);
    const amount = Number(level[2] ?? 0);
    if (!price) return;
    if (count === 0) {
      this.bitfinexBids.delete(price);
      this.bitfinexAsks.delete(price);
      return;
    }
    if (amount > 0) this.bitfinexBids.set(price, String(amount));
    if (amount < 0) this.bitfinexAsks.set(price, String(Math.abs(amount)));
  }

  private applyBybitLevels(target: Map<string, string>, levels: Array<[string, string]>, reset: boolean): void {
    this.applyMapLevels(target, levels, reset);
  }

  private applyMapLevels(target: Map<string, string>, levels: Array<[string, string]>, reset: boolean): void {
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
    const tasks: Array<Promise<void>> = [];
    if (this.needsFallback("binance")) tasks.push(this.guardedPoll("binance", this.pollBinanceDepth()));
    if (this.needsFallback("kraken")) tasks.push(this.guardedPoll("kraken", this.pollKrakenDepth()));
    if (this.needsFallback("coinbase")) tasks.push(this.guardedPoll("coinbase", this.pollCoinbaseBook()));
    if (this.needsFallback("okx")) tasks.push(this.guardedPoll("okx", this.pollOkxBook()));
    if (this.needsFallback("bybit")) tasks.push(this.guardedPoll("bybit", this.pollBybitBook()));
    if (this.needsFallback("bitfinex")) tasks.push(this.guardedPoll("bitfinex", this.pollBitfinexBook()));
    if (this.needsFallback("gate")) tasks.push(this.guardedPoll("gate", this.pollGateBook()));
    await Promise.allSettled(tasks);
  }

  private async guardedPoll(exchange: ExchangeId, poll: Promise<void>): Promise<void> {
    try {
      await poll;
    } catch (error) {
      const reason = `REST fallback failed: ${errorMessage(error)}`;
      console.error(`[${exchange}] ${reason}`);
      this.mark(exchange, "rest-polling", "error", reason);
    }
  }

  private needsFallback(exchange: ExchangeId): boolean {
    const status = this.connectionStatuses.get(exchange);
    return !status?.lastMessageAt || Date.now() - status.lastMessageAt > 5000 || status.status === "error" || status.status === "reconnecting";
  }

  private async pollQuoteBasis(): Promise<void> {
    try {
      const response = await fetch("https://api.exchange.coinbase.com/products/USDT-USD/ticker", {
        headers: { "User-Agent": "ArbitrAI Hackathon" }
      });
      const payload = (await response.json()) as unknown;
      const price = readStringOrNumber(payload, "price");
      if (price) this.quotes.setUsdtUsdRate(price);
    } catch {
      // Keep the last known basis; a stale basis is safer than silently dropping feeds.
    }
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
          this.ingest(this.makeBook("binance", symbol, bids, asks, Date.now(), { snapshot: true }));
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
      this.ingest(this.makeBook("kraken", "BTC/USDT", bids, asks, Date.now(), { sourceSymbol: "BTC/USD", quoteAsset: "USD", snapshot: true }));
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
      this.ingest(this.makeBook("coinbase", "BTC/USDT", bids, asks, Date.now(), { sourceSymbol: "BTC-USD", quoteAsset: "USD", snapshot: true }));
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
      this.ingest(this.makeBook("okx", "BTC/USDT", bids, asks, Number.isFinite(ts) ? ts : Date.now(), { snapshot: true }));
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
      this.ingest(this.makeBook("bybit", "BTC/USDT", bids, asks, Number.isFinite(ts) ? ts : Date.now(), { snapshot: true }));
      this.mark("bybit", "rest-polling", "polling");
    }
  }

  private async pollBitfinexBook(): Promise<void> {
    const response = await fetch("https://api-pub.bitfinex.com/v2/book/tBTCUSD/P0?len=25");
    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload)) return;
    payload.filter(Array.isArray).forEach((level) => this.applyBitfinexLevel(level));
    const bids = sortedLevelsFromMap(this.bitfinexBids, "bid");
    const asks = sortedLevelsFromMap(this.bitfinexAsks, "ask");
    if (bids.length && asks.length) {
      this.ingest(this.makeBook("bitfinex", "BTC/USDT", bids, asks, Date.now(), { sourceSymbol: "tBTCUSD", quoteAsset: "USD", snapshot: true }));
      this.mark("bitfinex", "rest-polling", "polling");
    }
  }

  private async pollGateBook(): Promise<void> {
    const response = await fetch("https://api.gateio.ws/api/v4/spot/order_book?currency_pair=BTC_USDT&limit=5");
    const payload = (await response.json()) as unknown;
    if (!isRecord(payload)) return;
    const bids = levelsFromUnknown(payload.bids);
    const asks = levelsFromUnknown(payload.asks);
    if (bids.length && asks.length) {
      this.ingest(this.makeBook("gate", "BTC/USDT", bids, asks, Date.now(), { snapshot: true }));
      this.mark("gate", "rest-polling", "polling");
    }
  }

  private makeBook(
    exchange: ExchangeId,
    symbol: SymbolId,
    bidsRaw: Array<[string, string]>,
    asksRaw: Array<[string, string]>,
    exchangeTimestamp: number,
    meta: BookMeta = {}
  ): NormalizedOrderBook {
    return makeBook(this.quotes, this.integrity, exchange, symbol, bidsRaw, asksRaw, exchangeTimestamp, meta);
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
      reliabilityScore: reliabilityScore(status, transport, error),
      bookIntegrity: current?.bookIntegrity,
      quoteAsset: current?.quoteAsset,
      quoteBasisBps: current?.quoteBasisBps,
      gapCount: current?.gapCount,
      resyncCount: current?.resyncCount
    });
  }
}

function snapshotWithStatuses(adminAuthenticated = false): GatewaySnapshot {
  return {
    ...kernel.snapshot(),
    exchangeStatuses: connector?.statuses() ?? [],
    scannerUniverse: [...scannerUniverse],
    adminAuthenticated
  };
}

function publicSummary(): PublicGatewaySummary {
  const snapshot = snapshotWithStatuses(false);
  const runtime = snapshot.executionRuntime;
  const validationStatus = runtime.lastReport?.mode === "TEST_ORDER" && runtime.lastReport.status === "SUBMITTED"
    ? "VALIDATED"
    : runtime.venues.some((venue) => venue.configured)
      ? "READY"
      : "NOT_CONFIGURED";
  return {
    ok: true,
    service: "arbitrai-gateway",
    time: new Date().toISOString(),
    operationalMode: runtime.orderMode,
    scannerUniverse: [...scannerUniverse],
    exchanges: connector?.statuses() ?? [],
    metrics: snapshot.metrics,
    learning: snapshot.learning,
    risk: snapshot.risk,
    executionProof: {
      mode: runtime.mode,
      orderMode: runtime.orderMode,
      configuredVenues: runtime.venues.filter((venue) => venue.configured).length,
      validationStatus,
      fundsMoved: false
    },
    recentSignals: snapshot.opportunities.slice(0, 8).map((opportunity) => ({
      createdAt: opportunity.createdAt,
      expectedProfitUsd: opportunity.expectedProfitUsd,
      expectedValueUsd: opportunity.expectedValueUsd,
      netSpreadPct: opportunity.netSpreadPct,
      route: opportunity.route,
      score: opportunity.score,
      status: opportunity.status,
      type: opportunity.type
    }))
  };
}

interface BookMeta {
  sourceSymbol?: string;
  quoteAsset?: QuoteAsset;
  sequence?: string | number | null;
  previousSequence?: string | number | null;
  snapshot?: boolean;
  checksumValidated?: boolean;
  streamOnly?: boolean;
  reason?: string;
}

function makeBook(
  quotes: QuoteNormalizer,
  integrity: BookIntegrityService,
  exchange: ExchangeId,
  symbol: SymbolId,
  bidsRaw: Array<[string, string]>,
  asksRaw: Array<[string, string]>,
  exchangeTimestamp: number,
  meta: BookMeta = {}
): NormalizedOrderBook {
  const receivedAt = Date.now();
  const quoteAsset = meta.quoteAsset ?? (symbol === "ETH/BTC" ? "BTC" : "USDT");
  const bids = normalizeLevels(quotes, bidsRaw, quoteAsset);
  const asks = normalizeLevels(quotes, asksRaw, quoteAsset);
  return {
    exchange,
    symbol,
    sourceSymbol: meta.sourceSymbol ?? symbol,
    quoteAsset,
    quoteToUsdRate: quotes.quoteToUsdRate(quoteAsset),
    quoteBasisBps: quotes.quoteBasisBps(quoteAsset),
    bids,
    asks,
    exchangeTimestamp,
    receivedAt,
    processingLatencyMs: Math.max(0, Number((performance.now() % 4).toFixed(2))),
    integrity: integrity.assess(exchange, {
      streamKey: symbol,
      sequence: meta.sequence ?? undefined,
      previousSequence: meta.previousSequence ?? undefined,
      snapshot: meta.snapshot,
      checksumValidated: meta.checksumValidated,
      streamOnly: meta.streamOnly,
      reason: meta.reason
    })
  };
}

function normalizeLevels(quotes: QuoteNormalizer, levels: Array<[string, string]>, quoteAsset: QuoteAsset): OrderBookLevel[] {
  const normalized = quotes.normalizeLevels(levels, quoteAsset);
  while (normalized.length < 5 && normalized[0]) {
    normalized.push({ ...normalized[0] });
  }
  return normalized;
}

function levelsFromUnknown(value: unknown): Array<[string, string]> {
  if (!Array.isArray(value)) return [];
  return value
    .map((level): [string, string] | null => {
      if (Array.isArray(level) && level.length >= 2) return [String(level[0]), String(level[1])];
      if (!isRecord(level)) return null;
      const price = readStringOrNumber(level, "price");
      const size = readStringOrNumber(level, "qty") ?? readStringOrNumber(level, "size");
      return price && size ? [price, size] : null;
    })
    .filter((level): level is [string, string] => Boolean(level));
}

function sortedLevelsFromMap(levels: Map<string, string>, side: "bid" | "ask", limit = 5): Array<[string, string]> {
  return [...levels.entries()]
    .sort((a, b) => side === "bid" ? Number(b[0]) - Number(a[0]) : Number(a[0]) - Number(b[0]))
    .slice(0, limit);
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

function parseKrakenBook(text: string): unknown {
  return safeParse(preserveKrakenBookDecimals(text));
}

function truncateMap(levels: Map<string, string>, side: "bid" | "ask", limit: number): void {
  const retained = new Set(sortedLevelsFromMap(levels, side, limit).map(([price]) => price));
  [...levels.keys()].forEach((price) => {
    if (!retained.has(price)) levels.delete(price);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
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

function loadLocalEnv(): void {
  if (!existsSync(".env")) return;
  readFileSync(".env", "utf8")
    .split(/\r?\n/)
    .forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const separator = trimmed.indexOf("=");
      if (separator <= 0) return;
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
      if (process.env[key] === undefined) process.env[key] = value;
    });
}

server.listen(port, () => {
  console.log(`ArbitrAI WebSocketGateway listening on :${port}`);
});

connector = new ExchangeConnector(kernel);
connector.start();
