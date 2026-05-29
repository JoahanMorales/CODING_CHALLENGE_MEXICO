import { Decimal, d, usd } from "../math/decimal";
import type { ExchangeId, ExecutionStyle, NormalizedOrderBook } from "../types";
import { midPrice, topAsk, topBid } from "./feeMath";

interface VenueState {
  ewmaOfi: number;
  ewmaVolatilityBps: number;
  lastBook?: NormalizedOrderBook;
  lastMid?: Decimal;
}

export interface EdgeTensorInput {
  buyBook: NormalizedOrderBook;
  sellBook: NormalizedOrderBook;
  executionStyle: ExecutionStyle;
  expectedProfitUsd: Decimal;
  netSpreadPct: Decimal;
  quantityBtc: Decimal;
}

export interface EdgeTensorSignal {
  adverseSelectionBps: number;
  edgeQuality: "EXPLOIT" | "WATCH" | "AVOID";
  liquidityScore: number;
  micropriceSkewBps: number;
  modelScore: number;
  orderFlowImbalance: number;
  riskAdjustedProfitUsd: Decimal;
  suggestedSizeScale: number;
  survivalProbability: number;
  volatilityBps: number;
}

export class EdgeTensor {
  private readonly venueStates = new Map<string, VenueState>();

  ingest(book: NormalizedOrderBook): void {
    if (book.symbol !== "BTC/USDT") return;
    const key = stateKey(book.exchange);
    const state = this.venueStates.get(key) ?? {
      ewmaOfi: 0,
      ewmaVolatilityBps: 0
    };
    const previous = state.lastBook;
    const mid = midPrice(book);

    if (previous) {
      const ofi = normalizedOrderFlowImbalance(previous, book);
      state.ewmaOfi = ewma(state.ewmaOfi, ofi, 0.22);
    }

    if (mid && state.lastMid && state.lastMid.greaterThan(0)) {
      const returnBps = mid.minus(state.lastMid).div(state.lastMid).mul(10000).abs().toNumber();
      state.ewmaVolatilityBps = ewma(state.ewmaVolatilityBps, returnBps, 0.12);
    }

    state.lastBook = book;
    state.lastMid = mid ?? state.lastMid;
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
    const volatilityBps = ((buyState?.ewmaVolatilityBps ?? 0) + (sellState?.ewmaVolatilityBps ?? 0)) / 2;
    const netEdgeBps = input.netSpreadPct.mul(10000).toNumber();
    const liquidityScore = liquidityDepthScore(input.buyBook, input.sellBook, input.quantityBtc);

    // Cross-venue arbitrage survives better when the buy venue shows sell pressure
    // and the sell venue shows buy pressure. OFI reacts faster than mid-price.
    const pressureAlignment = sigmoid((-buyOfi + sellOfi) * 1.35);
    const micropriceAlignment = sigmoid((-buySkew + sellSkew) / 3.2);
    const depthAlignment = sigmoid((-buyImbalance + sellImbalance) * 1.15);
    const alignment = pressureAlignment * 0.48 + micropriceAlignment * 0.34 + depthAlignment * 0.18;
    const styleBoost = input.executionStyle === "MAKER_ASSISTED" ? 0.08 : input.executionStyle === "STAT_MEAN_REVERSION" ? 0.05 : 0;
    const edgeStrength = sigmoid(netEdgeBps * 0.72);
    const volatilityPenalty = sigmoid((volatilityBps - 1.8) * 0.9);
    const survivalProbability = clamp01(
      0.12 +
        edgeStrength * 0.34 +
        alignment * 0.32 +
        liquidityScore * 0.16 +
        styleBoost -
        volatilityPenalty * 0.18
    );
    const adverseSelectionBps = Math.max(0, volatilityBps * 0.34 + (1 - alignment) * 2.4 - Math.max(0, netEdgeBps) * 0.16);
    const notional = notionalUsd(input.buyBook, input.quantityBtc);
    const riskAdjustedProfitUsd = input.expectedProfitUsd
      .mul(survivalProbability)
      .minus(notional.mul(adverseSelectionBps).div(10000));
    const suggestedSizeScale = Math.max(0.18, Math.min(1, 0.22 + survivalProbability * 0.62 + liquidityScore * 0.16 - volatilityBps / 120));
    const modelScore = Math.round(
      Math.max(
        0,
        Math.min(
          100,
          survivalProbability * 42 +
            alignment * 24 +
            liquidityScore * 18 +
            Math.max(0, Math.min(1, netEdgeBps / 8)) * 16
        )
      )
    );

    return {
      adverseSelectionBps,
      edgeQuality: modelScore >= 68 ? "EXPLOIT" : modelScore >= 45 ? "WATCH" : "AVOID",
      liquidityScore,
      micropriceSkewBps: sellSkew - buySkew,
      modelScore,
      orderFlowImbalance: sellOfi - buyOfi,
      riskAdjustedProfitUsd,
      suggestedSizeScale,
      survivalProbability,
      volatilityBps
    };
  }
}

export function serializeEdgeTensor(signal: EdgeTensorSignal) {
  return {
    adverseSelectionBps: signal.adverseSelectionBps.toFixed(3),
    edgeQuality: signal.edgeQuality,
    liquidityScore: signal.liquidityScore.toFixed(3),
    micropriceSkewBps: signal.micropriceSkewBps.toFixed(3),
    modelScore: signal.modelScore,
    orderFlowImbalance: signal.orderFlowImbalance.toFixed(3),
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
