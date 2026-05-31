import { describe, expect, it } from "vitest";
import { crc32, krakenChecksumPayload, preserveKrakenBookDecimals } from "../src/lib/services/KrakenBookChecksum";

describe("Kraken websocket v2 checksum", () => {
  it("matches the official BTC/USD depth-10 snapshot example", () => {
    const bids: Array<[string, string]> = [
      ["45283.5", "0.10000000"],
      ["45283.4", "1.54582015"],
      ["45282.1", "0.10000000"],
      ["45281.0", "0.10000000"],
      ["45280.3", "1.54592586"],
      ["45279.0", "0.07990000"],
      ["45277.6", "0.03310103"],
      ["45277.5", "0.30000000"],
      ["45277.3", "1.54602737"],
      ["45276.6", "0.15445238"]
    ];
    const asks: Array<[string, string]> = [
      ["45285.2", "0.00100000"],
      ["45286.4", "1.54571953"],
      ["45286.6", "1.54571109"],
      ["45289.6", "1.54560911"],
      ["45290.2", "0.15890660"],
      ["45291.8", "1.54553491"],
      ["45294.7", "0.04454749"],
      ["45296.1", "0.35380000"],
      ["45297.5", "0.09945542"],
      ["45299.5", "0.18772827"]
    ];

    expect(crc32(krakenChecksumPayload(bids, asks))).toBe(3310070434);
  });

  it("preserves wire precision before JSON parsing", () => {
    const source = '{"price":45281.0,"qty":0.10000000,"checksum":1}';

    expect(preserveKrakenBookDecimals(source)).toBe('{"price":"45281.0","qty":"0.10000000","checksum":1}');
  });
});
