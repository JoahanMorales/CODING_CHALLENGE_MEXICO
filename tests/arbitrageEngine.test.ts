import { describe, expect, it } from "vitest";
import { d } from "../src/lib/math/decimal";
import { ArbitrageEngine } from "../src/lib/services/ArbitrageEngine";

describe("ArbitrageEngine.calculateNetProfit", () => {
  it("matches the required cross-exchange formula", () => {
    const engine = new ArbitrageEngine();
    const result = engine.calculateNetProfit({
      buyExchange: "binance",
      sellExchange: "binance",
      askPrice: d("70000"),
      bidPrice: d("70250"),
      quantityBtc: d("1"),
      availableAskQty: d("4"),
      availableBidQty: d("4"),
      includeWithdrawal: false
    });

    expect(result.grossProfitUsd.toFixed(2)).toBe("250.00");
    expect(result.buyFeeUsd.toFixed(2)).toBe("70.00");
    expect(result.sellFeeUsd.toFixed(2)).toBe("70.25");
    expect(result.netProfitUsd.toNumber()).toBeLessThan(110);
    expect(result.netProfitUsd.toNumber()).toBeGreaterThan(60);
  });
});
