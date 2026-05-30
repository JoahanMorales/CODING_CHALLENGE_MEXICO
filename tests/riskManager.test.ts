import { describe, expect, it } from "vitest";
import { RiskManager } from "../src/lib/services/RiskManager";
import type { Trade } from "../src/lib/types";

function trade(pnlUsd: string): Trade {
  return {
    id: `t_${pnlUsd}`,
    opportunityId: "o_1",
    type: "CROSS_EXCHANGE",
    route: "Binance -> Kraken",
    executedAt: Date.now(),
    latencyMs: 80,
    sizeBtc: "0.05",
    pnlUsd,
    grossPnlUsd: pnlUsd,
    feesUsd: "1.00",
    slippageUsd: "0.00",
    executionRiskUsd: "0.00",
    fillRatio: 1,
    status: "FILLED",
    highImpact: false
  };
}

describe("RiskManager.shouldHalt", () => {
  it("halts after 3 consecutive losing trades", () => {
    const risk = new RiskManager();
    risk.recordTrade(trade("-1.00"));
    risk.recordTrade(trade("-2.00"));
    expect(risk.shouldHalt()).toBe(false);
    risk.recordTrade(trade("-3.00"));
    expect(risk.shouldHalt()).toBe(true);
  });

  it("halts when daily loss limit is breached", () => {
    const risk = new RiskManager();
    risk.recordTrade(trade("-600.00"));
    expect(risk.shouldHalt()).toBe(true);
    expect(risk.getState().haltedReason).toBe("daily loss limit breached");
  });
});
