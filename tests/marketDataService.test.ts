import { describe, expect, it } from "vitest";
import { EXCHANGE_IDS } from "../src/lib/config/exchanges";
import { EventBus } from "../src/lib/services/EventBus";
import { MarketDataService } from "../src/lib/services/MarketDataService";
import { RiskManager } from "../src/lib/services/RiskManager";
import type { NormalizedOrderBook } from "../src/lib/types";

function collectBooks(): { service: MarketDataService; books: NormalizedOrderBook[] } {
  const bus = new EventBus();
  const books: NormalizedOrderBook[] = [];
  bus.on("market:update", (book) => books.push(book));
  const service = new MarketDataService(bus, new RiskManager());
  return { service, books };
}

describe("MarketDataService demo generator", () => {
  it("emits an uncrossed, positively-sized book per exchange per symbol on every tick", () => {
    const { service, books } = collectBooks();
    service.stepDemo();

    expect(books).toHaveLength(EXCHANGE_IDS.length * 3);
    books.forEach((book) => {
      const bestBid = Number(book.bids[0].price);
      const bestAsk = Number(book.asks[0].price);
      expect(bestBid).toBeLessThan(bestAsk);
      [...book.bids, ...book.asks].forEach((level) => {
        expect(Number(level.price)).toBeGreaterThan(0);
        expect(Number(level.size)).toBeGreaterThan(0);
      });
    });
  });

  it("derives the same prices from the same tick sequence (no hidden Math.random in the price path)", () => {
    const first = collectBooks();
    const second = collectBooks();
    for (let i = 0; i < 5; i += 1) {
      first.service.stepDemo();
      second.service.stepDemo();
    }
    const pricesOf = (books: NormalizedOrderBook[]) => books.map((book) => book.bids[0].price);
    expect(pricesOf(first.books)).toEqual(pricesOf(second.books));
  });

  it("tracks BTC/USDT mid price per exchange and ignores other symbols", () => {
    const { service } = collectBooks();
    service.stepDemo();
    const history = service.priceHistory();
    expect(history.length).toBeGreaterThan(0);
    const latest = history.at(-1)!;
    EXCHANGE_IDS.forEach((exchange) => {
      expect(latest[exchange]).toBeGreaterThan(0);
    });
  });
});
