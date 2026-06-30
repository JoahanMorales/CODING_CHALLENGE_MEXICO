import { EXCHANGE_FEES } from "../config/exchanges";
import { Decimal, d, ZERO } from "../math/decimal";
import type { ExchangeId, NormalizedOrderBook, OrderBookLevel, QuoteAsset } from "../types";

export interface NetProfitInput {
  buyExchange: ExchangeId;
  sellExchange: ExchangeId;
  askPrice: Decimal;
  bidPrice: Decimal;
  quantityBtc: Decimal;
  availableAskQty: Decimal;
  availableBidQty: Decimal;
  includeWithdrawal: boolean;
  withdrawalAmortization?: Decimal;
  buyLiquidityRole?: "maker" | "taker";
  sellLiquidityRole?: "maker" | "taker";
  buyQuoteAsset?: QuoteAsset;
  sellQuoteAsset?: QuoteAsset;
  buyQuoteToUsdRate?: Decimal;
  sellQuoteToUsdRate?: Decimal;
  askLevels?: OrderBookLevel[];
  bidLevels?: OrderBookLevel[];
}

export interface NetProfitResult {
  grossProfitUsd: Decimal;
  buyFeeUsd: Decimal;
  sellFeeUsd: Decimal;
  slippageUsd: Decimal;
  networkCostUsd: Decimal;
  quoteConversionCostUsd: Decimal;
  rebalanceCostUsd: Decimal;
  rebalanceAdjustedProfitUsd: Decimal;
  netProfitUsd: Decimal;
  grossSpreadPct: Decimal;
  netSpreadPct: Decimal;
  impactRatio: Decimal;
  highImpact: boolean;
}

export function topBid(book: NormalizedOrderBook): { price: Decimal; size: Decimal } | null {
  const level = book.bids[0];
  return level ? { price: d(level.price), size: d(level.size) } : null;
}

export function topAsk(book: NormalizedOrderBook): { price: Decimal; size: Decimal } | null {
  const level = book.asks[0];
  return level ? { price: d(level.price), size: d(level.size) } : null;
}

export function midPrice(book: NormalizedOrderBook): Decimal | null {
  const bid = topBid(book);
  const ask = topAsk(book);
  if (!bid || !ask) return null;
  return bid.price.plus(ask.price).div(2);
}

// Square-root law of market impact. Empirically the price impact of an order
// scales with the SQUARE ROOT of participation (order size / available
// liquidity), not linearly — a near-universal result validated on equities,
// futures, options and, specifically, Bitcoin (Donier & Bonart 2015, exponent
// ~0.5; Toth et al. 2011; Almgren et al. 2005). A linear model materially
// underestimates the cost of consuming depth, so we model:
//   impactRate = baseHalfSpread + IMPACT_COEF * sqrt(participation)
// bounded by a floor (touch cost) and a cap (extreme participation, where the
// pure square-root law itself breaks down).
const SLIPPAGE_BASE_RATE = d("0.0001");
const SLIPPAGE_IMPACT_COEF = d("0.0011");
const SLIPPAGE_MAX_RATE = d("0.006");

export function estimateSlippageRate(quantityBtc: Decimal, availableDepthBtc: Decimal): Decimal {
  if (availableDepthBtc.lessThanOrEqualTo(0)) return SLIPPAGE_MAX_RATE;
  const participation = Decimal.min(1, quantityBtc.div(availableDepthBtc));
  const impact = SLIPPAGE_BASE_RATE.plus(SLIPPAGE_IMPACT_COEF.mul(participation.sqrt()));
  return Decimal.min(SLIPPAGE_MAX_RATE, impact);
}

export function simulateVwap(levels: OrderBookLevel[], quantity: Decimal): { price: Decimal; filledQty: Decimal } {
  let remaining = quantity;
  let notional = ZERO;
  let filled = ZERO;
  for (const level of levels) {
    if (remaining.lessThanOrEqualTo(0)) break;
    const levelSize = d(level.size);
    const fill = Decimal.min(remaining, levelSize);
    notional = notional.plus(fill.mul(d(level.price)));
    filled = filled.plus(fill);
    remaining = remaining.minus(fill);
  }
  if (filled.lessThanOrEqualTo(0)) return { price: d(levels[0]?.price ?? "0"), filledQty: ZERO };
  return { price: notional.div(filled), filledQty: filled };
}

