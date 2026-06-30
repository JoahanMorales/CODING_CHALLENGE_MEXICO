import { EXCHANGE_FEES, INITIAL_WALLETS } from "../config/exchanges";
import { Decimal, d, usd, ZERO } from "../math/decimal";
import type { ExchangeId, ExecutionPlan, Opportunity, OrderBookLevel, Trade, WalletBalance, WalletSeed } from "../types";

interface WalletInternal {
  exchange: ExchangeId;
  btc: Decimal;
  usdt: Decimal;
}

export class ExecutionSimulator {
  private readonly wallets = new Map<ExchangeId, WalletInternal>();
  private seed: WalletSeed;

  constructor(
    seed: WalletSeed = INITIAL_WALLETS,
    private readonly latencyMultiplier: () => number = () => 1
  ) {
    this.seed = seed;
    this.reset();
  }

  reset(seed = this.seed): void {
    this.seed = seed;
    this.wallets.clear();
    (Object.keys(seed) as ExchangeId[]).forEach((exchange) => {
      const wallet = seed[exchange];
      this.wallets.set(exchange, {
        exchange,
        btc: d(wallet.btc),
        usdt: d(wallet.usdt)
      });
    });
  }

  async execute(opportunity: Opportunity): Promise<Trade> {
    const baseLatencyMs = opportunity.executionStyle === "MAKER_ASSISTED"
      ? 120 + Math.floor(Math.random() * 231)
      : 50 + Math.floor(Math.random() * 151);
    const latencyMs = Math.round(baseLatencyMs * this.latencyMultiplier());
    await new Promise((resolve) => windowOrNodeSetTimeout(resolve, latencyMs));

    if (isTwoVenue(opportunity) && opportunity.buyExchange && opportunity.sellExchange) {
      return this.executeCrossExchange(opportunity, latencyMs);
    }

    return this.executeSynthetic(opportunity, latencyMs);
  }

  balances(): WalletBalance[] {
    return [...this.wallets.values()].map((wallet) => {
      const rebalancingNeeded = wallet.btc.lessThan("0.1") || wallet.usdt.lessThan("5000");
      const btcTopUpCost = wallet.btc.lessThan("0.1") ? d("0.1").minus(wallet.btc).mul("70000").mul("0.001") : ZERO;
      const usdtTopUpCost = wallet.usdt.lessThan("5000") ? d("5000").minus(wallet.usdt).mul("0.001") : ZERO;
      return {
        exchange: wallet.exchange,
        btc: wallet.btc.toFixed(8),
        usdt: usd(wallet.usdt),
        rebalancingNeeded,
        rebalancingCostUsd: usd(btcTopUpCost.plus(usdtTopUpCost))
      };
    });
  }

  exposureBtc(): Decimal {
    return [...this.wallets.values()].reduce((sum, wallet) => sum.plus(wallet.btc), ZERO);
  }

  preflight(opportunity: Opportunity): { ok: boolean; reason: string } {
    if (!isTwoVenue(opportunity)) {
      return { ok: true, reason: "Synthetic strategy inventory model is available." };
    }
    const buyExchange = opportunity.buyExchange;
    const sellExchange = opportunity.sellExchange;
    if (!buyExchange || !sellExchange) return { ok: false, reason: "Execution route is incomplete." };
    const buyWallet = this.wallets.get(buyExchange);
    const sellWallet = this.wallets.get(sellExchange);
    if (!buyWallet || !sellWallet) return { ok: false, reason: "Paper wallet is missing for one execution leg." };
    const filledSize = d(opportunity.tradeSizeBtc).mul(fillRatioFor(opportunity));
    if (filledSize.lessThanOrEqualTo(0)) return { ok: false, reason: "Expected fill quantity is zero." };
    const execution = depthAwareQuote(opportunity.executionPlan, filledSize);
    const buyFeeRate = EXCHANGE_FEES[buyExchange][opportunity.executionPlan?.buyLiquidityRole ?? "taker"];
    const buyCost = execution.buyNotional.plus(execution.buyNotional.mul(buyFeeRate));
    if (buyWallet.usdt.lessThan(buyCost)) {
      return { ok: false, reason: `${buyExchange} requires ${usd(buyCost)} USDT but has ${usd(buyWallet.usdt)}.` };
    }
    if (sellWallet.btc.lessThan(filledSize)) {
      return { ok: false, reason: `${sellExchange} requires ${filledSize.toFixed(8)} BTC but has ${sellWallet.btc.toFixed(8)}.` };
    }
    return { ok: true, reason: "Both paper legs have sufficient prefunded inventory." };
  }

