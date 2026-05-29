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

  track(opportunity: Opportunity): void {
    if (opportunity.type !== "CROSS_EXCHANGE" || !opportunity.buyExchange || !opportunity.sellExchange) return;
    const horizons = opportunity.status === "REJECTED" ? [500, 2000, 5000] : [500, 2000];
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
      sellLiquidityRole: opportunity.executionPlan?.sellLiquidityRole ?? role
    });

    const realized = result.netProfitUsd;
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
