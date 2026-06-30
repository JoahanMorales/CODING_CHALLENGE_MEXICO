import { describe, expect, it } from "vitest";
import { d } from "../src/lib/math/decimal";
import { calculateNetProfit, estimateSlippageRate } from "../src/lib/services/feeMath";

describe("fee math", () => {
  it("separates execution costs from amortized rebalancing cost", () => {
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
    expect(result.networkCostUsd.toFixed(2)).toBe("0.00");
    expect(result.rebalanceCostUsd.toFixed(2)).toBe("28.00");
    expect(result.rebalanceAdjustedProfitUsd.lessThan(result.netProfitUsd)).toBe(true);
  });

  it("prices slippage with the square-root law of market impact", () => {
    // Quadrupling participation only ~doubles the impact above the touch cost
    // (sqrt(0.16/0.04) = 2), where a linear model would quadruple it.
    const low = estimateSlippageRate(d("0.04"), d("1"));
    const high = estimateSlippageRate(d("0.16"), d("1"));
    expect(low.toFixed(6)).toBe("0.000320");
    expect(high.toFixed(6)).toBe("0.000540");
    const ratio = high.minus("0.0001").div(low.minus("0.0001"));
    expect(ratio.toNumber()).toBeCloseTo(2, 5);
    // No visible depth => maximum modeled impact.
    expect(estimateSlippageRate(d("1"), d("0")).toFixed(6)).toBe("0.006000");
  });

  it("charges quote conversion only across USD and USDT venues", () => {
    const result = calculateNetProfit({
      buyExchange: "binance",
      sellExchange: "coinbase",
      askPrice: d("70000"),
      bidPrice: d("70100"),
      quantityBtc: d("0.1"),
      availableAskQty: d("1"),
      availableBidQty: d("1"),
      includeWithdrawal: false,
      buyQuoteAsset: "USDT",
      sellQuoteAsset: "USD",
      buyQuoteToUsdRate: d("0.999"),
      sellQuoteToUsdRate: d("1")
    });

    expect(result.quoteConversionCostUsd.greaterThan(0)).toBe(true);
  });
});
