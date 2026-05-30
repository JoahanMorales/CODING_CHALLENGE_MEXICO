import { describe, expect, it } from "vitest";
import { ArbitrAIKernel } from "../src/lib/services/ArbitrAIKernel";

describe("Demo execution loop", () => {
  it("produces a profitable paper fill after a controlled fragmentation pulse", async () => {
    const kernel = new ArbitrAIKernel();

    for (let tick = 0; tick < 19; tick += 1) {
      kernel.marketData.stepDemo();
    }
    await new Promise((resolve) => setTimeout(resolve, 700));

    const metrics = kernel.pnlTracker.metrics();
    expect(metrics.executableOpportunities).toBeGreaterThan(0);
    expect(metrics.tradesExecuted).toBeGreaterThan(0);
    expect(Number(metrics.netPnlUsd)).toBeGreaterThan(0);
  });
});
