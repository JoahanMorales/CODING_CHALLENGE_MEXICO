import { Decimal, d } from "../math/decimal";
import type { ExchangeId, ExecutionStyle, NormalizedOrderBook } from "../types";
import { midPrice, topAsk, topBid } from "./feeMath";

interface FeatureVector {
  netEdgeBps: number;
  alignment: number;
  liquidityScore: number;
  freshnessScore: number;
  volatilityBps: number;
  micropriceSkewBps: number;
  orderFlowImbalance: number;
  multiLevelOfi: number;
  buySpreadBps: number;
  sellSpreadBps: number;
  buyDepth5: number;
  sellDepth5: number;
  quoteSkewMs: number;
  ageMs: number;
  styleTaker: number;
  styleMaker: number;
  styleStatArb: number;
  buyImbalance: number;
  sellImbalance: number;
}

export interface TreeNode {
  featureIndex: number;
  threshold: number;
  leftScore: number;
  rightScore: number;
}

interface GradientBoostingEnsemble {
  trees: TreeNode[];
  learningRate: number;
}

// Bumped whenever the feature layout or training scheme changes, so a persisted
// model trained under an incompatible schema is rejected rather than misread.
// v2: populated the previously-dead features (alignment, volatilityBps,
// orderFlowImbalance, multiLevelOfi) with real microstructure (Cont-Kukanov OFI,
// Xu-Gould MLOFI, Stoikov microprice), so v1 models must not be reused.
export const ML_MODEL_VERSION = 2;

export interface MlModelSnapshot {
  version: number;
  trees: TreeNode[];
  learningRate: number;
  calibration: Record<string, MlCalibration>;
  trainedAt?: string;
  observations?: number;
}

interface StumpObservation {
  featureIndex: number;
  threshold: number;
  gradientSum: number;
  hessianSum: number;
  count: number;
}

interface MlCalibration {
  observations: number;
  brierScore: number;
  wins: number;
}

export class MlEdgeTensor {
  private ensemble: GradientBoostingEnsemble = { trees: [], learningRate: 0.3 };
  private readonly calibration = new Map<string, MlCalibration>();
  private readonly trainingBuffer: Array<{ features: FeatureVector; label: number; weight: number; route: string }> = [];
  private maxTrees = 32;

  // The ensemble only carries signal once it has been fitted on enough realized
  // outcomes. Callers gate on this so the model stays a no-op until it can help.
  isTrained(): boolean {
    return this.ensemble.trees.length > 0;
  }

  treeCount(): number {
    return this.ensemble.trees.length;
  }

  exportModel(): MlModelSnapshot {
    return {
      version: ML_MODEL_VERSION,
      trees: this.ensemble.trees.map((tree) => ({ ...tree })),
      learningRate: this.ensemble.learningRate,
      calibration: Object.fromEntries([...this.calibration.entries()].map(([route, cal]) => [route, { ...cal }])),
      trainedAt: new Date().toISOString(),
      observations: this.calibrationSummary().observations
    };
  }

  importModel(snapshot: MlModelSnapshot | null | undefined): boolean {
    if (!snapshot || snapshot.version !== ML_MODEL_VERSION || !Array.isArray(snapshot.trees)) return false;
    const trees = snapshot.trees.filter(isValidTreeNode);
    this.ensemble = {
      trees,
      learningRate: Number.isFinite(snapshot.learningRate) ? snapshot.learningRate : 0.3
    };
    this.calibration.clear();
    if (snapshot.calibration) {
      Object.entries(snapshot.calibration).forEach(([route, cal]) => {
        if (cal && Number.isFinite(cal.observations)) {
          this.calibration.set(route, {
            observations: Math.max(0, cal.observations),
            brierScore: Number.isFinite(cal.brierScore) ? Math.max(0, cal.brierScore) : 0,
            wins: Number.isFinite(cal.wins) ? Math.max(0, cal.wins) : 0
          });
        }
      });
    }
    return trees.length > 0;
  }

