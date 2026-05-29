import { Decimal, d, usd, ZERO } from "../math/decimal";
import type { Opportunity, RiskState, Trade } from "../types";

export class RiskManager {
  private consecutiveLosses = 0;
  private dailyPnlUsd = ZERO;
  private marketCrashMode = false;
  private marketCrashUntil = 0;
  private readonly materialLossThresholdUsd = d("-0.25");

  readonly maxPositionBtc = d("0.1");
  readonly dailyLossLimitUsd = d("-500");

  shouldHalt(): boolean {
    return this.consecutiveLosses >= 3 || this.dailyPnlUsd.lessThanOrEqualTo(this.dailyLossLimitUsd);
  }

  evaluateOpportunity(opportunity: Opportunity): Opportunity {
    const cappedSize = Decimal.min(d(opportunity.tradeSizeBtc), this.maxPositionBtc);
    return {
      ...opportunity,
      tradeSizeBtc: cappedSize.toFixed(8),
      highImpact: opportunity.highImpact,
      reason: opportunity.highImpact
        ? `${opportunity.reason} HIGH IMPACT: engine capped size to <=20% of top liquidity.`
        : opportunity.reason
    };
  }

  recordTrade(trade: Trade): RiskState {
    const pnl = d(trade.pnlUsd);
    this.dailyPnlUsd = this.dailyPnlUsd.plus(pnl);
    this.consecutiveLosses = pnl.lessThan(this.materialLossThresholdUsd) ? this.consecutiveLosses + 1 : 0;
    return this.getState(d(trade.sizeBtc));
  }

  resetCircuitBreaker(): void {
    this.consecutiveLosses = 0;
  }

  simulateMarketCrash(durationMs = 30000): void {
    this.marketCrashMode = true;
    this.marketCrashUntil = Date.now() + durationMs;
  }

  getVolatilityMultiplier(): number {
    if (this.marketCrashMode && Date.now() > this.marketCrashUntil) {
      this.marketCrashMode = false;
    }
    return this.marketCrashMode ? 3 : 1;
  }

  getState(exposureBtc = ZERO): RiskState {
    const halted = this.shouldHalt();
    const lossLimited = this.dailyPnlUsd.lessThanOrEqualTo(this.dailyLossLimitUsd);
    const status = halted ? "CIRCUIT_BREAKER" : this.dailyPnlUsd.lessThan("-150") ? "HALTED" : "SCANNING";
    const riskColor = halted || lossLimited ? "RED" : this.consecutiveLosses > 0 || this.marketCrashMode ? "AMBER" : "GREEN";
    const haltedReason =
      this.consecutiveLosses >= 3
        ? "3 consecutive losing trades"
          : lossLimited
            ? "daily loss limit breached"
          : this.marketCrashMode
            ? "stress test active: demo volatility x3 for 30s"
            : "none";

    return {
      status,
      riskColor,
      circuitBreakerActive: halted,
      consecutiveLosses: this.consecutiveLosses,
      dailyPnlUsd: usd(this.dailyPnlUsd),
      dailyLossLimitUsd: usd(this.dailyLossLimitUsd),
      exposureBtc: exposureBtc.toFixed(6),
      maxPositionBtc: this.maxPositionBtc.toFixed(3),
      haltedReason,
      marketCrashMode: this.marketCrashMode
    };
  }
}
