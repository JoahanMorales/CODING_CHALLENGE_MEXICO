import { describe, expect, it, vi } from "vitest";
import { ArbitrageEngine } from "../src/lib/services/ArbitrageEngine";
import type { ExchangeId, NormalizedOrderBook } from "../src/lib/types";

function book(exchange: ExchangeId, bid: number, ask: number, size: string, receivedAt: number): NormalizedOrderBook {
  return {
    exchange,
    symbol: "BTC/USDT",
    sourceSymbol: "BTC/USDT",
    quoteAsset: "USDT",
    quoteToUsdRate: "1.00000000",
    quoteBasisBps: "0.000",
    bids: Array.from({ length: 5 }, (_, i) => ({ price: (bid - i).toFixed(2), size })),
    asks: Array.from({ length: 5 }, (_, i) => ({ price: (ask + i).toFixed(2), size })),
    receivedAt,
    exchangeTimestamp: receivedAt,
    processingLatencyMs: 0.2,
    integrity: { status: "VERIFIED", gapCount: 0, resyncCount: 0, checksumValidated: true, reason: "test" }
  };
}

describe("ML training/inference feature scale", () => {
  it("trains netEdgeBps on the same scale inference uses (regression: percent vs fraction)", () => {
    const engine = new ArbitrageEngine();
    const now = Date.now();
    // A clear, deep, fresh cross: buy Binance @70000, sell OKX @70400 (~57bps gross).
    engine.onOrderBook(book("binance", 69999, 70000, "5", now));
    const opportunities = engine.onOrderBook(book("okx", 70400, 70401, "5", now));
    const cross = opportunities.find((o) => o.type === "CROSS_EXCHANGE" && o.buyExchange === "binance" && o.sellExchange === "okx");
    expect(cross).toBeDefined();
    expect(cross!.status).toBe("DETECTED");

    // Capture the netSpreadPct argument trainMlModel passes into extractFeatures.
    const spy = vi.spyOn(engine.mlEdgeTensor, "extractFeatures");
    engine.trainMlModel(cross!, 5, 1);
    expect(spy).toHaveBeenCalled();
    const netSpreadArg = spy.mock.calls.at(-1)![4];
    const trainingNetEdgeBps = netSpreadArg.mul(10000).toNumber();

    // Inference extracts features from the raw decimal spread; opportunity.netSpreadPct
    // is in percent units (pct() multiplies by 100), so the inference-scale bps value
    // is netSpreadPct * 100. Training must match it (not be ~100x larger).
    const inferenceNetEdgeBps = Number(cross!.netSpreadPct) * 100;
    expect(trainingNetEdgeBps).toBeCloseTo(inferenceNetEdgeBps, 2);
    expect(Math.abs(trainingNetEdgeBps)).toBeLessThan(500);
  });
});
