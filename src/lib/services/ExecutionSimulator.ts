import { EXCHANGE_FEES, INITIAL_WALLETS } from "../config/exchanges";
import { Decimal, d, usd, ZERO } from "../math/decimal";
import type { ExchangeId, Opportunity, Trade, WalletBalance, WalletSeed } from "../types";

interface WalletInternal {
  exchange: ExchangeId;
  btc: Decimal;
  usdt: Decimal;
}

export class ExecutionSimulator {
  private readonly wallets = new Map<ExchangeId, WalletInternal>();
  private seed: WalletSeed;

  constructor(seed: WalletSeed = INITIAL_WALLETS) {
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
    const latencyMs = opportunity.executionStyle === "MAKER_ASSISTED"
      ? 120 + Math.floor(Math.random() * 231)
      : 50 + Math.floor(Math.random() * 151);
    await new Promise((resolve) => windowOrNodeSetTimeout(resolve, latencyMs));

    if (opportunity.type === "CROSS_EXCHANGE" && opportunity.buyExchange && opportunity.sellExchange) {
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
    const expectedPnl = d(opportunity.expectedProfitUsd);
    const fees = d(opportunity.totalFeesUsd);
    const estimatedPrice = size.greaterThan(0) ? d(opportunity.grossProfitUsd).div(size).abs().plus("70000") : d("70000");
    const buyCost = estimatedPrice.mul(size).mul(d(1).plus(EXCHANGE_FEES[buyExchange].taker));
    const sellCredit = estimatedPrice.mul(size).mul(d(1).minus(EXCHANGE_FEES[sellExchange].taker)).plus(expectedPnl);

    if (buyWallet.usdt.lessThan(buyCost) || sellWallet.btc.lessThan(size)) {
      return this.rejectedTrade(opportunity, latencyMs, "0");
    }

    const styleFillRatio = opportunity.executionStyle === "MAKER_ASSISTED"
      ? Decimal.min(1, d("0.55").plus(d(opportunity.confidence).div(220)))
      : d(1);
    const fillRatio = opportunity.highImpact ? Decimal.min(styleFillRatio, d("0.8")) : styleFillRatio;
    const filledSize = size.mul(fillRatio);
    const notional = estimatedPrice.mul(filledSize);
    const adverseLatencyCost = notional.mul(realizedLatencyShockRate(latencyMs, opportunity.highImpact, opportunity.executionStyle));
    const realizedPnl = expectedPnl.mul(fillRatio).minus(adverseLatencyCost);
    buyWallet.usdt = buyWallet.usdt.minus(buyCost.mul(fillRatio));
    buyWallet.btc = buyWallet.btc.plus(filledSize);
    sellWallet.btc = sellWallet.btc.minus(filledSize);
    sellWallet.usdt = sellWallet.usdt.plus(sellCredit.mul(fillRatio)).minus(adverseLatencyCost);

    return {
      id: cryptoId("trade"),
      opportunityId: opportunity.id,
      type: opportunity.type,
      route: opportunity.route,
      executedAt: Date.now(),
      latencyMs,
      sizeBtc: filledSize.toFixed(8),
      pnlUsd: usd(realizedPnl),
      feesUsd: usd(fees.mul(fillRatio)),
      fillRatio: fillRatio.toNumber(),
      status: fillRatio.lessThan(1) ? "PARTIAL" : "FILLED",
      highImpact: opportunity.highImpact
    };
  }

  private executeSynthetic(opportunity: Opportunity, latencyMs: number): Trade {
    const fillRatio = opportunity.highImpact ? d("0.75") : d(1);
    const notional = d(opportunity.tradeSizeBtc).mul(fillRatio).mul("70000");
    const realizedPnl = d(opportunity.expectedProfitUsd)
      .mul(fillRatio)
      .minus(notional.mul(realizedLatencyShockRate(latencyMs, opportunity.highImpact, opportunity.executionStyle)));
    return {
      id: cryptoId("trade"),
      opportunityId: opportunity.id,
      type: opportunity.type,
      route: opportunity.route,
      executedAt: Date.now(),
      latencyMs,
      sizeBtc: d(opportunity.tradeSizeBtc).mul(fillRatio).toFixed(8),
      pnlUsd: usd(realizedPnl),
      feesUsd: usd(d(opportunity.totalFeesUsd).mul(fillRatio)),
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
      feesUsd: "0.00",
      fillRatio: 0,
      status: "REJECTED",
      highImpact: opportunity.highImpact
    };
  }
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

function gaussianRandom(): number {
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
