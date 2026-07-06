import { describe, expect, it } from "vitest";
import { NeuralEdge, type NeuralEdgeBundle } from "../src/lib/services/NeuralEdge";

// A hand-built 2-feature MLP whose only non-zero path makes the output increase
// monotonically with feature "a": relu passes the positive branch, the second
// layer forwards it, and the head weights it positively -> larger a -> larger p.
const bundle: NeuralEdgeBundle = {
  version: 1,
  kind: "mlp",
  arch: [2, 2, 2, 1],
  featureKeys: ["a", "b"],
  mean: [0, 0],
  std: [1, 1],
  valAuc: 0.9,
  weights: {
    W1: [
      [1, 0],
      [0, 0]
    ],
    // bias keeps the driving hidden unit active across the whole test range, so
    // relu doesn't flatten the negative inputs to a tie.
    b1: [5, 0],
    W2: [
      [1, 0],
      [0, 0]
    ],
    b2: [0, 0],
    W3: [[2], [0]],
    b3: [-1]
  }
};

describe("NeuralEdge inference", () => {
  it("returns 0.5 (no opinion) until a model is loaded", () => {
    const net = new NeuralEdge();
    expect(net.isTrained()).toBe(false);
    expect(net.predict({ a: 5, b: 1 })).toBe(0.5);
  });

  it("rejects a payload that is not an mlp bundle", () => {
    const net = new NeuralEdge();
    expect(net.importModel({ kind: "trees", trees: [] })).toBe(false);
    expect(net.importModel(null)).toBe(false);
    expect(net.isTrained()).toBe(false);
  });

  it("loads a valid bundle and scores monotonically in the driving feature", () => {
    const net = new NeuralEdge();
    expect(net.importModel(bundle)).toBe(true);
    expect(net.isTrained()).toBe(true);
    const low = net.predict({ a: -3, b: 0 });
    const mid = net.predict({ a: 0, b: 0 });
    const high = net.predict({ a: 4, b: 0 });
    for (const p of [low, mid, high]) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
    expect(high).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(low);
    // Standardization uses the stored mean/std; a missing feature reads as 0.
    expect(net.predict({ a: 4 })).toBeCloseTo(high, 10);
  });
});
