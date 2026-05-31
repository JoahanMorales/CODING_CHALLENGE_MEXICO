import { Decimal, d, usd, ZERO } from "../math/decimal";
import type { Opportunity, RiskState, ScenarioKind, Trade } from "../types";

export class RiskManager {
  private consecutiveLosses = 0;
  private dailyPnlUsd = ZERO;
  private activeScenario: ScenarioKind | null = null;
  private scenarioUntil = 0;
  private readonly materialLossThresholdUsd = d("-0.25");
  private readonly latencyHistory: number[] = [];
  private static readonly MAX_LATENCY_SAMPLES = 20;
  private static readonly LATENCY_HALT_THRESHOLD_MS = 3000;

  readonly maxPositionBtc = d("0.1");
  readonly dailyLossLimitUsd = d("-500");

  recordLatency(latencyMs: number): void {
    this.latencyHistory.push(latencyMs);
    if (this.latencyHistory.length > RiskManager.MAX_LATENCY_SAMPLES) this.latencyHistory.shift();
  }

  private averageLatency(): number {
    if (this.latencyHistory.length === 0) return 0;
    return this.latencyHistory.reduce((sum, ms) => sum + ms, 0) / this.latencyHistory.length;
  }

  shouldHalt(): boolean {
    if (this.consecutiveLosses >= 3 || this.dailyPnlUsd.lessThanOrEqualTo(this.dailyLossLimitUsd)) return true;
    return this.averageLatency() > RiskManager.LATENCY_HALT_THRESHOLD_MS;
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
    this.runScenario("MARKET_CRASH", durationMs);
  }

  runScenario(kind: ScenarioKind, durationMs = 30000): void {
    this.activeScenario = kind;
    this.scenarioUntil = Date.now() + durationMs;
  }

  getVolatilityMultiplier(): number {
    this.refreshScenario();
    if (this.activeScenario === "MARKET_CRASH") return 3;
    if (this.activeScenario === "LIQUIDITY_DRAIN") return 1.4;
    if (this.activeScenario === "LATENCY_SPIKE") return 1.15;
    return 1;
  }

  getLiquidityMultiplier(): number {
    this.refreshScenario();
    return this.activeScenario === "LIQUIDITY_DRAIN" ? 0.32 : 1;
  }

  getSpreadMultiplier(): number {
    this.refreshScenario();
    if (this.activeScenario === "MARKET_CRASH") return 1.85;
    if (this.activeScenario === "LIQUIDITY_DRAIN") return 2.6;
    return 1;
  }

  getLatencyMultiplier(): number {
    this.refreshScenario();
    if (this.activeScenario === "LATENCY_SPIKE") return 3.2;
    const avgLatency = this.averageLatency();
    if (avgLatency > 2000) return 2.5;
    if (avgLatency > 1000) return 1.5;
    return 1;
  }

  getState(exposureBtc = ZERO): RiskState {
    this.refreshScenario();
    const halted = this.shouldHalt();
    const lossLimited = this.dailyPnlUsd.lessThanOrEqualTo(this.dailyLossLimitUsd);
    const status = halted ? "CIRCUIT_BREAKER" : this.dailyPnlUsd.lessThan("-150") ? "HALTED" : "SCANNING";
    const riskColor = halted || lossLimited ? "RED" : this.consecutiveLosses > 0 || this.activeScenario ? "AMBER" : "GREEN";
    const haltedReason =
      this.consecutiveLosses >= 3
        ? "3 consecutive losing trades"
          : lossLimited
            ? "daily loss limit breached"
          : this.activeScenario
            ? `${scenarioLabel(this.activeScenario)} scenario active`
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
      marketCrashMode: this.activeScenario === "MARKET_CRASH",
      activeScenario: this.activeScenario ?? "NONE",
      scenarioRemainingMs: this.activeScenario ? Math.max(0, this.scenarioUntil - Date.now()) : 0
    };
  }

  private refreshScenario(): void {
    if (this.activeScenario && Date.now() > this.scenarioUntil) {
      this.activeScenario = null;
      this.scenarioUntil = 0;
    }
  }
}

function scenarioLabel(kind: ScenarioKind): string {
  if (kind === "MARKET_CRASH") return "market crash";
  if (kind === "LIQUIDITY_DRAIN") return "liquidity drain";
  return "latency spike";
}
