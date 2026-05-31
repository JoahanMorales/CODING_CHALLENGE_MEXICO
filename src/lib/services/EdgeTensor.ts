import { Decimal, d, usd } from "../math/decimal";
import type { ExchangeId, ExecutionStyle, NormalizedOrderBook } from "../types";
import { midPrice, topAsk, topBid } from "./feeMath";

interface VenueState {
  ewmaOfi: number;
  ewmaMultiLevelOfi: number;
  ewmaVolatilityBps: number;
  lastBook?: NormalizedOrderBook;
  lastMid?: Decimal;
  lastBookAt: number;
  wsLatencyMs: number;
}

export interface RouteCalibration {
  bias: number;
  brierScore: number;
  observations: number;
  wins: number;
}

export interface EdgeTensorInput {
  route: string;
  buyBook: NormalizedOrderBook;
  sellBook: NormalizedOrderBook;
  executionStyle: ExecutionStyle;
  expectedProfitUsd: Decimal;
  netSpreadPct: Decimal;
  quantityBtc: Decimal;
}

export interface EdgeOutcome {
  route: string;
  predictedSurvival: number;
  realizedPnlUsd: number;
  weight?: number;
}

export interface EdgeTensorSignal {
  adverseSelectionBps: number;
  edgeQuality: "EXPLOIT" | "WATCH" | "AVOID";
  liquidityScore: number;
  expectedValueUsd: Decimal;
  fillProbability: number;
  legRiskProbability: number;
  micropriceSkewBps: number;
  modelScore: number;
  orderFlowImbalance: number;
  quoteAgeMs: number;
  quoteFreshnessScore: number;
  quoteSkewMs: number;
  riskAdjustedProfitUsd: Decimal;
  suggestedSizeScale: number;
  survivalProbability: number;
  volatilityBps: number;
}

export class EdgeTensor {
  private readonly venueStates = new Map<string, VenueState>();
  private readonly routeCalibration = new Map<string, RouteCalibration>();

  ingest(book: NormalizedOrderBook): void {
    if (book.symbol !== "BTC/USDT") return;
    const key = stateKey(book.exchange);
    const existing = this.venueStates.get(key);
    const state: VenueState = existing ?? {
      ewmaOfi: 0,
      ewmaMultiLevelOfi: 0,
      ewmaVolatilityBps: 0,
      lastBookAt: 0,
      wsLatencyMs: 0
    };
    const previous = state.lastBook;
    const mid = midPrice(book);

    if (previous) {
      const ofi = normalizedOrderFlowImbalance(previous, book);
      state.ewmaOfi = ewma(state.ewmaOfi, ofi, 0.22);
      state.ewmaMultiLevelOfi = ewma(state.ewmaMultiLevelOfi, normalizedMultiLevelOfi(previous, book), 0.18);
    }

    if (mid && state.lastMid && state.lastMid.greaterThan(0)) {
      const returnBps = mid.minus(state.lastMid).div(state.lastMid).mul(10000).abs().toNumber();
      state.ewmaVolatilityBps = ewma(state.ewmaVolatilityBps, returnBps, 0.12);
    }

    state.lastBook = book;
    state.lastMid = mid ?? state.lastMid;
    state.lastBookAt = book.receivedAt;
    state.wsLatencyMs = book.processingLatencyMs;
    this.venueStates.set(key, state);
  }