export function computeVwapAdjustedPrices(
  buyBook: NormalizedOrderBook,
  sellBook: NormalizedOrderBook,
  quantity: Decimal
): { vwapAskPrice: Decimal; vwapBidPrice: Decimal; vwapAskFilled: Decimal; vwapBidFilled: Decimal } {
  const askVwap = simulateVwap(buyBook.asks, quantity);
  const bidVwap = simulateVwap(sellBook.bids, quantity);
  return {
    vwapAskPrice: askVwap.price,
    vwapBidPrice: bidVwap.price,
    vwapAskFilled: askVwap.filledQty,
    vwapBidFilled: bidVwap.filledQty
  };
}

export function calculateNetProfit(input: NetProfitInput): NetProfitResult {
  const effectiveAskPrice = input.askLevels ? simulateVwap(input.askLevels, input.quantityBtc).price : input.askPrice;
  const effectiveBidPrice = input.bidLevels ? simulateVwap(input.bidLevels, input.quantityBtc).price : input.bidPrice;
  const buyNotional = effectiveAskPrice.mul(input.quantityBtc);
  const sellNotional = effectiveBidPrice.mul(input.quantityBtc);
  const grossProfitUsd = sellNotional.minus(buyNotional);
  const buyFeeUsd = buyNotional.mul(EXCHANGE_FEES[input.buyExchange][input.buyLiquidityRole ?? "taker"]);
  const sellFeeUsd = sellNotional.mul(EXCHANGE_FEES[input.sellExchange][input.sellLiquidityRole ?? "taker"]);
  const visibleDepth = Decimal.min(input.availableAskQty, input.availableBidQty);
  const slippageRate = estimateSlippageRate(input.quantityBtc, visibleDepth);
  const slippageUsd = buyNotional.plus(sellNotional).mul(slippageRate);
  const buyQuoteAsset = input.buyQuoteAsset ?? "USDT";
  const sellQuoteAsset = input.sellQuoteAsset ?? "USDT";
  const buyQuoteToUsdRate = input.buyQuoteToUsdRate ?? d(1);
  const sellQuoteToUsdRate = input.sellQuoteToUsdRate ?? d(1);
  const quoteConversionRate = buyQuoteAsset === sellQuoteAsset
    ? ZERO
    : buyQuoteToUsdRate.minus(sellQuoteToUsdRate).abs().plus("0.0001");
  const quoteConversionCostUsd = buyNotional.plus(sellNotional).div(2).mul(quoteConversionRate);
  const withdrawalBtc = input.includeWithdrawal
    ? d(EXCHANGE_FEES[input.buyExchange].withdrawalBtc).mul(input.withdrawalAmortization ?? 1)
    : ZERO;
  const rebalanceCostUsd = withdrawalBtc.mul(effectiveAskPrice);
  const networkCostUsd = ZERO;
  const netProfitUsd = grossProfitUsd.minus(buyFeeUsd).minus(sellFeeUsd).minus(slippageUsd).minus(quoteConversionCostUsd);
  const rebalanceAdjustedProfitUsd = netProfitUsd.minus(rebalanceCostUsd);
  const grossSpreadPct = effectiveBidPrice.minus(effectiveAskPrice).div(effectiveAskPrice);
  const netSpreadPct = buyNotional.greaterThan(0) ? netProfitUsd.div(buyNotional) : ZERO;
  const impactRatio = visibleDepth.greaterThan(0) ? input.quantityBtc.div(visibleDepth) : d(1);

  return {
    grossProfitUsd,
    buyFeeUsd,
    sellFeeUsd,
    slippageUsd,
    networkCostUsd,
    quoteConversionCostUsd,
    rebalanceCostUsd,
    rebalanceAdjustedProfitUsd,
    netProfitUsd,
    grossSpreadPct,
    netSpreadPct,
    impactRatio,
    highImpact: impactRatio.greaterThan("0.2")
  };
}