  extractFeatures(
    buyBook: NormalizedOrderBook,
    sellBook: NormalizedOrderBook,
    quantityBtc: Decimal,
    executionStyle: ExecutionStyle,
    netSpreadPct: Decimal
  ): FeatureVector {
    const buyAsk = topAsk(buyBook);
    const buyBid = topBid(buyBook);
    const sellAsk = topAsk(sellBook);
    const sellBid = topBid(sellBook);

    const netEdgeBps = netSpreadPct.mul(10000).toNumber();
    const mid = midPrice(buyBook);
    const buySpreadBps = buyAsk && buyBid
      ? buyAsk.price.minus(buyBid.price).div(buyAsk.price).mul(10000).toNumber()
      : 10;
    const sellSpreadBps = sellAsk && sellBid
      ? sellAsk.price.minus(sellBid.price).div(sellAsk.price).mul(10000).toNumber()
      : 10;

    const buyAskDepth5 = buyBook.asks.slice(0, 5).reduce((s, l) => s.plus(d(l.size)), d(0));
    const buyBidDepth5 = buyBook.bids.slice(0, 5).reduce((s, l) => s.plus(d(l.size)), d(0));
    const sellAskDepth5 = sellBook.asks.slice(0, 5).reduce((s, l) => s.plus(d(l.size)), d(0));
    const sellBidDepth5 = sellBook.bids.slice(0, 5).reduce((s, l) => s.plus(d(l.size)), d(0));
    const buyDepth5Amt = buyBidDepth5.plus(buyAskDepth5).toNumber();
    const sellDepth5Amt = sellBidDepth5.plus(sellAskDepth5).toNumber();

    const buyImbalance = buyAskDepth5.plus(buyBidDepth5).greaterThan(0)
      ? buyBidDepth5.minus(buyAskDepth5).div(buyAskDepth5.plus(buyBidDepth5)).toNumber()
      : 0;
    const sellImbalance = sellAskDepth5.plus(sellBidDepth5).greaterThan(0)
      ? sellBidDepth5.minus(sellAskDepth5).div(sellAskDepth5.plus(sellBidDepth5)).toNumber()
      : 0;

    const visibleDepth = Decimal.min(buyAskDepth5, sellBidDepth5);
    const liquidityScore = Math.max(0, Math.min(1, visibleDepth.div(Decimal.max(quantityBtc.mul(8), d("0.000001"))).toNumber()));

    const now = Date.now();
    const ageMs = Math.max(0, now - Math.min(buyBook.receivedAt, sellBook.receivedAt));
    const skewMs = Math.abs(buyBook.receivedAt - sellBook.receivedAt);
    const freshnessScore = Math.max(0, Math.min(1,
      0.58 * (1 - ageMs / 2800) + 0.42 * (1 - skewMs / 1800)
    ));

    // Microprice skew (Stoikov): size-weighted fair price vs mid. Computed on both
    // books so we can measure whether they agree (alignment) on short-term drift.
    const buyMicroSkewBps = micropriceSkewBps(buyBid, buyAsk);
    const sellMicroSkewBps = micropriceSkewBps(sellBid, sellAsk);

    // Order-flow imbalance (Cont-Kukanov-Stoikov 2014): signed queue imbalance at
    // the touch between the side we hit on each venue (we lift buyBook.ask and hit
    // sellBook.bid). Positive => more bid liquidity to sell into than ask to buy
    // from, i.e. book pressure favours the arb direction.
    const topBuyAsk = buyAsk ? buyAsk.size : d(0);
    const topSellBid = sellBid ? sellBid.size : d(0);
    const touchTotal = topBuyAsk.plus(topSellBid);
    const orderFlowImbalance = touchTotal.greaterThan(0)
      ? topSellBid.minus(topBuyAsk).div(touchTotal).toNumber()
      : 0;

    // Multi-level OFI (Xu-Gould-Howison 2018): the same imbalance but depth-weighted
    // across 5 levels (weight 1/(level+1)), which adds explanatory power for short-
    // horizon mid-price moves beyond the top of book.
    const weightedSellBid = weightedDepth(sellBook.bids);
    const weightedBuyAsk = weightedDepth(buyBook.asks);
    const weightedTotal = weightedSellBid + weightedBuyAsk;
    const multiLevelOfi = weightedTotal > 0 ? (weightedSellBid - weightedBuyAsk) / weightedTotal : 0;

    // Alignment: do both books' microprices lean the same way? Agreement (same sign)
    // is a stronger, less noisy directional signal than either book alone.
    const sameDirection = buyMicroSkewBps * sellMicroSkewBps > 0 ? 1 : -1;
    const alignment = Math.max(-1, Math.min(1, sameDirection * Math.min(1, (Math.abs(buyMicroSkewBps) + Math.abs(sellMicroSkewBps)) / 4)));

    // Instantaneous volatility proxy: the average quoted half-spread (bps). Wider
    // quotes accompany higher short-term uncertainty when a true realized-vol series
    // is unavailable from a single snapshot.
    const volatilityBps = (buySpreadBps + sellSpreadBps) / 2;

    return {
      netEdgeBps, alignment, liquidityScore, freshnessScore,
      volatilityBps, micropriceSkewBps: buyMicroSkewBps,
      orderFlowImbalance, multiLevelOfi,
      buySpreadBps, sellSpreadBps,
      buyDepth5: buyDepth5Amt, sellDepth5: sellDepth5Amt,
      quoteSkewMs: skewMs, ageMs,
      styleTaker: executionStyle === "INSTANT_TAKER" ? 1 : 0,
      styleMaker: executionStyle === "MAKER_ASSISTED" ? 1 : 0,
      styleStatArb: executionStyle === "STAT_MEAN_REVERSION" ? 1 : 0,
      buyImbalance, sellImbalance
    };
  }