  private executeCrossExchange(opportunity: Opportunity, latencyMs: number): Trade {
    const buyExchange = opportunity.buyExchange;
    const sellExchange = opportunity.sellExchange;
    if (!buyExchange || !sellExchange) {
      return this.rejectedTrade(opportunity, latencyMs, "0");
    }
    const buyWallet = this.wallets.get(buyExchange);
    const sellWallet = this.wallets.get(sellExchange);
    if (!buyWallet || !sellWallet) {
      return this.rejectedTrade(opportunity, latencyMs, "0");
    }

    const size = d(opportunity.tradeSizeBtc);
    const fillRatio = fillRatioFor(opportunity);
    const filledSize = size.mul(fillRatio);
    const execution = depthAwareQuote(opportunity.executionPlan, filledSize);
    const buyFeeRate = EXCHANGE_FEES[buyExchange][opportunity.executionPlan?.buyLiquidityRole ?? "taker"];
    const sellFeeRate = EXCHANGE_FEES[sellExchange][opportunity.executionPlan?.sellLiquidityRole ?? "taker"];
    const buyFee = execution.buyNotional.mul(buyFeeRate);
    const sellFee = execution.sellNotional.mul(sellFeeRate);
    const buyCost = execution.buyNotional.plus(buyFee);
    const sellCredit = execution.sellNotional.minus(sellFee);

    if (buyWallet.usdt.lessThan(buyCost) || sellWallet.btc.lessThan(filledSize)) {
      return this.rejectedTrade(opportunity, latencyMs, "0");
    }

    const notional = execution.buyNotional.plus(execution.sellNotional).div(2);
    const adverseLatencyCost = notional.mul(realizedLatencyShockRate(latencyMs, opportunity.highImpact, opportunity.executionStyle));
    const survivalDecayCost = realizedSurvivalDecayCost(notional, opportunity);
    const slippageCost = d(opportunity.slippageUsd).mul(fillRatio);
    const quoteConversionCost = d(opportunity.quoteConversionCostUsd).mul(fillRatio);
    const rebalanceCost = d(opportunity.rebalanceCostUsd).mul(fillRatio);
    const executionRiskCost = d(opportunity.networkCostUsd).mul(fillRatio).plus(adverseLatencyCost).plus(survivalDecayCost);
    const modeledCosts = slippageCost.plus(quoteConversionCost).plus(executionRiskCost);
    const grossPnl = execution.sellNotional.minus(execution.buyNotional);
    const fees = buyFee.plus(sellFee);
    const realizedPnl = grossPnl.minus(fees).minus(modeledCosts);
    const rebalanceAdjustedPnl = realizedPnl.minus(rebalanceCost);
    buyWallet.usdt = buyWallet.usdt.minus(buyCost);
    buyWallet.btc = buyWallet.btc.plus(filledSize);
    sellWallet.btc = sellWallet.btc.minus(filledSize);
    sellWallet.usdt = sellWallet.usdt.plus(sellCredit).minus(modeledCosts);

    return {
      id: cryptoId("trade"),
      opportunityId: opportunity.id,
      type: opportunity.type,
      route: opportunity.route,
      executedAt: Date.now(),
      latencyMs,
      sizeBtc: filledSize.toFixed(8),
      pnlUsd: usd(realizedPnl),
      rebalanceAdjustedPnlUsd: usd(rebalanceAdjustedPnl),
      grossPnlUsd: usd(grossPnl),
      feesUsd: usd(fees),
      slippageUsd: usd(slippageCost),
      executionRiskUsd: usd(executionRiskCost),
      quoteConversionCostUsd: usd(quoteConversionCost),
      rebalanceCostUsd: usd(rebalanceCost),
      fillRatio: fillRatio.toNumber(),
      status: fillRatio.lessThan(1) ? "PARTIAL" : "FILLED",
      highImpact: opportunity.highImpact
    };
  }

