// Inference for the NeuralEdge model: the small feed-forward network trained by
// scripts/trainNeural.ts. Pure TypeScript, zero deps -- the exact same forward
// pass used in training, so browser and gateway score identically. It complements
// the gradient-boosted tree ensemble (MlEdgeTensor): the trees split axis-aligned,
// the MLP bends the boundary, and a committee that averages the two is steadier
// than either alone.

export interface NeuralWeights {
  W1: number[][];
  b1: number[];
  W2: number[][];
  b2: number[];
  W3: number[][];
  b3: number[];
}

export interface NeuralEdgeBundle {
  version: number;
  kind: "mlp";
  arch: number[];
  featureKeys: string[];
  mean: number[];
  std: number[];
  weights: NeuralWeights;
  valAuc?: number;
}

function matVec(x: number[], W: number[][], b: number[]): number[] {
  const out = b.slice();
  for (let i = 0; i < W.length; i += 1) {
    const xi = x[i];
    if (xi === 0) continue;
    const row = W[i];
    for (let j = 0; j < row.length; j += 1) out[j] += xi * row[j];
  }
  return out;
}
const relu = (v: number[]): number[] => v.map((x) => (x > 0 ? x : 0));
const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

function isBundle(value: unknown): value is NeuralEdgeBundle {
  if (typeof value !== "object" || value === null) return false;
  const b = value as Partial<NeuralEdgeBundle>;
  return (
    b.kind === "mlp" &&
    Array.isArray(b.featureKeys) &&
    Array.isArray(b.mean) &&
    Array.isArray(b.std) &&
    typeof b.weights === "object" &&
    Array.isArray(b.weights?.W1)
  );
}

export class NeuralEdge {
  private bundle: NeuralEdgeBundle | null = null;

  importModel(bundle: unknown): boolean {
    if (!isBundle(bundle)) return false;
    this.bundle = bundle;
    return true;
  }

  isTrained(): boolean {
    return this.bundle !== null;
  }

  valAuc(): number | null {
    return this.bundle?.valAuc ?? null;
  }

  // Survival probability in [0,1] for a feature object (the same shape
  // MlEdgeTensor.extractFeatures returns). Returns 0.5 (no opinion) until loaded.
  predict(features: Record<string, number>): number {
    const b = this.bundle;
    if (!b) return 0.5;
    const x = b.featureKeys.map((key, j) => ((features[key] ?? 0) - b.mean[j]) / (b.std[j] || 1));
    const a1 = relu(matVec(x, b.weights.W1, b.weights.b1));
    const a2 = relu(matVec(a1, b.weights.W2, b.weights.b2));
    const z3 = matVec(a2, b.weights.W3, b.weights.b3);
    const p = sigmoid(z3[0]);
    return Number.isFinite(p) ? p : 0.5;
  }
}
