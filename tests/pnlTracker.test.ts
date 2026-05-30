import { describe, expect, it } from "vitest";
import { PnLTracker } from "../src/lib/services/PnLTracker";
import type { Trade } from "../src/lib/types";

describe("PnLTracker cost waterfall", () => {
  it("reconciles gross edge, costs and net P&L", () => {
    const tracker = new PnLTracker();
    const trade: Trade = {
      id: "t_1",
      opportunityId: "o_1",
      type: "CROSS_EXCHANGE",
      route: "Binance -> Bybit",
      executedAt: Date.now(),
      latencyMs: 80,
      sizeBtc: "0.05",
      pnlUsd: "4.25",
      grossPnlUsd: "10.00",
      feesUsd: "3.00",
      slippageUsd: "1.25",
      executionRiskUsd: "1.50",
      fillRatio: 1,
      status: "FILLED",
      highImpact: false
    };

    const metrics = tracker.recordTrade(trade);
    expect(metrics.grossPnlUsd).toBe("10.00");
    expect(metrics.totalFeesPaidUsd).toBe("3.00");
    expect(metrics.totalSlippageUsd).toBe("1.25");
    expect(metrics.totalExecutionRiskUsd).toBe("1.50");
    expect(metrics.netPnlUsd).toBe("4.25");
  });
});