  routeSignal(input: EdgeTensorInput): EdgeTensorSignal {
    const buyState = this.venueStates.get(stateKey(input.buyBook.exchange));
    const sellState = this.venueStates.get(stateKey(input.sellBook.exchange));
    const buySkew = microSkewBps(input.buyBook);
    const sellSkew = microSkewBps(input.sellBook);
    const buyImbalance = bookImbalance(input.buyBook);
    const sellImbalance = bookImbalance(input.sellBook);
    const buyOfi = buyState?.ewmaOfi ?? 0;
    const sellOfi = sellState?.ewmaOfi ?? 0;
    const buyMultiLevelOfi = buyState?.ewmaMultiLevelOfi ?? 0;
    const sellMultiLevelOfi = sellState?.ewmaMultiLevelOfi ?? 0;
    const volatilityBps = ((buyState?.ewmaVolatilityBps ?? 0) + (sellState?.ewmaVolatilityBps ?? 0)) / 2;
    const netEdgeBps = input.netSpreadPct.mul(10000).toNumber();
    const liquidityScore = liquidityDepthScore(input.buyBook, input.sellBook, input.quantityBtc);
    const timing = quoteTiming(input.buyBook, input.sellBook);

    // Cross-venue arbitrage survives better when the buy venue shows sell pressure
    // and the sell venue shows buy pressure. OFI reacts faster than mid-price.
    // Cont/Kukanov/Stoikov show that OFI scales inversely with market depth.
    // Xu/Gould/Howison extend that intuition deeper into the book. The blend
    // reacts quickly at the touch while rejecting edges contradicted by depth.
    const pressureAlignment = sigmoid(((-buyOfi + sellOfi) * 0.72 + (-buyMultiLevelOfi + sellMultiLevelOfi) * 0.58) * 1.35);
    const micropriceAlignment = sigmoid((-buySkew + sellSkew) / 3.2);
    const depthAlignment = sigmoid((-buyImbalance + sellImbalance) * 1.15);
    const alignment = pressureAlignment * 0.48 + micropriceAlignment * 0.34 + depthAlignment * 0.18;
    const styleBoost = input.executionStyle === "MAKER_ASSISTED" ? 0.08 : input.executionStyle === "STAT_MEAN_REVERSION" ? 0.05 : 0;
    const edgeStrength = sigmoid(netEdgeBps * 0.72);
    const volatilityPenalty = sigmoid((volatilityBps - 1.8) * 0.9);
    const delayBetweenLegsMs = timing.skewMs + 200;
    const driftRiskBps = volatilityBps * Math.sqrt(delayBetweenLegsMs / 60000) * 1.96;
    const driftRiskPenalty = driftRiskBps / 20 * 0.12;
    const calibration = this.routeCalibration.get(input.route);
    const calibrationBias = calibration?.bias ?? 0;
    // A cross-venue spread is only actionable while both quotes describe the
    // same short-lived market state. Age and inter-venue skew reduce survival
    // before the signal can reach execution.
    const survivalProbability = clamp01(
      0.08 +
        edgeStrength * 0.3 +
        alignment * 0.28 +
        liquidityScore * 0.14 +
        timing.freshnessScore * 0.2 +
        styleBoost -
        volatilityPenalty * 0.18 -
        driftRiskPenalty +
        calibrationBias
    );
    const adverseSelectionBps = Math.max(
      0,
      volatilityBps * 0.34 +
        (1 - alignment) * 2.4 +
        (1 - timing.freshnessScore) * 3.4 -
        Math.max(0, netEdgeBps) * 0.16
    );
    const notional = notionalUsd(input.buyBook, input.quantityBtc);
    const legDriftCostUsd = notional.mul(driftRiskBps).div(10000);
    const riskAdjustedProfitUsd = input.expectedProfitUsd
      .mul(survivalProbability)
      .minus(notional.mul(adverseSelectionBps).div(10000))
      .minus(legDriftCostUsd);
    const fillProbability = clamp01(
      survivalProbability * 0.62 +
      liquidityScore * 0.2 +
      timing.freshnessScore * 0.18 -
      (input.executionStyle === "MAKER_ASSISTED" ? 0.12 : 0)
    );
    const bothLegsFillProbability = fillProbability * fillProbability;
    const legRiskProbability = 1 - bothLegsFillProbability;
    const unwindCostUsd = notional.mul(d("0.0015").plus(d(adverseSelectionBps).div(10000)));
    // Queue priority uses expected value, not raw spread: both legs must fill,
    // while a one-leg outcome pays an unwind penalty.
    const expectedValueUsd = riskAdjustedProfitUsd.mul(bothLegsFillProbability).minus(unwindCostUsd.mul(legRiskProbability));
    const suggestedSizeScale = Math.max(0.18, Math.min(1, 0.22 + survivalProbability * 0.62 + liquidityScore * 0.16 - volatilityBps / 120));
    const modelScore = Math.round(
      Math.max(
        0,
        Math.min(
          100,
          survivalProbability * 42 +
            alignment * 20 +
            liquidityScore * 16 +
            timing.freshnessScore * 12 +
            Math.max(0, Math.min(1, netEdgeBps / 8)) * 10
        )
      )
    );

    return {
      adverseSelectionBps,
      edgeQuality: modelScore >= 68 ? "EXPLOIT" : modelScore >= 45 ? "WATCH" : "AVOID",
      expectedValueUsd,
      fillProbability: bothLegsFillProbability,
      legRiskProbability,
      liquidityScore,
      micropriceSkewBps: sellSkew - buySkew,
      modelScore,
      orderFlowImbalance: sellOfi - buyOfi,
      quoteAgeMs: timing.ageMs,
      quoteFreshnessScore: timing.freshnessScore,
      quoteSkewMs: timing.skewMs,
      riskAdjustedProfitUsd,
      suggestedSizeScale,
      survivalProbability,
      volatilityBps
    };
  }

