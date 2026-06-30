import { d, Decimal, usd, ZERO } from "../math/decimal";
import type { CounterfactualOutcome, LearningSummary, NormalizedOrderBook, Opportunity } from "../types";
import { calculateNetProfit, topAsk, topBid } from "./feeMath";

interface PendingSignal {
  dueAt: number;
  horizonMs: number;
  opportunity: Opportunity;
}

export class CounterfactualLearner {
  private readonly books = new Map<string, NormalizedOrderBook>();
  private readonly pending: PendingSignal[] = [];
  private readonly outcomes: CounterfactualOutcome[] = [];
  private readonly lastTrackedAt = new Map<string, number>();

  // Rejected signals below this score are pure noise (a cross-exchange route
  // already earns ~40 points from venue reliability + liquidity alone, so 30 is
  // a low bar). Tracking the rest is what makes Shadow Learning able to surface
  // missed profits and avoided losses on signals the engine declined.
  private static readonly REJECTED_TRACKING_MIN_SCORE = 30;

  track(opportunity: Opportunity): void {
    if (opportunity.type !== "CROSS_EXCHANGE" || !opportunity.buyExchange || !opportunity.sellExchange) return;
    if (opportunity.status === "REJECTED" && opportunity.score < CounterfactualLearner.REJECTED_TRACKING_MIN_SCORE) return;
    const sampleKey = `${opportunity.route}:${opportunity.status}`;
    const lastTrackedAt = this.lastTrackedAt.get(sampleKey) ?? 0;
    if (Date.now() - lastTrackedAt < (opportunity.status === "REJECTED" ? 1800 : 450)) return;
    this.lastTrackedAt.set(sampleKey, Date.now());
    const horizons = [100, 500, 2000];
    horizons.forEach((horizonMs) => {
      this.pending.push({
        dueAt: opportunity.createdAt + horizonMs,
        horizonMs,
        opportunity
      });
    });
    this.pending.splice(0, Math.max(0, this.pending.length - 1500));
  }

  observeBook(book: NormalizedOrderBook): CounterfactualOutcome[] {
    this.books.set(bookKey(book.exchange, book.symbol), book);
    return this.evaluate(Date.now());
  }

  summary(): LearningSummary {
    const evaluatedSignals = this.outcomes.length;
    const missedProfits = this.outcomes.filter((outcome) => outcome.label === "MISSED_PROFIT").length;
    const avoidedLosses = this.outcomes.filter((outcome) => outcome.label === "AVOIDED_LOSS").length;
    const falsePositives = this.outcomes.filter((outcome) => outcome.label === "FALSE_POSITIVE").length;
    const confirmedEdges = this.outcomes.filter((outcome) => outcome.label === "CONFIRMED_EDGE").length;
    const shadowPnl = this.outcomes.reduce((sum, outcome) => sum.plus(outcome.realizedProfitUsd), ZERO);
    const missedProfitUsd = this.outcomes
      .filter((outcome) => outcome.label === "MISSED_PROFIT")
      .reduce((sum, outcome) => sum.plus(outcome.realizedProfitUsd), ZERO);
    const avoidedLossUsd = this.outcomes
      .filter((outcome) => outcome.label === "AVOIDED_LOSS")
      .reduce((sum, outcome) => sum.plus(d(outcome.realizedProfitUsd).abs()), ZERO);
    const opportunityCostUsd = missedProfitUsd.minus(avoidedLossUsd);
    const averageOutcome = evaluatedSignals ? shadowPnl.div(evaluatedSignals) : ZERO;
    const bestMissed = this.outcomes
      .filter((outcome) => outcome.label === "MISSED_PROFIT")
      .reduce((best, outcome) => Decimal.max(best, d(outcome.realizedProfitUsd)), ZERO);
    const useful = missedProfits + avoidedLosses + confirmedEdges;
    const brierScore = evaluatedSignals
      ? this.outcomes.reduce((sum, outcome) => {
        const realized = Number(outcome.realizedProfitUsd) > 0 ? 1 : 0;
        return sum + (realized - Number(outcome.predictedSurvival)) ** 2;
      }, 0) / evaluatedSignals
      : 0;

    return {
      evaluatedSignals,
      missedProfits,
      avoidedLosses,
      falsePositives,
      confirmedEdges,
      shadowPnlUsd: usd(shadowPnl),
      missedProfitUsd: usd(missedProfitUsd),
      avoidedLossUsd: usd(avoidedLossUsd),
      opportunityCostUsd: usd(opportunityCostUsd),
      averageOutcomeUsd: usd(averageOutcome),
      bestMissedUsd: usd(bestMissed),
      hitRatePct: evaluatedSignals ? ((useful / evaluatedSignals) * 100).toFixed(2) : "0.00",
      calibrationObservations: evaluatedSignals,
      brierScore: brierScore.toFixed(4),
      lastOutcome: this.outcomes[0]
    };
  }

