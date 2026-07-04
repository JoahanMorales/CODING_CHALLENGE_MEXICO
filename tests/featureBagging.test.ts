import { describe, it, expect } from "vitest";
import { MlEdgeTensor } from "../src/lib/services/MlEdgeTensor";

// The definitive tape run showed the greedy boosted ensemble collapsing onto a
// single dominant feature (netEdgeBps): every split picks it, so permutation
// importance is zero for all 23 other features. configureBoosting() adds
// stochastic column subsampling (Friedman 2002) so netEdgeBps cannot win every
// round -- the experiment that asks whether any other feature carries signal
// once the greedy monopoly is broken. These tests pin the MECHANISM (defaults
// stay byte-identical; bagging genuinely diversifies which features get used;
// the fit stays reproducible under a fixed seed).

// All 24 fields, defaulting to 0. The label is driven ONLY by netEdgeBps so the
// deterministic greedy fit provably collapses onto feature index 0.
const FEATURE_KEYS = [
  "netEdgeBps", "alignment", "liquidityScore", "freshnessScore",
  "volatilityBps", "micropriceSkewBps", "orderFlowImbalance", "multiLevelOfi",
  "buySpreadBps", "sellSpreadBps", "buyDepth5", "sellDepth5",
  "quoteSkewMs", "ageMs", "styleTaker", "styleMaker", "styleStatArb",
  "buyImbalance", "sellImbalance",
  "buyMidMomentumBps", "sellMidMomentumBps", "realizedVolBps",
  "buyImbalanceDelta", "sellImbalanceDelta"
] as const;

function makeFeatures(overrides: Partial<Record<(typeof FEATURE_KEYS)[number], number>>) {
  const f: Record<string, number> = {};
  for (const k of FEATURE_KEYS) f[k] = 0;
  Object.assign(f, overrides);
  // The parameter type is the (unexported) FeatureVector; the object is
  // structurally identical, so this cast only supplies the name.
  return f as unknown as Parameters<MlEdgeTensor["train"]>[1];
}

// Deterministic PRNG so the synthetic dataset is identical run-to-run.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 64 samples: netEdgeBps sign perfectly determines the label; every other
// feature is pure noise (no label information), so only bagging can pull them in.
function buildSamples(): Array<{ features: ReturnType<typeof makeFeatures>; label: number }> {
  const rng = mulberry32(0xabc123);
  const samples: Array<{ features: ReturnType<typeof makeFeatures>; label: number }> = [];
  for (let i = 0; i < 64; i += 1) {
    const netEdgeBps = i % 2 === 0 ? 4 + rng() * 6 : -(4 + rng() * 6);
    const label = netEdgeBps > 0 ? 1 : 0;
    samples.push({
      features: makeFeatures({
        netEdgeBps,
        liquidityScore: rng(),
        freshnessScore: rng(),
        volatilityBps: rng() * 20,
        buySpreadBps: rng() * 5,
        sellSpreadBps: rng() * 5,
        buyImbalance: rng() * 2 - 1,
        sellImbalance: rng() * 2 - 1
      }),
      label
    });
  }
  return samples;
}

function distinctFeatures(model: ReturnType<MlEdgeTensor["exportModel"]>): number[] {
  return [...new Set(model.trees.map((t) => t.featureIndex))].sort((a, b) => a - b);
}

describe("feature bagging (stochastic column subsampling)", () => {
  it("default fit collapses onto the single dominant feature (netEdgeBps)", () => {
    const ml = new MlEdgeTensor();
    for (const s of buildSamples()) ml.train("r", s.features, s.label, 1);
    const model = ml.exportModel();
    expect(model.trees.length).toBeGreaterThan(0);
    // Greedy full-scan picks netEdgeBps (index 0) every round.
    expect(distinctFeatures(model)).toEqual([0]);
  });

  it("bagging pulls in features beyond netEdgeBps", () => {
    const ml = new MlEdgeTensor();
    ml.configureBoosting({ featureSampleRatio: 0.25, minStopTrees: 20, stopRmse: 0.0001, maxTrees: 24, seed: 12345 });
    for (const s of buildSamples()) ml.train("r", s.features, s.label, 1);
    const used = distinctFeatures(ml.exportModel());
    // 6 of 24 features per tree -> netEdgeBps is excluded ~75% of rounds, so
    // other features must win those splits. Expect genuine diversity.
    expect(used.length).toBeGreaterThanOrEqual(4);
    // netEdgeBps still wins whenever it is in the sampled subset.
    expect(used).toContain(0);
  });

  it("bagged fit is reproducible under a fixed seed", () => {
    const fit = () => {
      const ml = new MlEdgeTensor();
      ml.configureBoosting({ featureSampleRatio: 0.3, minStopTrees: 16, stopRmse: 0.0005, maxTrees: 24, seed: 777 });
      for (const s of buildSamples()) ml.train("r", s.features, s.label, 1);
      return ml.exportModel().trees;
    };
    expect(JSON.stringify(fit())).toEqual(JSON.stringify(fit()));
  });
});