  recordOutcome(outcome: EdgeOutcome): void {
    const current = this.routeCalibration.get(outcome.route) ?? { bias: 0, brierScore: 0, observations: 0, wins: 0 };
    const realizedWin = outcome.realizedPnlUsd > 0 ? 1 : 0;
    const forecastError = realizedWin - clamp01(outcome.predictedSurvival);
    const weight = Math.max(0.05, Math.min(1, outcome.weight ?? 1));
    const nextBias = Math.max(-0.16, Math.min(0.16, current.bias * 0.92 + forecastError * 0.035 * weight));
    this.routeCalibration.set(outcome.route, {
      bias: nextBias,
      brierScore: current.observations
        ? current.brierScore * 0.92 + (realizedWin - clamp01(outcome.predictedSurvival)) ** 2 * 0.08
        : (realizedWin - clamp01(outcome.predictedSurvival)) ** 2,
      observations: current.observations + weight,
      wins: current.wins + (realizedWin ? weight : 0)
    });
  }

  exportCalibration(): Record<string, RouteCalibration> {
    return Object.fromEntries([...this.routeCalibration.entries()].map(([route, calibration]) => [route, { ...calibration }]));
  }

  importCalibration(calibration: Record<string, RouteCalibration>): void {
    Object.entries(calibration).forEach(([route, value]) => {
      if (!Number.isFinite(value.bias) || !Number.isFinite(value.observations)) return;
      this.routeCalibration.set(route, {
        bias: Math.max(-0.16, Math.min(0.16, value.bias)),
        brierScore: Number.isFinite(value.brierScore) ? Math.max(0, value.brierScore) : 0,
        observations: Math.max(0, value.observations),
        wins: Number.isFinite(value.wins) ? Math.max(0, value.wins) : 0
      });
    });
  }

  calibrationSummary(): { observations: number; brierScore: number } {
    const routes = [...this.routeCalibration.values()];
    const observations = routes.reduce((sum, route) => sum + route.observations, 0);
    const weightedBrier = routes.reduce((sum, route) => sum + route.brierScore * route.observations, 0);
    return {
      observations: Math.round(observations),
      brierScore: observations ? weightedBrier / observations : 0
    };
  }
}

export function serializeEdgeTensor(signal: EdgeTensorSignal) {
  return {
    adverseSelectionBps: signal.adverseSelectionBps.toFixed(3),
    edgeQuality: signal.edgeQuality,
    expectedValueUsd: usd(signal.expectedValueUsd),
    fillProbability: signal.fillProbability.toFixed(3),
    legRiskProbability: signal.legRiskProbability.toFixed(3),
    liquidityScore: signal.liquidityScore.toFixed(3),
    micropriceSkewBps: signal.micropriceSkewBps.toFixed(3),
    modelScore: signal.modelScore,
    orderFlowImbalance: signal.orderFlowImbalance.toFixed(3),
    quoteAgeMs: signal.quoteAgeMs,
    quoteFreshnessScore: signal.quoteFreshnessScore.toFixed(3),
    quoteSkewMs: signal.quoteSkewMs,
    riskAdjustedProfitUsd: usd(signal.riskAdjustedProfitUsd),
    suggestedSizeScale: signal.suggestedSizeScale.toFixed(3),
    survivalProbability: signal.survivalProbability.toFixed(3),
    volatilityBps: signal.volatilityBps.toFixed(3)
  };
}

