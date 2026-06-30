import { describe, expect, it } from "vitest";
import { RollingWindow } from "../src/lib/services/RollingWindow";

describe("RollingWindow", () => {
  it("returns zeroed stats on an empty window", () => {
    const window = new RollingWindow(1000);
    expect(window.count()).toBe(0);
    expect(window.values()).toEqual([]);
    expect(window.mean()).toBe(0);
    expect(window.stdDev()).toBe(0);
  });

  it("returns zero stdDev for a single point (sample variance is undefined below n=2)", () => {
    const window = new RollingWindow(1000);
    window.push({ time: 0, value: 42 });
    expect(window.stdDev(0)).toBe(0);
    expect(window.mean(0)).toBe(42);
  });

  it("computes sample mean and stdDev over points inside the window", () => {
    const window = new RollingWindow(1000);
    [2, 4, 4, 4, 5, 5, 7, 9].forEach((value, index) => window.push({ time: index, value }));
    expect(window.mean(7)).toBe(5);
    expect(window.stdDev(7)).toBeCloseTo(2.138, 2);
  });

  it("prunes points older than windowMs relative to the query time", () => {
    const window = new RollingWindow(1000);
    window.push({ time: 0, value: 100 });
    window.push({ time: 500, value: 200 });
    expect(window.count(900)).toBe(2);
    expect(window.values(1300)).toEqual([200]);
    expect(window.count(2600)).toBe(0);
  });

  it("prunes lazily on push, not eagerly on a timer", () => {
    const window = new RollingWindow(100);
    window.push({ time: 0, value: 1 });
    window.push({ time: 50, value: 2 });
    window.push({ time: 250, value: 3 });
    expect(window.values(250)).toEqual([3]);
  });
});
