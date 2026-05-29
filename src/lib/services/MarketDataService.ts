import type { ExchangeId, NormalizedOrderBook, OrderBookLevel, PricePoint, SymbolId } from "../types";
import { EventBus } from "./EventBus";
import { RiskManager } from "./RiskManager";

interface DemoState {
  btc: number;
  eth: number;
  ethBtc: number;
  tick: number;
  timer: ReturnType<typeof setInterval> | null;
}

const EXCHANGES: ExchangeId[] = ["binance", "kraken", "coinbase", "okx", "bybit"];

export class MarketDataService {
  private readonly priceSeries: PricePoint[] = [];
  private readonly demoState: DemoState = {
    btc: 70500,
    eth: 3650,
    ethBtc: 0.0518,
    tick: 0,
    timer: null
  };

  constructor(
    private readonly bus: EventBus,
    private readonly riskManager: RiskManager
  ) {}

  ingest(book: NormalizedOrderBook): void {
    this.bus.emit("market:update", book);
    if (book.symbol === "BTC/USDT") this.trackPrice(book);
  }

  startDemo(): void {
    this.stopDemo();
    this.demoState.timer = setInterval(() => this.generateDemoTick(), 220);
  }

  stopDemo(): void {
    if (this.demoState.timer) clearInterval(this.demoState.timer);
    this.demoState.timer = null;
  }

  priceHistory(): PricePoint[] {
    return [...this.priceSeries];
  }

  private generateDemoTick(): void {
    this.demoState.tick += 1;
    const volatility = 0.00065 * this.riskManager.getVolatilityMultiplier();
    this.demoState.btc = gbm(this.demoState.btc, 0.00001, volatility);
    this.demoState.eth = gbm(this.demoState.eth, 0.000015, volatility * 1.25);
    this.demoState.ethBtc = this.demoState.eth / this.demoState.btc;

    const arbPulse = this.demoState.tick % 19 === 0 ? 1 : 0;
    const triPulse = this.demoState.tick % 43 === 0 ? 1 : 0;
    const spreadMultiplier = this.riskManager.getSpreadMultiplier();
    const liquidityMultiplier = this.riskManager.getLiquidityMultiplier();

    EXCHANGES.forEach((exchange, index) => {
      const exchangeBias = Math.sin((Date.now() / 900) + index) * 18;
      const pulseBias = arbPulse && index === 0 ? -90 : arbPulse && index === 1 ? 95 : 0;
      const btcMid = this.demoState.btc + exchangeBias + pulseBias;
      const ethMid = this.demoState.eth * (1 + (index - 1) * 0.00035);
      const ethBtcMid = this.demoState.ethBtc * (1 + (triPulse && index === 0 ? 0.0042 : 0));

      this.ingest(makeBook(exchange, "BTC/USDT", btcMid, (11 + index * 2) * spreadMultiplier, (0.18 + index * 0.07) * liquidityMultiplier));
      this.ingest(makeBook(exchange, "ETH/USDT", ethMid, (1.4 + index * 0.2) * spreadMultiplier, (8 + index * 2) * liquidityMultiplier));
      this.ingest(makeBook(exchange, "ETH/BTC", ethBtcMid, 0.00005 * spreadMultiplier, (12 + index * 2) * liquidityMultiplier));
    });
  }

  private trackPrice(book: NormalizedOrderBook): void {
    const bid = Number(book.bids[0]?.price ?? 0);
    const ask = Number(book.asks[0]?.price ?? 0);
    if (!bid || !ask) return;
    const latest = this.priceSeries.at(-1);
    const next: PricePoint = latest && Date.now() - latest.time < 750 ? { ...latest } : { time: Date.now() };
    next[book.exchange] = (bid + ask) / 2;
    if (!latest || latest.time !== next.time) this.priceSeries.push(next);
    else this.priceSeries[this.priceSeries.length - 1] = next;
    this.priceSeries.splice(0, Math.max(0, this.priceSeries.length - 160));
  }
}

function makeBook(exchange: ExchangeId, symbol: SymbolId, mid: number, spread: number, topSize: number): NormalizedOrderBook {
  const bids: OrderBookLevel[] = [];
  const asks: OrderBookLevel[] = [];
  for (let level = 0; level < 5; level += 1) {
    const step = spread * (level + 0.5);
    const size = topSize * (1 + level * 0.42);
    bids.push({ price: formatPrice(symbol, mid - step), size: size.toFixed(symbol === "ETH/BTC" ? 5 : 8) });
    asks.push({ price: formatPrice(symbol, mid + step), size: (size * 0.92).toFixed(symbol === "ETH/BTC" ? 5 : 8) });
  }

  return {
    exchange,
    symbol,
    bids,
    asks,
    receivedAt: Date.now(),
    exchangeTimestamp: Date.now() - Math.floor(Math.random() * 35),
    processingLatencyMs: Number((Math.random() * 2.7 + 0.4).toFixed(2))
  };
}

function gbm(price: number, drift: number, volatility: number): number {
  const randomShock = gaussianRandom();
  return price * Math.exp((drift - 0.5 * volatility ** 2) + volatility * randomShock);
}

function gaussianRandom(): number {
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function formatPrice(symbol: SymbolId, price: number): string {
  return symbol === "ETH/BTC" ? price.toFixed(8) : price.toFixed(2);
}