  predict(features: FeatureVector): { survivalProbability: number; modelScore: number } {
    if (this.ensemble.trees.length === 0) {
      return this.predictWithCalibration(features, 0);
    }
    let rawScore = 0;
    for (const tree of this.ensemble.trees) {
      const featureValue = this.getFeature(features, tree.featureIndex);
      rawScore += featureValue <= tree.threshold ? tree.leftScore : tree.rightScore;
    }
    const survivalProbability = sigmoid(rawScore * this.ensemble.learningRate);
    return this.predictWithCalibration(features, survivalProbability);
  }

  private predictWithCalibration(features: FeatureVector, baseSurvival: number): { survivalProbability: number; modelScore: number } {
    let survival = baseSurvival;
    if (baseSurvival <= 0) {
      survival = 0.35 + features.netEdgeBps / 30 * 0.25 + features.liquidityScore * 0.2 + features.freshnessScore * 0.2;
      survival -= Math.max(0, features.ageMs / 5000) * 0.25;
      survival = clamp01(survival);
    }
    const modelScore = Math.round(clamp01(survival) * 100);
    return { survivalProbability: clamp01(survival), modelScore };
  }

  train(route: string, features: FeatureVector, realizedWin: number, weight: number): void {
    this.trainingBuffer.push({ features, label: realizedWin, weight: Math.max(0.05, Math.min(1, weight)), route });
    if (this.trainingBuffer.length > 200) this.trainingBuffer.shift();
    if (this.trainingBuffer.length >= 32) this.fitEnsemble();
  }

  private fitEnsemble(): void {
    const data = this.trainingBuffer;
    const n = data.length;
    const numFeatures = 20;
    let predictions = new Array(n).fill(0);

    this.ensemble.trees = [];
    for (let treeIdx = 0; treeIdx < this.maxTrees; treeIdx++) {
      const gradients = new Array(n);
      const hessians = new Array(n);
      for (let i = 0; i < n; i++) {
        const p = sigmoid(predictions[i]);
        gradients[i] = (p - data[i].label) * data[i].weight;
        hessians[i] = p * (1 - p) * data[i].weight;
      }

      const totalGradient = gradients.reduce((s, g) => s + g, 0);
      const totalHessian = hessians.reduce((s, h) => s + h, 0);
      const stump = this.findBestStump(data, gradients, hessians, numFeatures);

      if (!stump || stump.count < 4) break;
      // XGBoost optimal leaf weight is w* = -G / (H + lambda); the negation is
      // what points each leaf toward lower loss. Without it the ensemble learns
      // the inverse relationship (high survival for losing patterns).
      const leftGain = -stump.gradientSum / (stump.hessianSum + 1e-8);
      const rightGain = -(totalGradient - stump.gradientSum) / ((totalHessian - stump.hessianSum) + 1e-8);

      this.ensemble.trees.push({
        featureIndex: stump.featureIndex,
        threshold: stump.threshold,
        leftScore: leftGain,
        rightScore: rightGain
      });

      for (let i = 0; i < n; i++) {
        const fv = this.getFeature(data[i].features, stump.featureIndex);
        predictions[i] += fv <= stump.threshold ? leftGain : rightGain;
      }

      if (this.ensemble.trees.length >= 4) {
        const rmse = Math.sqrt(data.reduce((s, d, i) => s + (sigmoid(predictions[i]) - d.label) ** 2, 0) / n);
        if (rmse < 0.02) break;
      }
    }
  }

