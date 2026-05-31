import { EXCHANGE_FEES } from "../config/exchanges";
import { Decimal, d, ZERO } from "../math/decimal";
import type { ExchangeId, NormalizedOrderBook, QuoteAsset } from "../types";

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

export function estimateSlippageRate(quantityBtc: Decimal, availableDepthBtc: Decimal): Decimal {
  if (availableDepthBtc.lessThanOrEqualTo(0)) return d("0.0005");
  const utilization = quantityBtc.div(availableDepthBtc);
  // Slippage is bounded to 0.02%-0.05%, increasing as we consume more visible depth.
  return Decimal.min(d("0.0005"), d("0.0002").plus(utilization.mul("0.0003")));
}

export function calculateNetProfit(input: NetProfitInput): NetProfitResult {
  const buyNotional = input.askPrice.mul(input.quantityBtc);
  const sellNotional = input.bidPrice.mul(input.quantityBtc);
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
  const rebalanceCostUsd = withdrawalBtc.mul(input.askPrice);
  const networkCostUsd = ZERO;
  const netProfitUsd = grossProfitUsd.minus(buyFeeUsd).minus(sellFeeUsd).minus(slippageUsd).minus(quoteConversionCostUsd);
  const rebalanceAdjustedProfitUsd = netProfitUsd.minus(rebalanceCostUsd);
  const grossSpreadPct = input.bidPrice.minus(input.askPrice).div(input.askPrice);
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
