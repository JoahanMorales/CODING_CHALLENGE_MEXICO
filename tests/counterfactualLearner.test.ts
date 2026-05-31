import { describe, expect, it } from "vitest";
import { CounterfactualLearner } from "../src/lib/services/CounterfactualLearner";
import type { ExchangeId, NormalizedOrderBook, Opportunity } from "../src/lib/types";

function book(exchange: ExchangeId, bid: string, ask: string): NormalizedOrderBook {
  return {
    exchange,
    symbol: "BTC/USDT",
    sourceSymbol: "BTC/USDT",
    quoteAsset: "USDT",
    quoteToUsdRate: "1.00000000",
    quoteBasisBps: "0.000",
    bids: Array.from({ length: 5 }, () => ({ price: bid, size: "1" })),
    asks: Array.from({ length: 5 }, () => ({ price: ask, size: "1" })),
    receivedAt: Date.now(),
    exchangeTimestamp: Date.now(),
    processingLatencyMs: 0.2,
    integrity: { status: "VERIFIED", gapCount: 0, resyncCount: 0, checksumValidated: true, reason: "test" }
  };
}

function rejectedOpportunity(): Opportunity {
  return {
    id: "opp_1",
    type: "CROSS_EXCHANGE",
    executionStyle: "INSTANT_TAKER",
    status: "REJECTED",
    route: "Binance -> Bybit",
    createdAt: Date.now() - 1000,
    expiresAt: Date.now() - 500,
    detectionLatencyMs: 0.4,
    buyExchange: "binance",
    sellExchange: "bybit",
    grossSpreadPct: "0.0000",
    netSpreadPct: "-0.0100",
    tradeSizeBtc: "0.01",
    expectedProfitUsd: "-1.00",
    expectedValueUsd: "-1.50",
    executionNetProfitUsd: "-0.80",
    rebalanceAdjustedProfitUsd: "-1.00",
    grossProfitUsd: "0.00",
    totalFeesUsd: "1.40",
    slippageUsd: "0.50",
    networkCostUsd: "0.10",
    quoteConversionCostUsd: "0.00",
    rebalanceCostUsd: "0.20",
    score: 42,
    confidence: 30,
    highImpact: false,
    impactRatio: 0.01,
    reason: "Rejected before counterfactual test."
  };
}

describe("CounterfactualLearner", () => {
  it("labels rejected signals that later become profitable", () => {
    const learner = new CounterfactualLearner();
    learner.track(rejectedOpportunity());
    learner.observeBook(book("binance", "69990", "70000"));
    const outcomes = learner.observeBook(book("bybit", "70300", "70310"));

    expect(outcomes.some((outcome) => outcome.label === "MISSED_PROFIT")).toBe(true);
    expect(learner.summary().missedProfits).toBeGreaterThan(0);
  });
});
