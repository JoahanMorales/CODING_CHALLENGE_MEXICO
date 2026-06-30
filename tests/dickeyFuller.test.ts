import { describe, expect, it } from "vitest";
import { dickeyFullerStat } from "../src/lib/services/ArbitrageEngine";

// Deterministic pseudo-random in [-1, 1] so the test is stable.
function noise(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return 2 * (x - Math.floor(x)) - 1;
}

describe("dickeyFullerStat (stationarity gate)", () => {
  it("rejects the unit root for a mean-reverting spread", () => {
    // Strong mean reversion around 0: y_t = 0.2*y_{t-1} + noise.
    const values: number[] = [0];
    for (let i = 1; i < 80; i += 1) {
      values.push(0.2 * values[i - 1] + noise(i));
    }
    expect(dickeyFullerStat(values)).toBeLessThan(-2.5);
  });

  it("does not reject the unit root for a random walk", () => {
    // y_t = y_{t-1} + noise -> non-stationary, t-stat near zero (not very negative).
    const values: number[] = [0];
    for (let i = 1; i < 80; i += 1) {
      values.push(values[i - 1] + noise(i));
    }
    expect(dickeyFullerStat(values)).toBeGreaterThan(-2.0);
  });

  it("is neutral with too few samples", () => {
    expect(dickeyFullerStat([1, 2, 3])).toBe(0);
  });
});
