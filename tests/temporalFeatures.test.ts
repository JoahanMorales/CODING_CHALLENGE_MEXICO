import { describe, expect, it } from "vitest";
import { d } from "../src/lib/math/decimal";
import { MlEdgeTensor } from "../src/lib/services/MlEdgeTensor";
import type { ExchangeId, NormalizedOrderBook } from "../src/lib/types";

function book(exchange: ExchangeId, bid: string, ask: string, bidSize: string, askSize: string, receivedAt: number): NormalizedOrderBook {
  return {
    exchange,
    symbol: "BTC/USDT",
    sourceSymbol: "BTC/USDT",
    quoteAsset: "USDT",
    quoteToUsdRate: "1.00000000",
    quoteBasisBps: "0.000",
    bids: Array.from({ length: 5 }, (_, i) => ({ price: String(Number(bid) - i), size: bidSize })),
    asks: Array.from({ length: 5 }, (_, i) => ({ price: String(Number(ask) + i), size: askSize })),
    receivedAt,
    exchangeTimestamp: receivedAt,
    processingLatencyMs: 0.2,
    integrity: { status: "VERIFIED", gapCount: 0, resyncCount: 0, checksumValidated: true, reason: "test" }
  };
}

describe("v3 temporal features", () => {
  it("defaults to neutral zeros on cold start (no history observed)", () => {
    const model = new MlEdgeTensor();
    const now = Date.now();
    const features = model.extractFeatures(
      book("kraken", "69999", "70000", "5", "5", now),
      book("binance", "70100", "70101", "5", "5", now),
      d("0.05"),
      "INSTANT_TAKER",
      d("0.0008")
    );
    expect(features.buyMidMomentumBps).toBe(0);
    expect(features.sellMidMomentumBps).toBe(0);
    expect(features.realizedVolBps).toBe(0);
    expect(features.buyImbalanceDelta).toBe(0);
    expect(features.sellImbalanceDelta).toBe(0);
  });

  it("computes momentum, imbalance delta and realized vol from observed history", () => {
    const model = new MlEdgeTensor();
    const start = Date.now();

    // Kraken mid rises 70000.5 -> 70070.5 (~10bps) with imbalance flipping from
    // balanced to bid-heavy. Entries spaced 1s apart (> the 400ms throttle).
    model.observeBook(book("kraken", "70000", "70001", "5", "5", start));
    model.observeBook(book("kraken", "70035", "70036", "6", "4", start + 1000));
    model.observeBook(book("kraken", "70070", "70071", "8", "2", start + 2000));
    // Binance mid FALLS the same amount, imbalance goes ask-heavy.
    model.observeBook(book("binance", "70170", "70171", "5", "5", start));
    model.observeBook(book("binance", "70135", "70136", "4", "6", start + 1000));
    model.observeBook(book("binance", "70100", "70101", "2", "8", start + 2000));

    const features = model.extractFeatures(
      book("kraken", "70070", "70071", "8", "2", start + 2000),
      book("binance", "70100", "70101", "2", "8", start + 2000),
      d("0.05"),
      "INSTANT_TAKER",
      d("0.0008")
    );

    // ~+10bps on the buy venue, ~-10bps on the sell venue.
    expect(features.buyMidMomentumBps).toBeGreaterThan(8);
    expect(features.buyMidMomentumBps).toBeLessThan(12);
    expect(features.sellMidMomentumBps).toBeLessThan(-8);
    expect(features.sellMidMomentumBps).toBeGreaterThan(-12);
    // Imbalance moved from 0 to +0.6 (kraken) and to -0.6 (binance).
    expect(features.buyImbalanceDelta).toBeCloseTo(0.6, 5);
    expect(features.sellImbalanceDelta).toBeCloseTo(-0.6, 5);
    // Non-zero realized vol once >= 3 entries produce >= 2 returns.
    expect(features.realizedVolBps).toBeGreaterThan(0);
  });

  it("throttles rapid-fire updates so the window spans real time", () => {
    const model = new MlEdgeTensor();
    const start = Date.now();
    // 30 updates 10ms apart (290ms total, inside the 400ms spacing): only the
    // first is stored, so temporal stats remain neutral (single entry).
    for (let i = 0; i < 30; i += 1) {
      model.observeBook(book("kraken", String(70000 + i), String(70001 + i), "5", "5", start + i * 10));
    }
    const features = model.extractFeatures(
      book("kraken", "70030", "70031", "5", "5", start + 300),
      book("binance", "70100", "70101", "5", "5", start + 300),
      d("0.05"),
      "INSTANT_TAKER",
      d("0.0008")
    );
    expect(features.buyMidMomentumBps).toBe(0);
  });
});