  private executeSynthetic(opportunity: Opportunity, latencyMs: number): Trade {
    const fillRatio = opportunity.highImpact ? d("0.75") : d(1);
    const notional = d(opportunity.tradeSizeBtc).mul(fillRatio).mul("70000");
    const survivalDecayCost = realizedSurvivalDecayCost(notional, opportunity);
    const slippageCost = d(opportunity.slippageUsd).mul(fillRatio);
    const quoteConversionCost = d(opportunity.quoteConversionCostUsd).mul(fillRatio);
    const rebalanceCost = d(opportunity.rebalanceCostUsd).mul(fillRatio);
    const adverseLatencyCost = notional.mul(
      realizedLatencyShockRate(latencyMs, opportunity.highImpact, opportunity.executionStyle)
    );
    const executionRiskCost = d(opportunity.networkCostUsd).mul(fillRatio).plus(adverseLatencyCost).plus(survivalDecayCost);
    const fees = d(opportunity.totalFeesUsd).mul(fillRatio);
    const realizedPnl = d(opportunity.expectedProfitUsd)
      .mul(fillRatio)
      .minus(adverseLatencyCost)
      .minus(survivalDecayCost);
    const grossPnl = realizedPnl.plus(fees).plus(slippageCost).plus(quoteConversionCost).plus(executionRiskCost);
    const rebalanceAdjustedPnl = realizedPnl.minus(rebalanceCost);
    return {
      id: cryptoId("trade"),
      opportunityId: opportunity.id,
      type: opportunity.type,
      route: opportunity.route,
      executedAt: Date.now(),
      latencyMs,
      sizeBtc: d(opportunity.tradeSizeBtc).mul(fillRatio).toFixed(8),
      pnlUsd: usd(realizedPnl),
      rebalanceAdjustedPnlUsd: usd(rebalanceAdjustedPnl),
      grossPnlUsd: usd(grossPnl),
      feesUsd: usd(fees),
      slippageUsd: usd(slippageCost),
      executionRiskUsd: usd(executionRiskCost),
      quoteConversionCostUsd: usd(quoteConversionCost),
      rebalanceCostUsd: usd(rebalanceCost),
      fillRatio: fillRatio.toNumber(),
      status: fillRatio.lessThan(1) ? "PARTIAL" : "FILLED",
      highImpact: opportunity.highImpact
    };
  }

  private rejectedTrade(opportunity: Opportunity, latencyMs: number, sizeBtc: string): Trade {
    return {
      id: cryptoId("trade"),
      opportunityId: opportunity.id,
      type: opportunity.type,
      route: opportunity.route,
      executedAt: Date.now(),
      latencyMs,
      sizeBtc,
      pnlUsd: "0.00",
      rebalanceAdjustedPnlUsd: "0.00",
      grossPnlUsd: "0.00",
      feesUsd: "0.00",
      slippageUsd: "0.00",
      executionRiskUsd: "0.00",
      quoteConversionCostUsd: "0.00",
      rebalanceCostUsd: "0.00",
      fillRatio: 0,
      status: "REJECTED",
      highImpact: opportunity.highImpact
    };
  }
}

// Strategies that fill across two real venue wallets (buy leg + sell leg) and
// therefore use the depth-aware, inventory-checked execution path.
function isTwoVenue(opportunity: Opportunity): boolean {
  return opportunity.type === "CROSS_EXCHANGE" || opportunity.type === "LATENCY_ARB";
}

