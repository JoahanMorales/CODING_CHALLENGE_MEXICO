import { describe, expect, it } from "vitest";
import { ArbitrAIKernel } from "../src/lib/services/ArbitrAIKernel";

describe("Demo execution loop", () => {
  it("produces a profitable paper fill after a controlled fragmentation pulse", async () => {
    const kernel = new ArbitrAIKernel();

    for (let tick = 0; tick < 19; tick += 1) {
      kernel.marketData.stepDemo();
    }
    await new Promise((resolve) => setTimeout(resolve, 700));

    // The async drainQueue may not finish within the initial 700ms wait
    // when running under --pool forks, so poll up to 3s for completion.
    const deadline = Date.now() + 3000;
    let metrics = kernel.pnlTracker.metrics();
    while (metrics.tradesExecuted === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      metrics = kernel.pnlTracker.metrics();
    }

    expect(metrics.executableOpportunities).toBeGreaterThan(0);
    expect(metrics.tradesExecuted).toBeGreaterThan(0);
    expect(Number(metrics.netPnlUsd)).toBeGreaterThan(0);
  });
});
