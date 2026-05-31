import { describe, expect, it } from "vitest";
import { QuoteNormalizer } from "../src/lib/services/QuoteNormalizer";

describe("QuoteNormalizer", () => {
  it("normalizes USDT quotes into common USD while preserving source prices", () => {
    const normalizer = new QuoteNormalizer();
    normalizer.setUsdtUsdRate("0.9985");

    const [level] = normalizer.normalizeLevels([["70000", "0.25"]], "USDT");

    expect(level.sourcePrice).toBe("70000");
    expect(level.price).toBe("69895.00000000");
    expect(normalizer.quoteBasisBps("USDT")).toBe("-15.000");
    expect(normalizer.quoteToUsdRate("USD")).toBe("1.00000000");
  });
});