  recentOutcomes(): CounterfactualOutcome[] {
    return [...this.outcomes];
  }

  private evaluate(now: number): CounterfactualOutcome[] {
    const matured: PendingSignal[] = [];
    const stillPending: PendingSignal[] = [];

    this.pending.forEach((signal) => {
      if (signal.dueAt <= now) matured.push(signal);
      else stillPending.push(signal);
    });

    this.pending.length = 0;
    this.pending.push(...stillPending);

    const outcomes: CounterfactualOutcome[] = [];
    matured.forEach((signal) => {
      const outcome = this.evaluateSignal(signal, now);
      if (outcome) {
        outcomes.push(outcome);
        return;
      }
      if (now - signal.dueAt < 2500) {
        this.pending.push({ ...signal, dueAt: now });
      }
    });

    outcomes.forEach((outcome) => this.outcomes.unshift(outcome));
    this.outcomes.splice(250);
    return outcomes;
  }

  private evaluateSignal(signal: PendingSignal, now: number): CounterfactualOutcome | null {
    const opportunity = signal.opportunity;
    if (!opportunity.buyExchange || !opportunity.sellExchange) return null;
    const buyBook = this.books.get(bookKey(opportunity.buyExchange, "BTC/USDT"));
    const sellBook = this.books.get(bookKey(opportunity.sellExchange, "BTC/USDT"));
    if (!buyBook || !sellBook) return null;
    const ask = topAsk(buyBook);
    const bid = topBid(sellBook);
    if (!ask || !bid) return null;

    const requestedQty = d(opportunity.tradeSizeBtc);
    const quantity = Decimal.max("0.000001", Decimal.min(requestedQty, ask.size, bid.size));
    const role = opportunity.executionPlan?.buyLiquidityRole ?? "taker";
    const result = calculateNetProfit({
      buyExchange: opportunity.buyExchange,
      sellExchange: opportunity.sellExchange,
      askPrice: ask.price,
      bidPrice: bid.price,
      quantityBtc: quantity,
      availableAskQty: ask.size,
      availableBidQty: bid.size,
      includeWithdrawal: true,
      withdrawalAmortization: role === "maker" ? d("0.005") : d("0.01"),
      buyLiquidityRole: role,
      sellLiquidityRole: opportunity.executionPlan?.sellLiquidityRole ?? role,
      buyQuoteAsset: buyBook.quoteAsset,
      sellQuoteAsset: sellBook.quoteAsset,
      buyQuoteToUsdRate: d(buyBook.quoteToUsdRate),
      sellQuoteToUsdRate: d(sellBook.quoteToUsdRate)
    });

    const realized = result.rebalanceAdjustedProfitUsd;
    const entry = d(opportunity.expectedProfitUsd);
    const label = classify(opportunity, realized);

    return {
      id: cryptoId("cf"),
      opportunityId: opportunity.id,
      route: opportunity.route,
      type: opportunity.type,
      evaluatedAt: now,
      horizonMs: signal.horizonMs,
      originalStatus: opportunity.status,
      entryExpectedProfitUsd: usd(entry),
      realizedProfitUsd: usd(realized),
      deltaUsd: usd(realized.minus(entry)),
      predictedSurvival: opportunity.edgeModel?.survivalProbability ?? (opportunity.confidence / 100).toFixed(3),
      expectedValueUsd: opportunity.expectedValueUsd,
      modelScore: opportunity.edgeModel?.modelScore ?? opportunity.score,
      quoteAgeMs: opportunity.edgeModel?.quoteAgeMs ?? 0,
      label
    };
  }
}

function classify(opportunity: Opportunity, realized: Decimal): CounterfactualOutcome["label"] {
  const positive = realized.greaterThan("0.05");
  const negative = realized.lessThan("-0.05");
  if (opportunity.status === "REJECTED" && positive) return "MISSED_PROFIT";
  if (opportunity.status === "REJECTED" && negative) return "AVOIDED_LOSS";
  if (opportunity.status !== "REJECTED" && negative) return "FALSE_POSITIVE";
  if (opportunity.status !== "REJECTED" && positive) return "CONFIRMED_EDGE";
  return "CONFIRMED_REJECT";
}

function bookKey(exchange: string, symbol: string): string {
  return `${exchange}:${symbol}`;
}

function cryptoId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
