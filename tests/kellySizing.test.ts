import { describe, expect, it } from "vitest";
import { kellySizeFraction } from "../src/lib/services/ArbitrageEngine";

describe("kellySizeFraction (fractional Kelly position sizing)", () => {
  it("sizes a strong, high-survival edge near the full base", () => {
    const f = kellySizeFraction(0.8, 30, 3);
    expect(f).toBeGreaterThan(0.6);
    expect(f).toBeLessThanOrEqual(1);
  });

  it("trims a marginal or unfavorable edge to the floor", () => {
    expect(kellySizeFraction(0.4, 1, 10)).toBe(0.3);
  });

  it("never exceeds the conservative base (clamped to 1)", () => {
    expect(kellySizeFraction(1, 1000, 1)).toBe(1);
  });

  it("is monotonic in survival probability", () => {
    expect(kellySizeFraction(0.85, 20, 4)).toBeGreaterThan(kellySizeFraction(0.6, 20, 4));
  });
});
