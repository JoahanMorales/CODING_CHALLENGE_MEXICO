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
  // Optional Platt scaling (Platt 1999) of the boosted margin: survival =
  // sigmoid(a*margin + b) instead of sigmoid(margin). Absent => identity
  // (a=1, b=0), so pre-calibration snapshots keep their exact behavior.
  platt?: { a: number; b: number };
  // Optional isotonic calibration (PAV blocks) as the non-parametric
  // alternative: knots (x = margin, y = calibrated probability), linearly
  // interpolated. At most one of platt/isotonic is attached — offline training
  // fits both on the calibration fold and ships whichever has the lower Brier
  // on the untouched evaluation fold.
  isotonic?: { x: number[]; y: number[] };
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
  private platt: { a: number; b: number } | null = null;
  private isotonic: { x: number[]; y: number[] } | null = null;

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
      ...(this.platt ? { platt: { ...this.platt } } : {}),
      ...(this.isotonic ? { isotonic: { x: [...this.isotonic.x], y: [...this.isotonic.y] } } : {}),
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
    this.platt =
      snapshot.platt && Number.isFinite(snapshot.platt.a) && Number.isFinite(snapshot.platt.b) && snapshot.platt.a > 0
        ? { a: snapshot.platt.a, b: snapshot.platt.b }
        : null;
    this.isotonic = isValidIsotonic(snapshot.isotonic) ? { x: [...snapshot.isotonic!.x], y: [...snapshot.isotonic!.y] } : null;
    return trees.length > 0;
  }

  // The raw boosted margin (pre-sigmoid, pre-Platt). This is the quantity Platt
  // scaling maps to a calibrated probability; null while untrained.
  rawMargin(features: FeatureVector): number | null {
    if (this.ensemble.trees.length === 0) return null;
    let rawScore = 0;
    for (const tree of this.ensemble.trees) {
      const featureValue = this.getFeature(features, tree.featureIndex);
      rawScore += featureValue <= tree.threshold ? tree.leftScore : tree.rightScore;
    }
    return rawScore * this.ensemble.learningRate;
  }

  // a must be positive: Platt scaling is only attached when it preserves the
  // ranking the ensemble learned (a monotonic map keeps AUC identical while
  // fixing the probability scale that Kelly sizing consumes). Attaching either
  // calibrator replaces the other — exactly one map is ever active.
  setPlattCalibration(a: number, b: number): boolean {
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) return false;
    this.platt = { a, b };
    this.isotonic = null;
    return true;
  }

  plattCalibration(): { a: number; b: number } | null {
    return this.platt ? { ...this.platt } : null;
  }

  setIsotonicCalibration(x: number[], y: number[]): boolean {
    if (!isValidIsotonic({ x, y })) return false;
    this.isotonic = { x: [...x], y: [...y] };
    this.platt = null;
    return true;
  }

  isotonicCalibration(): { x: number[]; y: number[] } | null {
    return this.isotonic ? { x: [...this.isotonic.x], y: [...this.isotonic.y] } : null;
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
    const margin = this.rawMargin(features);
    if (margin === null) {
      return this.predictWithCalibration(features, 0);
    }
    const survivalProbability = this.isotonic
      ? interpolateIsotonic(this.isotonic, margin)
      : this.platt
        ? sigmoid(this.platt.a * margin + this.platt.b)
        : sigmoid(margin);
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

    // Refitting the trees changes the margin distribution, so any calibration
    // mapping fit for the previous ensemble is stale — fall back to identity
    // rather than applying a wrong recalibration to new margins.
    this.platt = null;
    this.isotonic = null;
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

// Platt scaling (Platt 1999): fit survival = sigmoid(a*margin + b) by maximum
// likelihood over held-out (margin, label) pairs, with Platt's target smoothing
// (t+ = (N+ + 1)/(N+ + 2), t- = 1/(N- + 2)) so the fit doesn't chase 0/1
// extremes on finite samples. Newton-Raphson on the 2-parameter logistic; the
// map is monotonic (a > 0), so it repairs the probability scale that Kelly
// sizing consumes WITHOUT changing the ranking (AUC) the ensemble learned.
// Returns null when the fit is degenerate (single class, too few points, or a
// non-positive slope), in which case callers keep the identity calibration.
export function fitPlattScaling(points: Array<{ margin: number; label: number }>): { a: number; b: number } | null {
  const clean = points.filter((p) => Number.isFinite(p.margin) && (p.label === 0 || p.label === 1));
  const nPos = clean.filter((p) => p.label === 1).length;
  const nNeg = clean.length - nPos;
  if (nPos < 5 || nNeg < 5) return null;

  const tPos = (nPos + 1) / (nPos + 2);
  const tNeg = 1 / (nNeg + 2);
  const targets = clean.map((p) => (p.label === 1 ? tPos : tNeg));

  let a = 1;
  let b = 0;
  for (let iter = 0; iter < 100; iter += 1) {
    let gradA = 0;
    let gradB = 0;
    let hAA = 0;
    let hAB = 0;
    let hBB = 0;
    for (let i = 0; i < clean.length; i += 1) {
      const m = clean[i].margin;
      const p = sigmoid(a * m + b);
      const diff = p - targets[i];
      const w = Math.max(1e-12, p * (1 - p));
      gradA += diff * m;
      gradB += diff;
      hAA += w * m * m;
      hAB += w * m;
      hBB += w;
    }
    const det = hAA * hBB - hAB * hAB;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) break;
    const stepA = (hBB * gradA - hAB * gradB) / det;
    const stepB = (hAA * gradB - hAB * gradA) / det;
    a -= stepA;
    b -= stepB;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    if (Math.abs(stepA) < 1e-9 && Math.abs(stepB) < 1e-9) break;
  }

  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) return null;
  return { a, b };
}

