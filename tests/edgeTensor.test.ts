import { describe, expect, it } from "vitest";
import { d } from "../src/lib/math/decimal";
import { EdgeTensor } from "../src/lib/services/EdgeTensor";
import type { ExchangeId, NormalizedOrderBook } from "../src/lib/types";

function book(exchange: ExchangeId, bid: string, bidSize: string, ask: string, askSize: string): NormalizedOrderBook {
  return {
    exchange,
    symbol: "BTC/USDT",
    bids: Array.from({ length: 5 }, (_, index) => ({ price: String(Number(bid) - index), size: bidSize })),
    asks: Array.from({ length: 5 }, (_, index) => ({ price: String(Number(ask) + index), size: askSize })),
    receivedAt: Date.now(),
    exchangeTimestamp: Date.now(),
    processingLatencyMs: 0.2
  };
}

describe("EdgeTensor", () => {
  it("raises survival probability when microstructure agrees with the route", () => {
    const tensor = new EdgeTensor();
    const buy = book("kraken", "69999", "0.2", "70000", "2.4");
    const sell = book("binance", "70100", "2.4", "70101", "0.2");
    tensor.ingest(buy);
    tensor.ingest(sell);

    const signal = tensor.routeSignal({
      buyBook: buy,
      sellBook: sell,
      executionStyle: "INSTANT_TAKER",
      expectedProfitUsd: d("6.00"),
      netSpreadPct: d("0.0008"),
      quantityBtc: d("0.05")
    });

    expect(signal.survivalProbability).toBeGreaterThan(0.45);
    expect(signal.modelScore).toBeGreaterThan(45);
    expect(signal.riskAdjustedProfitUsd.toNumber()).toBeGreaterThan(-5);
  });
});