  private findBestStump(
    data: Array<{ features: FeatureVector; label: number; weight: number }>,
    gradients: number[],
    hessians: number[],
    numFeatures: number
  ): StumpObservation | null {
    let best: StumpObservation | null = null;
    let bestGain = -Infinity;

    for (let fIdx = 0; fIdx < numFeatures; fIdx++) {
      const values = data.map((d) => this.getFeature(d.features, fIdx));
      const sorted = values.map((v, i) => ({ v, g: gradients[i], h: hessians[i], w: data[i].weight }))
        .filter((x) => isFinite(x.v))
        .sort((a, b) => a.v - b.v);

      if (sorted.length < 4) continue;
      const midPoints: number[] = [];
      for (let i = 1; i < sorted.length; i++) {
        midPoints.push((sorted[i - 1].v + sorted[i].v) / 2);
      }

      for (const threshold of midPoints) {
        let leftG = 0, leftH = 0, leftCount = 0;
        for (let i = 0; i < sorted.length && sorted[i].v <= threshold; i++) {
          leftG += sorted[i].g;
          leftH += sorted[i].h;
          leftCount++;
        }
        if (leftCount < 2 || sorted.length - leftCount < 2) continue;
        const gain = leftG * leftG / (leftH + 1e-8)
          + (gradients.reduce((s, g) => s + g, 0) - leftG) ** 2 / (hessians.reduce((s, h) => s + h, 1e-8) - leftH + 1e-8)
          - gradients.reduce((s, g) => s + g, 0) ** 2 / (hessians.reduce((s, h) => s + h, 1e-8) + 1e-8);
        if (gain > bestGain) {
          bestGain = gain;
          best = { featureIndex: fIdx, threshold, gradientSum: leftG, hessianSum: leftH, count: leftCount };
        }
      }
    }
    return best;
  }

  private getFeature(features: FeatureVector, index: number): number {
    const f: (keyof FeatureVector)[] = [
      "netEdgeBps", "alignment", "liquidityScore", "freshnessScore",
      "volatilityBps", "micropriceSkewBps", "orderFlowImbalance", "multiLevelOfi",
      "buySpreadBps", "sellSpreadBps", "buyDepth5", "sellDepth5",
      "quoteSkewMs", "ageMs", "styleTaker", "styleMaker", "styleStatArb",
      "buyImbalance", "sellImbalance", "netEdgeBps"
    ];
    const key = f[index] ?? "netEdgeBps";
    const value = features[key];
    return typeof value === "number" ? value : 0;
  }

  recordOutcome(route: string, predictedSurvival: number, realizedPnlUsd: number, weight?: number): void {
    const current = this.calibration.get(route) ?? { observations: 0, brierScore: 0, wins: 0 };
    const realizedWin = realizedPnlUsd > 0 ? 1 : 0;
    const w = Math.max(0.05, Math.min(1, weight ?? 1));
    const forecastError = realizedWin - clamp01(predictedSurvival);
    this.calibration.set(route, {
      observations: current.observations + w,
      brierScore: current.observations
        ? current.brierScore * 0.92 + forecastError ** 2 * 0.08
        : forecastError ** 2,
      wins: current.wins + (realizedWin ? w : 0)
    });
  }

  calibrationSummary(): { observations: number; brierScore: number } {
    const routes = [...this.calibration.values()];
    const observations = routes.reduce((s, r) => s + r.observations, 0);
    const weightedBrier = routes.reduce((s, r) => s + r.brierScore * r.observations, 0);
    return { observations: Math.round(observations), brierScore: observations ? weightedBrier / observations : 0 };
  }
}

function isValidTreeNode(tree: unknown): tree is TreeNode {
  if (typeof tree !== "object" || tree === null) return false;
  const node = tree as Record<string, unknown>;
  return (
    Number.isFinite(node.featureIndex) &&
    Number.isFinite(node.threshold) &&
    Number.isFinite(node.leftScore) &&
    Number.isFinite(node.rightScore)
  );
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

// Size-weighted microprice vs mid, in bps (Stoikov). Positive => fair price above
// mid (upward short-term pressure).
function micropriceSkewBps(bid?: { price: Decimal; size: Decimal } | null, ask?: { price: Decimal; size: Decimal } | null): number {
  if (!bid || !ask) return 0;
  const total = bid.size.plus(ask.size);
  if (total.lessThanOrEqualTo(0)) return 0;
  const mp = bid.price.plus(ask.price).div(2);
  if (mp.lessThanOrEqualTo(0)) return 0;
  const micro = bid.price.mul(ask.size).plus(ask.price.mul(bid.size)).div(total);
  return micro.minus(mp).div(mp).mul(10000).toNumber();
}

// Depth across the top 5 levels weighted by 1/(level+1) (MLOFI weighting).
function weightedDepth(levels: Array<{ size: string }>): number {
  let sum = 0;
  for (let level = 0; level < Math.min(5, levels.length); level += 1) {
    sum += Number(levels[level].size) / (level + 1);
  }
  return sum;
}
