import { describe, expect, it } from "vitest";
import { avellanedaStoikovMakerFraction } from "../src/lib/services/ArbitrageEngine";

describe("avellanedaStoikovMakerFraction", () => {
  it("stays within safe bounds for any input", () => {
    const cases = [
      [0, 0, 0], [100, 0.01, -1], [100, 100, 1], [2, 5, 0], [50, 0.1, -0.5]
    ] as const;
    for (const [vol, depth, imb] of cases) {
      const f = avellanedaStoikovMakerFraction(vol, depth, imb);
      expect(f).toBeGreaterThanOrEqual(0.2);
      expect(f).toBeLessThanOrEqual(0.6);
    }
  });

  it("quotes wider (more passive) in higher volatility", () => {
    const calm = avellanedaStoikovMakerFraction(2, 5, 0);
    const volatile = avellanedaStoikovMakerFraction(40, 5, 0);
    expect(volatile).toBeGreaterThan(calm);
  });

  it("quotes tighter in deeper books (higher kappa)", () => {
    const thin = avellanedaStoikovMakerFraction(5, 0.4, 0);
    const deep = avellanedaStoikovMakerFraction(5, 8, 0);
    expect(deep).toBeLessThan(thin);
  });

  it("widens under adverse order-flow imbalance", () => {
    const favorable = avellanedaStoikovMakerFraction(5, 3, 0.6);
    const adverse = avellanedaStoikovMakerFraction(5, 3, -0.6);
    expect(adverse).toBeGreaterThan(favorable);
  });
});
