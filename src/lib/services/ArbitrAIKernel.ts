import type { ExchangeId, ExecutionRuntimeMode, ExecutionState, GatewayMessage, GatewaySnapshot, LearningSummary, NormalizedOrderBook, Opportunity, ScenarioKind, WalletSeed } from "../types";
import { ArbitrageEngine } from "./ArbitrageEngine";
import { CounterfactualLearner } from "./CounterfactualLearner";
import { EventBus } from "./EventBus";
import { EventRecorder } from "./EventRecorder";
import { ExecutionSimulator } from "./ExecutionSimulator";
import { MarketDataService } from "./MarketDataService";
import { PnLTracker } from "./PnLTracker";
import { RiskManager } from "./RiskManager";
import { SandboxExecutionService } from "./SandboxExecutionService";

export class ArbitrAIKernel {
  readonly bus = new EventBus();
  readonly riskManager = new RiskManager();
  readonly marketData = new MarketDataService(this.bus, this.riskManager);
  readonly engine = new ArbitrageEngine();
  readonly simulator: ExecutionSimulator;
  readonly pnlTracker = new PnLTracker();
  readonly recorder = new EventRecorder();
  readonly learner = new CounterfactualLearner();
  readonly sandboxExecution = new SandboxExecutionService();

  private readonly opportunities: Opportunity[] = [];
  private readonly executionQueue: Opportunity[] = [];
  private readonly executionTransitions: GatewaySnapshot["executionTransitions"] = [];
  private readonly lastSignalAt = new Map<string, number>();
  private executing = false;

  constructor(walletSeed?: WalletSeed) {
    this.simulator = new ExecutionSimulator(walletSeed, () => this.riskManager.getLatencyMultiplier());
    this.bus.on("market:update", (book) => this.handleMarketUpdate(book));
  }

  startDemo(): void {
    this.marketData.startDemo();
  }

  stopDemo(): void {
    this.marketData.stopDemo();
  }

  ingest(book: NormalizedOrderBook): void {
    this.marketData.ingest(book);
  }

  simulateMarketCrash(): void {
    this.runScenario("MARKET_CRASH");
  }

  runScenario(kind: ScenarioKind): void {
    this.riskManager.runScenario(kind);
    this.publish({ type: "RISK", risk: this.riskManager.getState(this.simulator.exposureBtc()) });
  }

  resetRisk(): void {
    this.riskManager.resetCircuitBreaker();
    this.publish({ type: "RISK", risk: this.riskManager.getState(this.simulator.exposureBtc()) });
  }

  replayHistory(): void {
    const replay = this.recorder.replay();
    this.publish({ type: "REPLAY", opportunities: replay.opportunities, trades: replay.trades, events: replay.events });
  }

  setScannerUniverse(exchanges: ExchangeId[]): void {
    this.engine.setActiveExchanges(exchanges);
    this.publish({ type: "SCANNER_UNIVERSE", exchanges });
  }

  setExecutionMode(mode: ExecutionRuntimeMode): void {
    const runtime = this.sandboxExecution.setMode(mode);
    this.publish({ type: "EXECUTION_RUNTIME", runtime });
  }

  async refreshSandboxBalances(): Promise<void> {
    this.publish({ type: "EXECUTION_RUNTIME", runtime: await this.sandboxExecution.refreshBalances() });
  }

  async reconcileSandbox(): Promise<void> {
    this.publish({ type: "EXECUTION_RUNTIME", runtime: await this.sandboxExecution.reconcileLastReport() });
  }

  setSandboxKillSwitch(active: boolean): void {
    this.publish({ type: "EXECUTION_RUNTIME", runtime: this.sandboxExecution.setKillSwitch(active) });
  }

  snapshot(): GatewaySnapshot {
    return {
      type: "SNAPSHOT",
      books: this.engine.snapshotBooks(),
      opportunities: [...this.opportunities],
      executionQueue: [...this.executionQueue],
      trades: this.pnlTracker.getTrades(),
      wallets: this.simulator.balances(),
      risk: this.riskManager.getState(this.simulator.exposureBtc()),
      metrics: this.pnlTracker.metrics(),
      priceSeries: this.marketData.priceHistory(),
      learning: this.learningSummary(),
      executionRuntime: this.sandboxExecution.status(),
      executionTransitions: [...this.executionTransitions]
    };
  }

  private handleMarketUpdate(book: NormalizedOrderBook): void {
    this.publish({ type: "BOOK", book });
    const outcomes = book.symbol === "BTC/USDT" ? this.learner.observeBook(book) : [];
    outcomes.forEach((outcome) => {
      this.engine.recordShadowOutcome(outcome.route, Number(outcome.predictedSurvival), Number(outcome.realizedProfitUsd));
      this.publish({ type: "LEARNING", summary: this.learningSummary(), outcome });
    });
    const detected = this.engine.onOrderBook(book);
    detected.forEach((opportunity) => this.handleOpportunity(opportunity));
  }

