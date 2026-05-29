import { describe, expect, it } from "vitest";
import { d } from "../src/lib/math/decimal";
import { calculateNetProfit, estimateSlippageRate } from "../src/lib/services/feeMath";

describe("fee math", () => {
  it("calculates net profit with taker fees, slippage and network cost", () => {
    const result = calculateNetProfit({
      buyExchange: "binance",
      sellExchange: "kraken",
      askPrice: d("70000"),
      bidPrice: d("70250"),
      quantityBtc: d("0.1"),
      availableAskQty: d("1"),
      availableBidQty: d("1"),
      includeWithdrawal: true
    });

    expect(result.grossProfitUsd.toFixed(2)).toBe("25.00");
    expect(result.buyFeeUsd.toFixed(2)).toBe("7.00");
    expect(result.sellFeeUsd.toFixed(2)).toBe("18.27");
    expect(result.networkCostUsd.toFixed(2)).toBe("28.00");
    expect(result.netProfitUsd.lessThan(0)).toBe(true);
  });

  it("bounds slippage between 0.02% and 0.05%", () => {
    expect(estimateSlippageRate(d("0.01"), d("10")).toFixed(6)).toBe("0.000200");
    expect(estimateSlippageRate(d("2"), d("1")).toFixed(6)).toBe("0.000500");
  });
});
