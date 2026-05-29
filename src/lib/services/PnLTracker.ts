import { Decimal, d, usd, ZERO } from "../math/decimal";
import type { Opportunity, PerformanceMetrics, Trade } from "../types";

export class PnLTracker {
  private opportunitiesDetected = 0;
  private executableOpportunities = 0;
  private rejectedOpportunities = 0;
  private detectionLatencyTotalMs = 0;
  private readonly trades: Trade[] = [];

  recordOpportunity(opportunity: Opportunity): void {
    this.opportunitiesDetected += 1;
    this.detectionLatencyTotalMs += opportunity.detectionLatencyMs;
    if (opportunity.status === "DETECTED") this.executableOpportunities += 1;
    if (opportunity.status === "REJECTED") this.rejectedOpportunities += 1;
  }

  recordTrade(trade: Trade): PerformanceMetrics {
    this.trades.unshift(trade);
    this.trades.splice(250);
    return this.metrics();
  }

  getTrades(): Trade[] {
    return [...this.trades];
  }

  metrics(): PerformanceMetrics {
    const executed = this.trades.filter((trade) => trade.status !== "REJECTED");
    const pnlValues = executed.map((trade) => d(trade.pnlUsd));
    const netPnl = pnlValues.reduce((sum, value) => sum.plus(value), ZERO);
    const wins = pnlValues.filter((value) => value.greaterThan(0)).length;
    const totalFees = executed.reduce((sum, trade) => sum.plus(trade.feesUsd), ZERO);
    const bestTrade = pnlValues.reduce((best, value) => Decimal.max(best, value), ZERO);
    const averageProfit = executed.length ? netPnl.div(executed.length) : ZERO;
    const mean = averageProfit;
    const variance =
      pnlValues.length > 1
        ? pnlValues.reduce((sum, value) => sum.plus(value.minus(mean).pow(2)), ZERO).div(pnlValues.length - 1)
        : ZERO;
    const stdDev = variance.sqrt();
    const sharpeLike = stdDev.greaterThan(0) ? netPnl.div(stdDev) : ZERO;

    return {
      opportunitiesDetected: this.opportunitiesDetected,
      executableOpportunities: this.executableOpportunities,
      rejectedOpportunities: this.rejectedOpportunities,
      tradesExecuted: executed.length,
      netPnlUsd: usd(netPnl),
      winRatePct: executed.length ? ((wins / executed.length) * 100).toFixed(2) : "0.00",
      averageProfitUsd: usd(averageProfit),
      bestTradeUsd: usd(bestTrade),
      totalFeesPaidUsd: usd(totalFees),
      opportunityExecutionRatioPct: this.opportunitiesDetected
        ? ((executed.length / this.opportunitiesDetected) * 100).toFixed(2)
        : "0.00",
      averageDetectionLatencyMs: this.opportunitiesDetected
        ? (this.detectionLatencyTotalMs / this.opportunitiesDetected).toFixed(2)
        : "0.00",
      sharpeLikeRatio: sharpeLike.toFixed(3)
    };
  }
}