function normalizedOrderFlowImbalance(previous: NormalizedOrderBook, current: NormalizedOrderBook): number {
  const prevBid = topBid(previous);
  const currBid = topBid(current);
  const prevAsk = topAsk(previous);
  const currAsk = topAsk(current);
  if (!prevBid || !currBid || !prevAsk || !currAsk) return 0;

  const bidContribution = currBid.price.greaterThan(prevBid.price)
    ? currBid.size
    : currBid.price.lessThan(prevBid.price)
      ? prevBid.size.negated()
      : currBid.size.minus(prevBid.size);
  const askContribution = currAsk.price.lessThan(prevAsk.price)
    ? currAsk.size.negated()
    : currAsk.price.greaterThan(prevAsk.price)
      ? prevAsk.size
      : prevAsk.size.minus(currAsk.size);
  const depth = currBid.size.plus(currAsk.size).plus(prevBid.size).plus(prevAsk.size);
  return depth.greaterThan(0) ? bidContribution.plus(askContribution).div(depth).toNumber() : 0;
}

function normalizedMultiLevelOfi(previous: NormalizedOrderBook, current: NormalizedOrderBook): number {
  let weightedFlow = d(0);
  let weightedDepth = d(0);
  for (let index = 0; index < 5; index += 1) {
    const weight = d(1).div(index + 1);
    const previousBid = previous.bids[index];
    const currentBid = current.bids[index];
    const previousAsk = previous.asks[index];
    const currentAsk = current.asks[index];
    if (!previousBid || !currentBid || !previousAsk || !currentAsk) continue;
    const bidDelta = d(currentBid.size).minus(previousBid.size);
    const askDelta = d(previousAsk.size).minus(currentAsk.size);
    weightedFlow = weightedFlow.plus(bidDelta.plus(askDelta).mul(weight));
    weightedDepth = weightedDepth.plus(d(currentBid.size).plus(currentAsk.size).mul(weight));
  }
  return weightedDepth.greaterThan(0) ? weightedFlow.div(weightedDepth).toNumber() : 0;
}

function bookImbalance(book: NormalizedOrderBook): number {
  const bidDepth = book.bids.slice(0, 5).reduce((sum, level) => sum.plus(level.size), d(0));
  const askDepth = book.asks.slice(0, 5).reduce((sum, level) => sum.plus(level.size), d(0));
  const total = bidDepth.plus(askDepth);
  return total.greaterThan(0) ? bidDepth.minus(askDepth).div(total).toNumber() : 0;
}

function microSkewBps(book: NormalizedOrderBook): number {
  const bid = topBid(book);
  const ask = topAsk(book);
  if (!bid || !ask) return 0;
  const total = bid.size.plus(ask.size);
  if (total.lessThanOrEqualTo(0)) return 0;
  const mid = bid.price.plus(ask.price).div(2);
  const microprice = bid.price.mul(ask.size).plus(ask.price.mul(bid.size)).div(total);
  return microprice.minus(mid).div(mid).mul(10000).toNumber();
}

function liquidityDepthScore(buyBook: NormalizedOrderBook, sellBook: NormalizedOrderBook, quantity: Decimal): number {
  const buyAskDepth = buyBook.asks.slice(0, 5).reduce((sum, level) => sum.plus(level.size), d(0));
  const sellBidDepth = sellBook.bids.slice(0, 5).reduce((sum, level) => sum.plus(level.size), d(0));
  const visibleDepth = Decimal.min(buyAskDepth, sellBidDepth);
  return Math.max(0, Math.min(1, visibleDepth.div(Decimal.max(quantity.mul(8), d("0.000001"))).toNumber()));
}

function notionalUsd(book: NormalizedOrderBook, quantity: Decimal): Decimal {
  const ask = topAsk(book);
  const fallback = midPrice(book);
  return (ask?.price ?? fallback ?? d(70000)).mul(quantity);
}

function quoteTiming(buyBook: NormalizedOrderBook, sellBook: NormalizedOrderBook): { ageMs: number; freshnessScore: number; skewMs: number } {
  const now = Date.now();
  const ageMs = Math.max(0, now - Math.min(buyBook.receivedAt, sellBook.receivedAt));
  const skewMs = Math.abs(buyBook.receivedAt - sellBook.receivedAt);
  const quoteAgeHardLimit = 2200;
  const ageScore = ageMs > quoteAgeHardLimit ? 0.01 : clamp01(1 - ageMs / 2800);
  const synchronizationScore = clamp01(1 - skewMs / 1800);
  return {
    ageMs,
    freshnessScore: ageScore * 0.58 + synchronizationScore * 0.42,
    skewMs
  };
}

function ewma(previous: number, value: number, alpha: number): number {
  return previous === 0 ? value : previous * (1 - alpha) + value * alpha;
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function stateKey(exchange: ExchangeId): string {
  return `${exchange}:BTC/USDT`;
}
