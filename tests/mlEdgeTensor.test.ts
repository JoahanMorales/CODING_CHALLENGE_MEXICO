import { describe, expect, it } from "vitest";
import { d } from "../src/lib/math/decimal";
import { MlEdgeTensor } from "../src/lib/services/MlEdgeTensor";
import type { ExchangeId, NormalizedOrderBook } from "../src/lib/types";

function book(exchange: ExchangeId, bid: string, ask: string, size: string, receivedAt: number): NormalizedOrderBook {
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

describe("MlEdgeTensor", () => {
  it("stays untrained until enough outcomes are observed", () => {
    const model = new MlEdgeTensor();
    expect(model.isTrained()).toBe(false);
  });

  it("learns to separate strong edges from weak ones after training", () => {
    const model = new MlEdgeTensor();
    const now = Date.now();
    // Strong: deep, fresh, healthy positive spread. Weak: thin, stale, no edge.
    const goodFeatures = model.extractFeatures(
      book("kraken", "69999", "70000", "5", now),
      book("binance", "70100", "70101", "5", now),
      d("0.05"),
      "INSTANT_TAKER",
      d("0.0008")
    );
    const badFeatures = model.extractFeatures(
      book("kraken", "69990", "70000", "0.01", now - 5000),
      book("binance", "69950", "69960", "0.01", now - 5000),
      d("0.05"),
      "INSTANT_TAKER",
      d("-0.0010")
    );

    // Interleave balanced labelled outcomes so the buffer is balanced when the
    // ensemble first fits (the fit triggers once 32 samples are buffered).
    for (let i = 0; i < 24; i += 1) {
      model.train("Kraken -> Binance", goodFeatures, 1, 1);
      model.train("Kraken -> Binance", badFeatures, 0, 1);
    }

    expect(model.isTrained()).toBe(true);

    const goodSurvival = model.predict(goodFeatures).survivalProbability;
    const badSurvival = model.predict(badFeatures).survivalProbability;

    expect(goodSurvival).toBeGreaterThanOrEqual(0);
    expect(goodSurvival).toBeLessThanOrEqual(1);
    expect(badSurvival).toBeGreaterThanOrEqual(0);
    expect(badSurvival).toBeLessThanOrEqual(1);
    expect(goodSurvival).toBeGreaterThan(badSurvival);
  });
});
