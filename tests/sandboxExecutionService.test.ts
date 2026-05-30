import { describe, expect, it } from "vitest";
import { SandboxExecutionService } from "../src/lib/services/SandboxExecutionService";

describe("SandboxExecutionService", () => {
  it("stays in paper mode when sandbox credentials are missing", () => {
    const service = new SandboxExecutionService({});
    const runtime = service.setMode("SANDBOX");

    expect(runtime.mode).toBe("PAPER");
    expect(runtime.sandboxEnabled).toBe(false);
    expect(runtime.venues.every((venue) => !venue.configured)).toBe(true);
  });

  it("keeps OKX planned while Binance uses TEST_ORDER validation", async () => {
    const service = new SandboxExecutionService({
      BINANCE_TESTNET_API_KEY: "present",
      BINANCE_TESTNET_API_SECRET: "present",
      OKX_DEMO_API_KEY: "present",
      OKX_DEMO_API_SECRET: "present",
      OKX_DEMO_API_PASSPHRASE: "present",
      SANDBOX_ORDER_MODE: "TEST_ORDER"
    });
    service.setMode("SANDBOX");
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = async (input) => {
      calls.push(String(input));
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    };

    try {
      const report = await service.execute(crossOpportunity());
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("testnet.binance.vision/api/v3/order/test");
      expect(calls[0]).toContain("quantity=0.00035");
      expect(report?.legs.find((leg) => leg.exchange === "okx")?.status).toBe("PLANNED");
      expect(report?.reason).toContain("OKX demo leg remained planned");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function crossOpportunity() {
  return {
    id: "opp_1",
    type: "CROSS_EXCHANGE" as const,
    executionStyle: "INSTANT_TAKER" as const,
    status: "DETECTED" as const,
    route: "Binance -> Okx",
    createdAt: Date.now(),
    expiresAt: Date.now() + 500,
    buyExchange: "binance" as const,
    sellExchange: "okx" as const,
    grossSpreadPct: "0.20",
    netSpreadPct: "0.10",
    tradeSizeBtc: "0.01",
    expectedProfitUsd: "1.00",
    grossProfitUsd: "2.00",
    totalFeesUsd: "0.50",
    slippageUsd: "0.20",
    networkCostUsd: "0.10",
    score: 85,
    confidence: 80,
    highImpact: false,
    impactRatio: 0.1,
    reason: "test",
    detectionLatencyMs: 0.5,
    executionPlan: {
      buyLevels: [],
      sellLevels: [],
      buyLiquidityRole: "taker" as const,
      sellLiquidityRole: "taker" as const,
      referenceBuyPrice: "70000",
      referenceSellPrice: "70100"
    }
  };
}
