import { describe, expect, it } from "vitest";
import { ArbitrageEngine } from "../src/lib/services/ArbitrageEngine";
import type { ExchangeId, NormalizedOrderBook, Opportunity } from "../src/lib/types";

function book(exchange: ExchangeId, bid: string, ask: string, receivedAt: number): NormalizedOrderBook {
  return {
    exchange,
    symbol: "BTC/USDT",
    sourceSymbol: "BTC/USDT",
    quoteAsset: "USDT",
    quoteToUsdRate: "1.00000000",
    quoteBasisBps: "0.000",
    bids: Array.from({ length: 5 }, (_, i) => ({ price: String(Number(bid) - i), size: "2" })),
    asks: Array.from({ length: 5 }, (_, i) => ({ price: String(Number(ask) + i), size: "2" })),
    receivedAt,
    exchangeTimestamp: receivedAt,
    processingLatencyMs: 0.2,
    integrity: { status: "VERIFIED", gapCount: 0, resyncCount: 0, checksumValidated: true, reason: "test" }
  };
}

function latencySignals(results: Opportunity[]): Opportunity[] {
  return results.filter((o) => o.type === "LATENCY_ARB");
}

describe("Latency / stale-quote arbitrage", () => {
  it("detects a profitable stale-ask vs fresh-bid edge in the async space", () => {
    const engine = new ArbitrageEngine();
    const now = Date.now();
    // Stale, cheap buy quote sitting unrefreshed for 2.5s.
    engine.onOrderBook(book("kraken", "69999", "70000", now - 2500));
    // Fresh, rich bid arrives on another venue.
    const results = engine.onOrderBook(book("binance", "70800", "70801", now));

    const latency = latencySignals(results);
    expect(latency.length).toBeGreaterThan(0);
    const detected = latency.find((o) => o.status === "DETECTED");
    expect(detected).toBeDefined();
    expect(detected?.buyExchange).toBe("kraken");
    expect(detected?.sellExchange).toBe("binance");
    expect(Number(detected?.networkCostUsd)).toBeGreaterThan(0); // staleness-risk premium charged
  });

  it("does not fire when both quotes are synchronized", () => {
    const engine = new ArbitrageEngine();
    const now = Date.now();
    engine.onOrderBook(book("kraken", "69999", "70000", now));
    const results = engine.onOrderBook(book("binance", "70800", "70801", now));

    expect(latencySignals(results)).toHaveLength(0);
  });
});