function fillRatioFor(opportunity: Opportunity): Decimal {
  const styleFillRatio = opportunity.executionStyle === "MAKER_ASSISTED"
    ? Decimal.min(1, d("0.55").plus(d(opportunity.confidence).div(220)))
    : d(1);
  return opportunity.highImpact ? Decimal.min(styleFillRatio, d("0.8")) : styleFillRatio;
}

function depthAwareQuote(plan: ExecutionPlan | undefined, quantity: Decimal): { buyNotional: Decimal; sellNotional: Decimal } {
  if (!plan || quantity.lessThanOrEqualTo(0)) {
    const fallback = d("70000").mul(quantity);
    return { buyNotional: fallback, sellNotional: fallback };
  }

  if (plan.buyLiquidityRole === "maker" || plan.sellLiquidityRole === "maker") {
    return {
      buyNotional: d(plan.referenceBuyPrice).mul(quantity),
      sellNotional: d(plan.referenceSellPrice).mul(quantity)
    };
  }

  return {
    buyNotional: walkBook(plan.buyLevels, quantity),
    sellNotional: walkBook(plan.sellLevels, quantity)
  };
}

function walkBook(levels: OrderBookLevel[], quantity: Decimal): Decimal {
  let remaining = quantity;
  let notional = ZERO;
  for (const level of levels) {
    if (remaining.lessThanOrEqualTo(0)) break;
    const levelSize = d(level.size);
    const fill = Decimal.min(remaining, levelSize);
    notional = notional.plus(fill.mul(level.price));
    remaining = remaining.minus(fill);
  }

  if (remaining.greaterThan(0)) {
    const lastPrice = levels.at(-1)?.price ?? "70000";
    notional = notional.plus(remaining.mul(lastPrice));
  }

  return notional;
}

function windowOrNodeSetTimeout(resolve: (value: unknown) => void, latencyMs: number): void {
  setTimeout(resolve, latencyMs);
}

function cryptoId(prefix: string): string {
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${randomPart}`;
}

function realizedLatencyShockRate(latencyMs: number, highImpact: boolean, style: Opportunity["executionStyle"]): Decimal {
  if (style === "STAT_MEAN_REVERSION") {
    const latencyComponent = Math.min(0.000025, latencyMs / 1000 * 0.00006);
    const randomComponent = gaussianRandom() * 0.00008;
    return d(Math.max(-0.00006, 0.000012 + latencyComponent + randomComponent).toFixed(8));
  }

  if (style === "MAKER_ASSISTED") {
    const latencyComponent = Math.min(0.00008, latencyMs / 1000 * 0.00016);
    const randomComponent = gaussianRandom() * 0.00012;
    return d(Math.max(-0.00008, 0.000045 + latencyComponent + randomComponent).toFixed(8));
  }

  const base = highImpact ? 0.00018 : 0.00008;
  const latencyComponent = Math.min(0.00016, latencyMs / 1000 * 0.00035);
  const randomComponent = gaussianRandom() * 0.00016;
  return d(Math.max(-0.00008, base + latencyComponent + randomComponent).toFixed(8));
}

function realizedSurvivalDecayCost(notional: Decimal, opportunity: Opportunity): Decimal {
  const survivalProbability = Math.max(
    0.05,
    Math.min(0.98, Number(opportunity.edgeModel?.survivalProbability ?? opportunity.confidence / 100))
  );
  const failedToSurvive = Math.random() > survivalProbability;
  if (failedToSurvive) {
    const stylePenalty =
      opportunity.executionStyle === "MAKER_ASSISTED"
        ? 0.00024
        : opportunity.executionStyle === "STAT_MEAN_REVERSION"
          ? 0.00018
          : 0.00016;
    const impactPenalty = opportunity.highImpact ? 0.00016 : 0;
    return notional.mul(d((stylePenalty + impactPenalty + Math.random() * 0.00026).toFixed(8)));
  }

  // Even successful paper fills carry small symmetric markout noise. Negative
  // values model favorable short-horizon movement after both legs complete.
  return notional.mul(d((gaussianRandom() * 0.00007).toFixed(8)));
}

function gaussianRandom(): number {
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