// Isotonic calibration via Pool Adjacent Violators (PAV): the classic
// non-parametric alternative to Platt (Zadrozny & Elkan 2002). Sorts points by
// margin and pools adjacent blocks until block means are non-decreasing; the
// resulting step function is stored as (x, y) knots and linearly interpolated
// at prediction time (interpolation keeps the map monotone while avoiding the
// staircase's zero-gradient plateaus). y is clamped away from 0/1 so a
// perfectly-separated block can't emit a degenerate probability into Kelly.
// Non-parametric => more flexible than Platt's 2 params, but needs more data;
// offline training fits BOTH and ships whichever wins on the eval fold.
export function fitIsotonicCalibration(points: Array<{ margin: number; label: number }>): { x: number[]; y: number[] } | null {
  const clean = points
    .filter((p) => Number.isFinite(p.margin) && (p.label === 0 || p.label === 1))
    .sort((a, b) => a.margin - b.margin);
  const nPos = clean.reduce((s, p) => s + p.label, 0);
  const nNeg = clean.length - nPos;
  if (nPos < 5 || nNeg < 5) return null;

  interface Block { sum: number; n: number; lo: number; hi: number }
  const blocks: Block[] = [];
  for (const point of clean) {
    let block: Block = { sum: point.label, n: 1, lo: point.margin, hi: point.margin };
    while (blocks.length && blocks[blocks.length - 1].sum / blocks[blocks.length - 1].n >= block.sum / block.n) {
      const prev = blocks.pop()!;
      block = { sum: prev.sum + block.sum, n: prev.n + block.n, lo: prev.lo, hi: block.hi };
    }
    blocks.push(block);
  }
  if (blocks.length < 2) return null;

  const rawX = blocks.map((b) => (b.lo + b.hi) / 2);
  const rawY = blocks.map((b) => Math.min(0.999, Math.max(0.001, b.sum / b.n)));
  // Duplicate margins can leave adjacent blocks with the same midpoint; keep the
  // last (highest-y) knot at each x so the map stays strictly increasing in x.
  const x: number[] = [];
  const y: number[] = [];
  for (let i = 0; i < rawX.length; i += 1) {
    if (x.length && rawX[i] <= x[x.length - 1]) {
      y[y.length - 1] = Math.max(y[y.length - 1], rawY[i]);
    } else {
      x.push(rawX[i]);
      y.push(rawY[i]);
    }
  }
  if (x.length < 2) return null;

  // Keep snapshots bounded: PAV block counts are usually small, but cap the
  // knot count anyway (uniform downsample preserving the endpoints).
  const MAX_KNOTS = 200;
  if (x.length > MAX_KNOTS) {
    const sampledX: number[] = [];
    const sampledY: number[] = [];
    for (let i = 0; i < MAX_KNOTS; i += 1) {
      const idx = Math.round((i * (x.length - 1)) / (MAX_KNOTS - 1));
      sampledX.push(x[idx]);
      sampledY.push(y[idx]);
    }
    return { x: sampledX, y: sampledY };
  }
  return { x, y };
}

export function interpolateIsotonic(map: { x: number[]; y: number[] }, margin: number): number {
  const { x, y } = map;
  if (margin <= x[0]) return y[0];
  if (margin >= x[x.length - 1]) return y[y.length - 1];
  let lo = 0;
  let hi = x.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (x[mid] <= margin) lo = mid;
    else hi = mid;
  }
  const span = x[hi] - x[lo];
  const t = span > 0 ? (margin - x[lo]) / span : 0;
  return y[lo] + t * (y[hi] - y[lo]);
}

function isValidIsotonic(map: { x: number[]; y: number[] } | undefined): boolean {
  if (!map || !Array.isArray(map.x) || !Array.isArray(map.y)) return false;
  if (map.x.length !== map.y.length || map.x.length < 2) return false;
  for (let i = 0; i < map.x.length; i += 1) {
    if (!Number.isFinite(map.x[i]) || !Number.isFinite(map.y[i]) || map.y[i] < 0 || map.y[i] > 1) return false;
    if (i > 0 && (map.x[i] <= map.x[i - 1] || map.y[i] < map.y[i - 1])) return false;
  }
  return true;
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
