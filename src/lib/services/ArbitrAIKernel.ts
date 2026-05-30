import type { ExecutionRuntimeMode, GatewayMessage, GatewaySnapshot, NormalizedOrderBook, Opportunity, ScenarioKind, WalletSeed } from "../types";
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

  setExecutionMode(mode: ExecutionRuntimeMode): void {
    const runtime = this.sandboxExecution.setMode(mode);
    this.publish({ type: "EXECUTION_RUNTIME", runtime });
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
      learning: this.learner.summary(),
      executionRuntime: this.sandboxExecution.status()
    };
  }

  private handleMarketUpdate(book: NormalizedOrderBook): void {
    this.publish({ type: "BOOK", book });
    const outcomes = this.learner.observeBook(book);
    outcomes.forEach((outcome) => {
      this.engine.recordShadowOutcome(outcome.route, Number(outcome.predictedSurvival), Number(outcome.realizedProfitUsd));
      this.publish({ type: "LEARNING", summary: this.learner.summary(), outcome });
    });
    const detected = this.engine.onOrderBook(book);
    detected.forEach((opportunity) => this.handleOpportunity(opportunity));
  }

  private handleOpportunity(rawOpportunity: Opportunity): void {
    const opportunity = this.riskManager.evaluateOpportunity(rawOpportunity);
    const signalKey = `${opportunity.type}:${opportunity.route}:${opportunity.status}`;
    const lastSignalAt = this.lastSignalAt.get(signalKey) ?? 0;
    if (Date.now() - lastSignalAt < 650) return;
    this.lastSignalAt.set(signalKey, Date.now());
    this.pnlTracker.recordOpportunity(opportunity);
    this.learner.track(opportunity);
    this.opportunities.unshift(opportunity);
    this.opportunities.splice(50);
    this.publish({ type: "OPPORTUNITY", opportunity, queue: [...this.executionQueue] });

    if (opportunity.status !== "DETECTED" || this.riskManager.shouldHalt()) return;
    this.executionQueue.push({ ...opportunity, status: "EVALUATING" });
    this.executionQueue.sort((a, b) => b.score - a.score);
    this.publish({ type: "OPPORTUNITY", opportunity: { ...opportunity, status: "EVALUATING" }, queue: [...this.executionQueue] });
    void this.drainQueue();
  }

  private async drainQueue(): Promise<void> {
    if (this.executing) return;
    this.executing = true;

    while (this.executionQueue.length && !this.riskManager.shouldHalt()) {
      const opportunity = this.executionQueue.shift();
      if (!opportunity) continue;
      if (Date.now() > opportunity.expiresAt) {
        this.publish({ type: "OPPORTUNITY", opportunity: { ...opportunity, status: "EXPIRED" }, queue: [...this.executionQueue] });
        continue;
      }
      const trade = await this.simulator.execute(opportunity);
      const risk = this.riskManager.recordTrade(trade);
      const metrics = this.pnlTracker.recordTrade(trade);
      this.engine.recordExecutionOutcome(opportunity, Number(trade.pnlUsd));
      this.publish({ type: "TRADE", trade, wallets: this.simulator.balances(), metrics, risk });
      const sandboxReport = await this.sandboxExecution.execute(opportunity);
      if (sandboxReport) this.publish({ type: "EXECUTION_RUNTIME", runtime: this.sandboxExecution.status(), report: sandboxReport });
    }

    this.executing = false;
  }

  private publish(message: GatewayMessage): void {
    this.recorder.record(message);
    this.bus.emit("gateway:message", message);
  }
}
