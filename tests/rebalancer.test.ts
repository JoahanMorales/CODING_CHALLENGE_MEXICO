import { describe, expect, it } from "vitest";
import { INITIAL_WALLETS } from "../src/lib/config/exchanges";
import { d } from "../src/lib/math/decimal";
import { ExecutionSimulator } from "../src/lib/services/ExecutionSimulator";

// The rebalancer's target for each venue/asset IS its seed value, so to exercise
// it we start from the seed and then push a couple of wallets off-band (exactly
// what a run of same-direction trades does). We reach into the internal wallet
// map for that — the public surface intentionally only mutates balances through
// fills.
function skew(sim: ExecutionSimulator, ex: string, asset: "btc" | "usdt", value: string) {
  (sim as unknown as { wallets: Map<string, { btc: unknown; usdt: unknown }> }).wallets.get(ex)![asset] = d(value);
}
const bal = (sim: ExecutionSimulator, ex: string) => sim.balances().find((b) => b.exchange === ex)!;

describe("ExecutionSimulator.rebalance", () => {
  it("pulls surplus from the richest donor into a venue below its band", () => {
    const sim = new ExecutionSimulator();
    skew(sim, "coinbase", "usdt", "18000"); // target 35000 -> deep below band
    skew(sim, "binance", "usdt", "110000"); // target 70000 -> surplus donor

    const actions = sim.rebalance(d("70000"));
    const usdtMove = actions.find((a) => a.asset === "USDT");
    expect(usdtMove).toBeDefined();
    expect(usdtMove!.fromExchange).toBe("binance");
    expect(usdtMove!.toExchange).toBe("coinbase");
    // Needy venue restored to its target; nobody left below band.
    expect(Number(bal(sim, "coinbase").usdt.replace(/[^0-9.]/g, ""))).toBeCloseTo(35000, 0);
    expect(sim.balances().every((b) => !b.rebalancingNeeded)).toBe(true);
  });

  it("charges the donor's real withdrawal fee and never drains it below target", () => {
    const sim = new ExecutionSimulator();
    skew(sim, "coinbase", "btc", "0.30"); // target 0.5
    skew(sim, "bybit", "btc", "1.20"); // target 0.8 -> 0.4 surplus

    const before = Number(bal(sim, "bybit").btc);
    const actions = sim.rebalance(d("70000"));
    const btcMove = actions.find((a) => a.asset === "BTC");
    expect(btcMove).toBeDefined();
    // bybit withdrawalBtc fee is 0.0002; moving 0.2 BTC costs 0.0002 on top.
    expect(Number(btcMove!.costUsd.replace(/[^0-9.]/g, ""))).toBeCloseTo(0.0002 * 70000, 1);
    const donorBtc = Number(bal(sim, "bybit").btc);
    expect(donorBtc).toBeGreaterThanOrEqual(0.8 - 1e-6); // never below its own target
    expect(donorBtc).toBeLessThan(before);
  });

  it("is idempotent — a balanced book yields no transfers", () => {
    const sim = new ExecutionSimulator(INITIAL_WALLETS);
    expect(sim.rebalance(d("70000"))).toEqual([]);
  });

  it("does nothing when there is a deficit but no venue holds a surplus", () => {
    const sim = new ExecutionSimulator();
    // Everyone's USDT drained equally: needy exists, but no donor above band.
    for (const ex of Object.keys(INITIAL_WALLETS)) skew(sim, ex, "usdt", "1000");
    expect(sim.rebalance(d("70000")).filter((a) => a.asset === "USDT")).toEqual([]);
  });
});