  private handleOpportunity(rawOpportunity: Opportunity): void {
    const opportunity = this.riskManager.evaluateOpportunity(rawOpportunity);
    const signalKey = `${opportunity.type}:${opportunity.route}:${opportunity.status}`;
    const lastSignalAt = this.lastSignalAt.get(signalKey) ?? 0;
    const signalCadenceMs = opportunity.status === "REJECTED" ? 1500 : 320;
    if (Date.now() - lastSignalAt < signalCadenceMs) return;
    this.lastSignalAt.set(signalKey, Date.now());
    this.pnlTracker.recordOpportunity(opportunity);
    this.learner.track(opportunity);
    this.opportunities.unshift(opportunity);
    this.opportunities.splice(50);
    this.publish({ type: "OPPORTUNITY", opportunity, queue: [...this.executionQueue] });

    if (opportunity.status !== "DETECTED" || this.riskManager.shouldHalt()) return;
    this.transition(opportunity, "DETECTED", "Expected value survived fees, quote basis, impact and AET controls.");
    this.transition(opportunity, "PREFLIGHT", "Checking prefunded inventory for both execution legs.");
    const preflight = this.simulator.preflight(opportunity);
    if (!preflight.ok) {
      this.transition(opportunity, "PREFLIGHT_FAILED", preflight.reason);
      this.publish({ type: "OPPORTUNITY", opportunity: { ...opportunity, status: "REJECTED", reason: `Preflight rejected: ${preflight.reason}` }, queue: [...this.executionQueue] });
      return;
    }
    this.transition(opportunity, "VALIDATED", "Signal admitted to the score-prioritized execution queue.");
    this.executionQueue.push({ ...opportunity, status: "EVALUATING" });
    this.executionQueue.sort((a, b) => Number(b.expectedValueUsd) - Number(a.expectedValueUsd) || b.score - a.score);
    this.publish({ type: "OPPORTUNITY", opportunity: { ...opportunity, status: "EVALUATING" }, queue: [...this.executionQueue] });
    void this.drainQueue();
  }

  private async drainQueue(): Promise<void> {
    if (this.executing) return;
    this.executing = true;

    try {
      while (this.executionQueue.length && !this.riskManager.shouldHalt()) {
        const opportunity = this.executionQueue.shift();
        if (!opportunity) continue;
        if (Date.now() > opportunity.expiresAt) {
          this.transition(opportunity, "EXPIRED", "Signal exceeded its 500ms execution budget.");
          this.publish({ type: "OPPORTUNITY", opportunity: { ...opportunity, status: "EXPIRED" }, queue: [...this.executionQueue] });
          continue;
        }
        try {
          this.transition(opportunity, "RESERVED", "Paper inventory reserved for both legs.");
          this.transition(opportunity, "LEG_A", `Buying on ${opportunity.buyExchange ?? opportunity.exchange ?? "synthetic venue"}.`);
          const trade = await this.simulator.execute(opportunity);
          this.transition(opportunity, "LEG_B", `Selling on ${opportunity.sellExchange ?? opportunity.exchange ?? "synthetic venue"}.`);
          const risk = this.riskManager.recordTrade(trade);
          const metrics = this.pnlTracker.recordTrade(trade);
          this.engine.recordExecutionOutcome(opportunity, Number(trade.pnlUsd));
          this.publish({ type: "TRADE", trade, wallets: this.simulator.balances(), metrics, risk, queue: [...this.executionQueue] });
          this.transition(opportunity, trade.status === "REJECTED" ? "UNWIND_REQUIRED" : "RECONCILED", trade.status === "REJECTED" ? "Paper fill failed preflight; no wallet mutation applied." : "Both paper legs reconciled.");
          const sandboxReport = await this.sandboxExecution.execute(opportunity);
          if (sandboxReport) this.publish({ type: "EXECUTION_RUNTIME", runtime: this.sandboxExecution.status(), report: sandboxReport });
        } catch (error) {
          this.transition(opportunity, "UNWIND_REQUIRED", `Execution threw before reconciliation: ${errorMessage(error)}`);
          this.publish({ type: "OPPORTUNITY", opportunity: { ...opportunity, status: "REJECTED", reason: `Execution error: ${errorMessage(error)}` }, queue: [...this.executionQueue] });
        }
      }
    } finally {
      this.executing = false;
    }
  }

  private publish(message: GatewayMessage): void {
    this.recorder.record(message);
    this.bus.emit("gateway:message", message);
  }

  private learningSummary(): LearningSummary {
    const learning = this.learner.summary();
    const calibration = this.engine.calibrationSummary();
    const mlCalibration = this.engine.mlEdgeTensor.calibrationSummary();
    return {
      ...learning,
      calibrationObservations: calibration.observations,
      brierScore: calibration.brierScore.toFixed(4),
      mlObservations: mlCalibration.observations,
      mlBrierScore: mlCalibration.brierScore.toFixed(4)
    };
  }

  private transition(opportunity: Opportunity, state: ExecutionState, detail: string): void {
    const transition = {
      opportunityId: opportunity.id,
      route: opportunity.route,
      state,
      at: Date.now(),
      detail
    };
    this.executionTransitions.unshift(transition);
    this.executionTransitions.splice(60);
    this.publish({ type: "EXECUTION_STATE", transition });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
