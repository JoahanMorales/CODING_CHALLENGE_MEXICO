import { describe, expect, it } from "vitest";
import { INITIAL_WALLETS } from "../src/lib/config/exchanges";
import { ExecutionSimulator } from "../src/lib/services/ExecutionSimulator";
import type { Opportunity } from "../src/lib/types";

describe("ExecutionSimulator preflight", () => {
  it("rejects a route before queue admission when the sell leg lacks BTC", () => {
    const simulator = new ExecutionSimulator({
      ...INITIAL_WALLETS,
      okx: { ...INITIAL_WALLETS.okx, btc: "0" }
    });

    const preflight = simulator.preflight(crossOpportunity());

    expect(preflight.ok).toBe(false);
    expect(preflight.reason).toContain("okx requires");
  });
});

function crossOpportunity(): Opportunity {
  return {
    id: "opp_preflight",
    type: "CROSS_EXCHANGE",
    executionStyle: "INSTANT_TAKER",
    status: "DETECTED",
    route: "Binance -> Okx",
    createdAt: Date.now(),
    expiresAt: Date.now() + 500,
    detectionLatencyMs: 0.4,
    buyExchange: "binance",
    sellExchange: "okx",
    grossSpreadPct: "0.20",
    netSpreadPct: "0.10",
    tradeSizeBtc: "0.01",
    expectedProfitUsd: "1.00",
    expectedValueUsd: "0.75",
    executionNetProfitUsd: "1.20",
    rebalanceAdjustedProfitUsd: "1.00",
    grossProfitUsd: "2.00",
    totalFeesUsd: "0.50",
    slippageUsd: "0.20",
    networkCostUsd: "0.10",
    quoteConversionCostUsd: "0.00",
    rebalanceCostUsd: "0.20",
    score: 85,
    confidence: 80,
    highImpact: false,
    impactRatio: 0.1,
    reason: "test",
    executionPlan: {
      buyLevels: [{ price: "70000", size: "1" }],
      sellLevels: [{ price: "70100", size: "1" }],
      buyLiquidityRole: "taker",
      sellLiquidityRole: "taker",
      referenceBuyPrice: "70000",
      referenceSellPrice: "70100"
    }
  };
}
