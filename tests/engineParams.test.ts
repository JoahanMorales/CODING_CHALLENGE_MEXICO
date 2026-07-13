import { describe, expect, it } from "vitest";
import { ArbitrageEngine, DEFAULT_ENGINE_PARAMS } from "../src/lib/services/ArbitrageEngine";
import type { ExchangeId, NormalizedOrderBook, Opportunity } from "../src/lib/types";

function book(exchange: ExchangeId, bid: string, ask: string, receivedAt: number, size = "2"): NormalizedOrderBook {
  return {
    exchange,
    symbol: "BTC/USDT",
    sourceSymbol: "BTC/USDT",
    quoteAsset: "USDT",
    quoteToUsdRate: "1.00000000",
    quoteBasisBps: "0.000",
    bids: Array.from({ length: 5 }, (_, i) => ({ price: String(Number(bid) - i), size })),
    asks: Array.from({ length: 5 }, (_, i) => ({ price: String(Number(ask) + i), size })),
    receivedAt,
    exchangeTimestamp: receivedAt,
    processingLatencyMs: 0.2,
    integrity: { status: "VERIFIED", gapCount: 0, resyncCount: 0, checksumValidated: true, reason: "test" }
  };
}

// Feed a clean, fresh, synchronized cross-venue dislocation (buy cheap on binance,
// sell rich on bybit — both low-fee venues so the ~64bps gross clears fees).
function detectDislocation(engine: ArbitrageEngine, buyAgeMs = 0, size = "2"): Opportunity[] {
  const now = Date.now();
  engine.onOrderBook(book("binance", "69990", "70000", now - buyAgeMs, size));
  return engine.onOrderBook(book("bybit", "70450", "70460", now, size));
}
const detectedCross = (ops: Opportunity[]) =>
  ops.filter((o) => o.type === "CROSS_EXCHANGE" && o.status === "DETECTED");

describe("ArbitrageEngine.setParams — clamping", () => {
  it("clamps every knob to its safe range", () => {
    const engine = new ArbitrageEngine();
    const p = engine.setParams({
      minNetEdgeBps: 9999,
      maxTradeSizeBtc: 0,
      feeStressMultiplier: 0.01,
      maxSlippageBps: -5,
      minDepthBtc: 999,
      maxQuoteAgeMs: 10
    });
    expect(p.minNetEdgeBps).toBe(200);
    expect(p.maxTradeSizeBtc).toBe(0.0001);
    expect(p.feeStressMultiplier).toBe(0.25);
    expect(p.maxSlippageBps).toBe(0);
    expect(p.minDepthBtc).toBe(5);
    expect(p.maxQuoteAgeMs).toBe(200);
  });

  it("ignores an invalid execution style but accepts valid ones", () => {
    const engine = new ArbitrageEngine();
    // @ts-expect-error deliberately invalid
    engine.setParams({ preferredStyle: "BOGUS" });
    expect(engine.params.preferredStyle).toBe("AUTO");
    engine.setParams({ preferredStyle: "MAKER" });
    expect(engine.params.preferredStyle).toBe("MAKER");
  });

  it("ignores NaN/undefined without mutating current params", () => {
    const engine = new ArbitrageEngine();
    engine.setParams({ minNetEdgeBps: 7 });
    engine.setParams({ minNetEdgeBps: Number.NaN });
    expect(engine.params.minNetEdgeBps).toBe(7);
  });
});

describe("ArbitrageEngine.setParams — detection gating", () => {
  it("detects a fat, fresh cross dislocation with defaults", () => {
    const engine = new ArbitrageEngine();
    const detected = detectedCross(detectDislocation(engine));
    expect(detected.length).toBeGreaterThan(0);
    expect(detected[0].buyExchange).toBe("binance");
    expect(detected[0].sellExchange).toBe("bybit");
  });

  it("rejects the same dislocation once the min net edge is raised above it", () => {
    const engine = new ArbitrageEngine();
    engine.setParams({ minNetEdgeBps: 100 }); // 100 bps floor >> the ~44 bps net edge
    expect(detectedCross(detectDislocation(engine)).length).toBe(0);
  });

  it("caps the position at maxTradeSizeBtc", () => {
    const engine = new ArbitrageEngine();
    engine.setParams({ maxTradeSizeBtc: 0.02 });
    const detected = detectedCross(detectDislocation(engine));
    expect(detected.length).toBeGreaterThan(0);
    expect(Number(detected[0].tradeSizeBtc)).toBeLessThanOrEqual(0.02 + 1e-9);
  });

  it("rejects when the two books are staler than maxQuoteAgeMs apart", () => {
    const engine = new ArbitrageEngine();
    engine.setParams({ maxQuoteAgeMs: 300 });
    // 1200ms skew between the legs, well beyond the 300ms window.
    expect(detectedCross(detectDislocation(engine, 1200)).length).toBe(0);
  });

  it("rejects when the required depth floor exceeds available depth", () => {
    const engine = new ArbitrageEngine();
    // Thin books: 5 levels x 0.4 = 2 BTC of depth-5, below a 5 BTC floor.
    expect(detectedCross(detectDislocation(engine, 0, "0.4")).length).toBeGreaterThan(0);
    const strict = new ArbitrageEngine();
    strict.setParams({ minDepthBtc: 5 });
    expect(detectedCross(detectDislocation(strict, 0, "0.4")).length).toBe(0);
  });

  it("exposes the compiled defaults", () => {
    expect(DEFAULT_ENGINE_PARAMS.minNetEdgeBps).toBe(5);
    expect(DEFAULT_ENGINE_PARAMS.preferredStyle).toBe("AUTO");
  });
});
