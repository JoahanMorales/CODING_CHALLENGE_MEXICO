import { describe, expect, it } from "vitest";
import { d } from "../src/lib/math/decimal";
import { fitPlattScaling, MlEdgeTensor } from "../src/lib/services/MlEdgeTensor";
import type { ExchangeId, NormalizedOrderBook } from "../src/lib/types";

// Deterministic PRNG so label draws are stable run-to-run.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

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

describe("Platt scaling", () => {
  it("recovers a known miscalibration and lowers the Brier score without changing ranking", () => {
    // The "model" outputs sigmoid(m), but the TRUE probability is sigmoid(2m - 1):
    // over-confident slope and a shifted intercept. Platt should recover a~2, b~-1.
    const rng = mulberry32(0xc0ffee);
    const points: Array<{ margin: number; label: number }> = [];
    for (let i = 0; i < 4000; i += 1) {
      const margin = (rng() - 0.5) * 6; // margins in [-3, 3]
      const trueP = sigmoid(2 * margin - 1);
      points.push({ margin, label: rng() < trueP ? 1 : 0 });
    }

    const platt = fitPlattScaling(points);
    expect(platt).not.toBeNull();
    expect(platt!.a).toBeGreaterThan(1.5);
    expect(platt!.a).toBeLessThan(2.5);
    expect(platt!.b).toBeGreaterThan(-1.35);
    expect(platt!.b).toBeLessThan(-0.65);

    const brier = (p: (m: number) => number) =>
      points.reduce((s, pt) => s + (p(pt.margin) - pt.label) ** 2, 0) / points.length;
    const brierIdentity = brier((m) => sigmoid(m));
    const brierCalibrated = brier((m) => sigmoid(platt!.a * m + platt!.b));
    expect(brierCalibrated).toBeLessThan(brierIdentity);

    // Monotonic map (a > 0): the ranking of any two margins is preserved exactly.
    expect(sigmoid(platt!.a * 0.4 + platt!.b)).toBeGreaterThan(sigmoid(platt!.a * 0.1 + platt!.b));
  });

  it("returns null on degenerate inputs instead of a broken fit", () => {
    expect(fitPlattScaling([])).toBeNull();
    expect(fitPlattScaling(Array.from({ length: 50 }, (_, i) => ({ margin: i / 10, label: 1 })))).toBeNull();
    expect(fitPlattScaling(Array.from({ length: 50 }, (_, i) => ({ margin: i / 10, label: 0 })))).toBeNull();
  });

  it("survives an export/import roundtrip and rejects invalid params", () => {
    const model = new MlEdgeTensor();
    const now = Date.now();
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
    for (let i = 0; i < 24; i += 1) {
      model.train("Kraken -> Binance", goodFeatures, 1, 1);
      model.train("Kraken -> Binance", badFeatures, 0, 1);
    }
    expect(model.isTrained()).toBe(true);

    expect(model.setPlattCalibration(0, 1)).toBe(false);
    expect(model.setPlattCalibration(-2, 1)).toBe(false);
    expect(model.setPlattCalibration(Number.NaN, 0)).toBe(false);
    expect(model.setPlattCalibration(1.8, -0.4)).toBe(true);

    const snapshot = model.exportModel();
    expect(snapshot.platt).toEqual({ a: 1.8, b: -0.4 });

    const restored = new MlEdgeTensor();
    expect(restored.importModel(snapshot)).toBe(true);
    expect(restored.plattCalibration()).toEqual({ a: 1.8, b: -0.4 });
    expect(restored.predict(goodFeatures).survivalProbability).toBeCloseTo(
      model.predict(goodFeatures).survivalProbability,
      10
    );

    // A pre-calibration snapshot (no platt field) must import as identity.
    const { platt: _platt, ...legacy } = snapshot;
    const legacyModel = new MlEdgeTensor();
    expect(legacyModel.importModel(legacy)).toBe(true);
    expect(legacyModel.plattCalibration()).toBeNull();

    // Calibration is monotonic, so the learned ordering survives it.
    expect(restored.predict(goodFeatures).survivalProbability).toBeGreaterThan(
      restored.predict(badFeatures).survivalProbability
    );
  });

  it("clears stale platt params when the ensemble refits online", () => {
    const model = new MlEdgeTensor();
    const now = Date.now();
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
    for (let i = 0; i < 24; i += 1) {
      model.train("Kraken -> Binance", goodFeatures, 1, 1);
      model.train("Kraken -> Binance", badFeatures, 0, 1);
    }
    expect(model.setPlattCalibration(2, -1)).toBe(true);

    // Enough new outcomes to trigger another fitEnsemble -> the mapping fit for
    // the previous trees is stale and must be dropped, not silently applied.
    for (let i = 0; i < 40; i += 1) {
      model.train("Kraken -> Binance", i % 2 === 0 ? goodFeatures : badFeatures, i % 2 === 0 ? 1 : 0, 1);
    }
    expect(model.plattCalibration()).toBeNull();
  });
});
