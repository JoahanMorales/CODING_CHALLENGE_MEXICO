import { describe, expect, it } from "vitest";
import { BookIntegrityService } from "../src/lib/services/BookIntegrityService";

describe("BookIntegrityService", () => {
  it("detects sequence gaps and records snapshot resyncs", () => {
    const service = new BookIntegrityService();

    expect(service.assess("okx", { sequence: "10", snapshot: true }).status).toBe("SEQUENCED");
    const degraded = service.assess("okx", { previousSequence: "7", sequence: "12", snapshot: true });

    expect(degraded.status).toBe("DEGRADED");
    expect(degraded.gapCount).toBe(1);
    expect(degraded.resyncCount).toBe(1);
  });

  it("tracks each symbol independently when venue messages interleave", () => {
    const service = new BookIntegrityService();

    service.assess("binance", { streamKey: "BTC/USDT", sequence: "10", snapshot: true });
    service.assess("binance", { streamKey: "ETH/USDT", sequence: "55", snapshot: true });
    const btc = service.assess("binance", {
      streamKey: "BTC/USDT",
      previousSequence: "10",
      sequence: "11",
      snapshot: true
    });

    expect(btc.status).toBe("SEQUENCED");
    expect(btc.gapCount).toBe(0);
  });
});
