"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { EXCHANGE_IDS, EXCHANGE_LABELS } from "@/lib/config/exchanges";
import type {
  ExchangeConnectionStatus,
  ExchangeId,
  ExecutionRuntimeMode,
  ExecutionRuntimeState,
  ExecutionTransition,
  LearningSummary,
  NormalizedOrderBook,
  Opportunity,
  OpportunityType,
  PerformanceMetrics,
  PricePoint,
  RiskState,
  ScenarioKind,
  Trade,
  WalletBalance,
  WalletSeed
} from "@/lib/types";
import { btcBookKey, useArbitrageStore } from "@/store/useArbitrageStore";

const exchanges: ExchangeId[] = EXCHANGE_IDS;
const opportunityTypes: OpportunityType[] = ["CROSS_EXCHANGE", "STAT_ARB", "TRIANGULAR"];

const strategyLabel: Record<OpportunityType, string> = {
  CROSS_EXCHANGE: "Cross",
  STAT_ARB: "Stat Arb",
  TRIANGULAR: "Triangular"
};

export function Dashboard() {
  const {
    init,
    setMode,
    runScenario,
    resetRisk,
    replayHistory,
    exportSessionCsv,
    setExecutionRuntimeMode,
    refreshSandboxBalances,
    reconcileSandbox,
    setSandboxKillSwitch,
    mode,
    connected,
    connectionError,
    lastGatewayMessageAt,
    books,
    exchangeStatuses,
    flashes,
    opportunities,
    replayOpportunities,
    executionQueue,
    executionTransitions,
    trades,
    wallets,
    walletSeed,
    updateWalletSeed,
    applyWalletSeed,
    risk,
    metrics,
    learning,
    executionRuntime,
    priceSeries,
    adminAuthenticated,
    scannerUniverse,
    setScannerUniverse
  } = useArbitrageStore();
  const [visibleExchanges, setVisibleExchanges] = useState<ExchangeId[]>(exchanges);
  const [visibleTypes, setVisibleTypes] = useState<OpportunityType[]>(opportunityTypes);
  const [visibleStatus, setVisibleStatus] = useState<"ALL" | "EXECUTABLE" | "REJECTED">("ALL");
  const [stressOpen, setStressOpen] = useState(false);

  useEffect(() => init(), [init]);

  const visibleOpportunities = useMemo(
    () => (replayOpportunities.length ? replayOpportunities : opportunities).filter((opportunity) =>
      visibleTypes.includes(opportunity.type)
      && opportunityTouchesExchange(opportunity, visibleExchanges)
      && (visibleStatus === "ALL"
        || (visibleStatus === "EXECUTABLE" && (opportunity.status === "DETECTED" || opportunity.status === "EVALUATING" || opportunity.status === "EXECUTED"))
        || (visibleStatus === "REJECTED" && opportunity.status === "REJECTED"))
    ),
    [opportunities, replayOpportunities, visibleExchanges, visibleStatus, visibleTypes]
  );
  const latestExecutable = opportunities.find((item) => item.status === "DETECTED" || item.status === "EVALUATING");
  const latestSignal = opportunities[0];
  const hasFreshBooks = useMemo(() => Object.values(books).some((book) => Date.now() - book.receivedAt < 6000), [books]);
  const hasLiveExchange = exchangeStatuses.some((status) => status.status === "live" || status.status === "polling");
  const dataActive = mode === "DEMO" ? hasFreshBooks || connected : connected || hasLiveExchange || hasFreshBooks;
  const heartbeatMs = lastGatewayMessageAt ? Date.now() - lastGatewayMessageAt : 0;

  const pnlSeries = useMemo(() => makePnlSeries(trades), [trades]);
  const strategyStats = useMemo(() => buildStrategyStats(opportunities), [opportunities]);
  const walletTotals = useMemo(() => summarizeWallets(wallets), [wallets]);
  const marketIntel = useMemo(() => buildMarketIntel(books, opportunities), [books, opportunities]);
  const marketMids = useMemo(() => exchanges.map((exchange) => midFromBook(books[btcBookKey(exchange)])).filter((value) => value > 0), [books]);
  const marketDrift = marketMids.length > 1 ? Math.max(...marketMids) - Math.min(...marketMids) : 0;
  const missedOpportunities = useMemo(() => opportunities.filter((opportunity) => opportunity.status === "REJECTED").slice(0, 6), [opportunities]);

  return (
    <main className="grid h-full w-full min-w-0 max-w-full grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden bg-[#f7fbff] text-zinc-900">
      <CommandBar
        connected={connected}
        dataActive={dataActive}
        heartbeatMs={heartbeatMs}
        metrics={metrics}
        mode={mode}
        risk={risk}
        setMode={setMode}
      />

      <MemoTerminalToolbar
        scannerUniverse={scannerUniverse}
        setScannerUniverse={setScannerUniverse}
        setVisibleExchanges={setVisibleExchanges}
        setVisibleStatus={setVisibleStatus}
        setVisibleTypes={setVisibleTypes}
        visibleExchanges={visibleExchanges}
        visibleStatus={visibleStatus}
        visibleTypes={visibleTypes}
      />

      <section className="relative z-0 min-h-0 min-w-0 overflow-x-hidden overflow-y-auto px-3 py-3 xl:overflow-hidden xl:px-4">
        <div className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] gap-3 xl:h-full xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.28fr)_minmax(0,0.96fr)]">
          <aside className="grid min-h-0 min-w-0 max-w-full gap-3 overflow-x-hidden pr-1 xl:grid-rows-[auto_auto_auto_minmax(220px,0.82fr)] xl:overflow-y-auto">
            <MemoSystemHealth
              connectionError={connectionError}
              connected={connected}
              dataActive={dataActive}
              heartbeatMs={heartbeatMs}
              mode={mode}
              risk={risk}
              statuses={exchangeStatuses}
            />
            <MemoMicrostructurePanel intel={marketIntel} />
            <MemoMarketStack books={books} exchangesShown={visibleExchanges} flashes={flashes} statuses={exchangeStatuses} />
            <MemoPriceChartPanel marketDrift={marketDrift} priceSeries={priceSeries} />
          </aside>

          <section className="grid min-h-0 min-w-0 max-w-full gap-3 overflow-x-hidden xl:grid-rows-[auto_minmax(0,1fr)_auto] xl:overflow-hidden">
            <MemoActiveEdgePanel latestExecutable={latestExecutable} latestSignal={latestSignal} latestTrade={trades[0]} metrics={metrics} risk={risk} />
            <MemoSignalFeed opportunities={visibleOpportunities} replaying={replayOpportunities.length > 0} />
            <details className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 shadow-sm shadow-sky-100/70">
              <summary className="cursor-pointer list-none font-mono text-[10px] font-black uppercase text-sky-700">
                Abrir análisis avanzado
              </summary>
              <div className="mt-3 grid gap-3">
                <StrategyMatrix stats={strategyStats} />
                <MissedOpportunityPanel opportunities={missedOpportunities} />
              </div>
            </details>
          </section>

          <aside className="flex min-h-0 min-w-0 max-w-full flex-col gap-3 overflow-x-hidden overflow-y-auto pr-1">
            <div className="flex-shrink-0">
              <MemoPerformancePanel metrics={metrics} mode={mode} pnlSeries={pnlSeries} risk={risk} />
            </div>
            <details className="flex-shrink-0 rounded-2xl border border-zinc-200 bg-white px-4 py-3 shadow-sm shadow-sky-100/70">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                <span className="font-mono text-[10px] font-black uppercase text-sky-700">Shadow Learning</span>
                <StatusPill label={`${learning.evaluatedSignals} markouts`} tone={learning.evaluatedSignals ? "sky" : "zinc"} />
              </summary>
              <div className="mt-3">
                <MemoLearningPanel learning={learning} bare />
              </div>
            </details>
            <div className="flex-shrink-0">
              <MemoExecutionPanel
                executionQueue={executionQueue}
                executionTransitions={executionTransitions}
                reconcileSandbox={reconcileSandbox}
                refreshSandboxBalances={refreshSandboxBalances}
                runtime={executionRuntime}
                setExecutionRuntimeMode={setExecutionRuntimeMode}
                setSandboxKillSwitch={setSandboxKillSwitch}
                trades={trades}
                controlsLocked={mode === "LIVE" && !adminAuthenticated}
              />
            </div>
            <div className="flex-shrink-0">
              <MemoWalletPanel
                applyWalletSeed={applyWalletSeed}
                mode={mode}
                seed={walletSeed}
                totals={walletTotals}
                update={updateWalletSeed}
                wallets={wallets}
              />
            </div>
          </aside>
        </div>
      </section>

      <RiskDock adminAuthenticated={adminAuthenticated} exportSessionCsv={exportSessionCsv} mode={mode} replayHistory={replayHistory} resetRisk={resetRisk} risk={risk} runScenario={runScenario} stressOpen={stressOpen} setStressOpen={setStressOpen} />
      {stressOpen && <div className="fixed inset-0 z-[1000]" onClick={() => setStressOpen(false)} />}
      {stressOpen && (
        <div className="fixed bottom-24 right-4 z-[1001] w-[min(92vw,360px)] rounded-2xl border border-amber-200 bg-white p-4 shadow-2xl shadow-amber-200/60 ring-1 ring-amber-100">
          <div className="flex items-center justify-between">
            <SectionKicker>Escenarios controlados</SectionKicker>
            <button className="font-mono text-xs font-black text-zinc-400 hover:text-zinc-700" onClick={() => setStressOpen(false)} type="button">
              CERRAR
            </button>
          </div>
          <p className="mt-2 text-xs font-semibold leading-5 text-zinc-500">
            {mode === "LIVE" ? "Disponible únicamente en Demo. Nunca alteramos los precios recibidos del mercado live." : "Cada escenario modifica el simulador durante 30 segundos para comprobar la reacción del motor."}
          </p>
          <div className="mt-3 grid gap-2">
            <ScenarioButton disabled={mode === "LIVE"} label="Crash: volatilidad x3" onClick={() => runScenario("MARKET_CRASH")} />
            <ScenarioButton disabled={mode === "LIVE"} label="Drenaje de liquidez" onClick={() => runScenario("LIQUIDITY_DRAIN")} />
            <ScenarioButton disabled={mode === "LIVE"} label="Latencia elevada" onClick={() => runScenario("LATENCY_SPIKE")} />
          </div>
        </div>
      )}
    </main>
  );
}

function CommandBar({
  connected,
  dataActive,
  heartbeatMs,
  metrics,
  mode,
  risk,
  setMode
}: {
  connected: boolean;
  dataActive: boolean;
  heartbeatMs: number;
  metrics: PerformanceMetrics;
  mode: "LIVE" | "DEMO";
  risk: RiskState;
  setMode: (mode: "LIVE" | "DEMO") => void;
}) {
  const netPositive = Number(metrics.netPnlUsd) >= 0;
  return (
    <header className="min-w-0 overflow-x-hidden border-b border-sky-100 bg-white/92 px-4 py-3 shadow-sm shadow-sky-100/70 backdrop-blur">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] font-black uppercase text-sky-700">Terminal de arbitraje</span>
          <StatusPill label={dataActive ? "Mercado activo" : "Sincronizando"} tone={dataActive ? "green" : "amber"} pulse={dataActive} />
          <StatusPill label={mode === "LIVE" ? "Feeds reales" : "Simulador GBM"} tone={mode === "LIVE" ? "sky" : "violet"} />
          <StatusPill label={`Riesgo ${risk.riskColor}`} tone={riskTone(risk.riskColor)} />
        </div>

        <div className="flex w-full min-w-0 flex-wrap items-center justify-start gap-2 md:w-auto md:justify-end">
          <SegmentedMode mode={mode} setMode={setMode} />
          <TopMetric label="Gateway" value={connected ? `${heartbeatMs}ms` : "OFF"} tone={connected ? "sky" : "rose"} />
          <TopMetric label="Señales" value={String(metrics.opportunitiesDetected)} tone="zinc" />
          <TopMetric label="Ejecuciones" value={`${metrics.tradesExecuted}/${metrics.executableOpportunities}`} tone="emerald" />
          <TopMetric label="Paper P&L" value={`$${metrics.netPnlUsd}`} tone={netPositive ? "emerald" : "rose"} />
          <TopMetric label="Latencia" value={`${metrics.averageDetectionLatencyMs}ms`} tone="sky" />
        </div>
      </div>
    </header>
  );
}

function TerminalToolbar({
  scannerUniverse,
  setScannerUniverse,
  setVisibleExchanges,
  setVisibleStatus,
  setVisibleTypes,
  visibleExchanges,
  visibleStatus,
  visibleTypes
}: {
  scannerUniverse: ExchangeId[];
  setScannerUniverse: (exchanges: ExchangeId[]) => void;
  setVisibleExchanges: React.Dispatch<React.SetStateAction<ExchangeId[]>>;
  setVisibleStatus: React.Dispatch<React.SetStateAction<"ALL" | "EXECUTABLE" | "REJECTED">>;
  setVisibleTypes: React.Dispatch<React.SetStateAction<OpportunityType[]>>;
  visibleExchanges: ExchangeId[];
  visibleStatus: "ALL" | "EXECUTABLE" | "REJECTED";
  visibleTypes: OpportunityType[];
}) {
  const visibleFilterCount = visibleExchanges.length + visibleTypes.length;
  return (
    <section className="relative z-[60] min-w-0 border-b border-sky-100 bg-white px-4 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {(["ALL", "EXECUTABLE", "REJECTED"] as const).map((status) => (
            <FilterChip active={visibleStatus === status} key={status} label={statusLabel(status)} onClick={() => setVisibleStatus(status)} />
          ))}
          <details className="relative">
            <summary className="cursor-pointer list-none rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1.5 font-mono text-[9px] font-black uppercase text-zinc-600 transition hover:border-sky-200 hover:text-sky-700">
              Filtros · {visibleFilterCount}
            </summary>
            <div className="fixed inset-x-3 top-36 z-[90] max-h-[calc(100vh-10rem)] overflow-y-auto rounded-2xl border border-sky-100 bg-white p-4 shadow-xl shadow-sky-100 sm:absolute sm:inset-x-auto sm:left-0 sm:top-9 sm:w-[min(92vw,520px)]">
              <SectionKicker>Filtros visuales</SectionKicker>
              <p className="mt-1 text-xs font-semibold leading-5 text-zinc-500">Cambian lo que ves en esta pantalla. No modifican las decisiones del motor.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {exchanges.map((exchange) => (
                  <FilterChip
                    active={visibleExchanges.includes(exchange)}
                    key={exchange}
                    label={EXCHANGE_LABELS[exchange]}
                    onClick={() => setVisibleExchanges((current) => toggleAtLeastOne(current, exchange))}
                  />
                ))}
              </div>
              <div className="mt-3 flex flex-wrap gap-2 border-t border-zinc-100 pt-3">
                {opportunityTypes.map((type) => (
                  <FilterChip
                    active={visibleTypes.includes(type)}
                    key={type}
                    label={strategyLabel[type]}
                    onClick={() => setVisibleTypes((current) => toggleAtLeastOne(current, type))}
                  />
                ))}
              </div>
            </div>
          </details>
        </div>

        <details className="relative">
          <summary className="cursor-pointer list-none rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 font-mono text-[10px] font-black uppercase text-zinc-600 transition hover:border-sky-200 hover:text-sky-700">
            Universo del scanner
          </summary>
          <div className="fixed inset-x-3 top-36 z-[90] max-h-[calc(100vh-10rem)] overflow-y-auto rounded-2xl border border-sky-100 bg-white p-4 shadow-xl shadow-sky-100 sm:absolute sm:inset-x-auto sm:right-0 sm:top-11 sm:w-[min(92vw,440px)]">
            <div>
              <SectionKicker>Configuración</SectionKicker>
              <h2 className="mt-1 text-lg font-black text-zinc-950">Universo del scanner</h2>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {exchanges.map((exchange) => (
                <label className="flex items-center gap-2 rounded-lg border border-zinc-100 bg-zinc-50 px-2 py-2 text-xs font-black text-zinc-700" key={exchange}>
                  <input
                    checked={scannerUniverse.includes(exchange)}
                    onChange={() => setScannerUniverse(toggleAtLeastTwo(scannerUniverse, exchange))}
                    type="checkbox"
                  />
                  {EXCHANGE_LABELS[exchange]}
                </label>
              ))}
            </div>
            <p className="mt-3 font-mono text-[10px] font-semibold leading-5 text-zinc-500">
              Este control modifica los mercados que el motor evalúa. Los feeds continúan conectados para conservar observabilidad.
            </p>
          </div>
        </details>
      </div>
    </section>
  );
}

function FilterChip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      aria-pressed={active}
      className={`rounded-lg border px-2.5 py-1.5 font-mono text-[9px] font-black uppercase transition ${active ? "border-sky-300 bg-sky-100 text-sky-800 shadow-sm" : "border-zinc-200 bg-white text-zinc-400 hover:text-zinc-700"}`}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}

function SystemHealth({
  connected,
  connectionError,
  dataActive,
  heartbeatMs,
  mode,
  risk,
  statuses
}: {
  connected: boolean;
  connectionError: string;
  dataActive: boolean;
  heartbeatMs: number;
  mode: "LIVE" | "DEMO";
  risk: RiskState;
  statuses: ExchangeConnectionStatus[];
}) {
  const liveCount = statuses.filter((status) => status.status === "live" || status.status === "polling").length;
  const verifiedBooks = statuses.filter((status) => status.bookIntegrity === "VERIFIED" || status.bookIntegrity === "SEQUENCED").length;
  const integrityGaps = statuses.reduce((sum, status) => sum + (status.gapCount ?? 0), 0);
  const title = dataActive ? "Datos de mercado estables" : connected ? "Sincronizando mercados" : "Gateway desconectado";
  return (
    <Panel className="bg-gradient-to-br from-white via-sky-50/60 to-emerald-50/50">
      <div className="flex items-start justify-between gap-3">
        <div>
          <SectionKicker>Sistema</SectionKicker>
          <h2 className="mt-1 text-xl font-black text-zinc-950">{title}</h2>
        </div>
        <div className="text-right font-mono">
          <div className={`text-2xl font-black ${riskColorClass(risk.riskColor)}`}>{risk.status}</div>
          <div className="text-[10px] font-bold uppercase text-zinc-500">{mode === "LIVE" ? "ws://localhost:8080" : "gbm simulator"}</div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <HealthStat label="Mercados" value={`${liveCount}/${exchanges.length}`} tone={liveCount === exchanges.length ? "emerald" : "amber"} />
        <HealthStat label="Books íntegros" value={`${verifiedBooks}/${exchanges.length}`} tone={verifiedBooks >= 4 ? "emerald" : "amber"} />
        <HealthStat label="Heartbeat" value={connected ? `${heartbeatMs}ms` : "--"} tone={connected ? "sky" : "rose"} />
        <HealthStat label="Gaps" value={String(integrityGaps)} tone={integrityGaps ? "amber" : "emerald"} />
      </div>

      <details className="mt-3 rounded-xl border border-white/80 bg-white/65 px-3 py-2">
        <summary className="cursor-pointer list-none font-mono text-[10px] font-black uppercase text-sky-700">
          Ver estado de los {exchanges.length} venues
        </summary>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {exchanges.map((exchange) => {
            const status = statuses.find((item) => item.exchange === exchange);
            const age = status?.lastMessageAt ? Math.max(0, Date.now() - status.lastMessageAt) : 0;
            return (
              <div key={exchange} className="flex items-center justify-between rounded-lg border border-white bg-white/80 px-2 py-2">
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${statusDot(status?.status)}`} />
                  <span className="text-xs font-black uppercase text-zinc-700">{EXCHANGE_LABELS[exchange]}</span>
                </div>
                <span className="font-mono text-[9px] font-semibold text-zinc-500">
                  {status?.bookIntegrity ?? "--"} / {status?.quoteAsset ?? "--"} / {status?.lastMessageAt ? formatAge(age) : "--"}
                </span>
              </div>
            );
          })}
        </div>
      </details>

      {!dataActive && <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">{connectionError || "Esperando libros de órdenes."}</p>}
    </Panel>
  );
}

function MicrostructurePanel({ intel }: { intel: MarketIntel }) {
  const pressureTone = intel.pressureAbs > 18 ? (intel.pressure > 0 ? "emerald" : "rose") : "sky";
  return (
    <Panel className="bg-gradient-to-br from-white via-white to-violet-50/50">
      <div className="flex items-start justify-between gap-3">
        <PanelTitle eyebrow="Microestructura" title="Radar de oportunidades" />
        <StatusPill label={regimeLabel(intel.regime)} tone={intel.regime === "Wide" ? "amber" : intel.regime === "Tight" ? "emerald" : "sky"} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <TinyMetric label="Fragmentación" value={`$${intel.fragmentation.toFixed(2)}`} tone="sky" />
        <TinyMetric label="Presión" value={`${intel.pressure.toFixed(1)}%`} tone={pressureTone} />
        <TinyMetric label="Sesgo microprice" value={`${intel.microSkewBps.toFixed(2)} bps`} tone={intel.microSkewBps >= 0 ? "emerald" : "rose"} />
        <TinyMetric label="Supervivencia" value={`${intel.survival.toFixed(0)}%`} tone={intel.survival >= 55 ? "emerald" : "amber"} />
      </div>
      <div className="mt-3 rounded-xl border border-sky-100 bg-sky-50/70 px-3 py-2">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-black text-zinc-800">{intel.route}</span>
          <span className={`font-mono text-xs font-black ${intel.grossEdge >= 0 ? "text-emerald-700" : "text-rose-700"}`}>
            {intel.grossEdge >= 0 ? "+" : ""}${intel.grossEdge.toFixed(2)}
          </span>
        </div>
        <div className="mt-1 font-mono text-[10px] font-semibold text-zinc-500">
          El modelo filtra spreads ruidosos con profundidad, desequilibrio del libro y microprice antes de ejecutar.
        </div>
      </div>
    </Panel>
  );
}

function MarketStack({
  books,
  exchangesShown,
  flashes,
  statuses
}: {
  books: Record<string, NormalizedOrderBook>;
  exchangesShown: ExchangeId[];
  flashes: Record<string, { bid: string; ask: string; until: number }>;
  statuses: ExchangeConnectionStatus[];
}) {
  return (
    <Panel>
      <div className="flex items-center justify-between gap-3">
        <PanelTitle eyebrow="Top of book" title="BTC / USD normalizado" />
        <StatusPill label={`${exchangesShown.length} venues`} tone="sky" />
      </div>
      <div className="mt-3 overflow-x-auto">
        <div className="min-w-[410px]">
          <div className="grid grid-cols-[1fr_1fr_1fr_72px] gap-2 border-b border-zinc-100 px-2 pb-2 font-mono text-[9px] font-black uppercase text-zinc-400">
            <span>Venue</span>
            <span>Bid</span>
            <span>Ask</span>
            <span className="text-right">Update</span>
          </div>
          {exchangesShown.map((exchange) => {
            const book = books[btcBookKey(exchange)];
            const status = statuses.find((item) => item.exchange === exchange);
            const age = book ? Math.max(0, Date.now() - book.receivedAt) : 0;
            return (
              <div className="grid grid-cols-[1fr_1fr_1fr_72px] items-center gap-2 border-b border-zinc-100 px-2 py-2 last:border-b-0" key={exchange}>
                <span className="flex items-center gap-2 text-xs font-black text-zinc-800">
                  <span className={`h-2 w-2 rounded-full ${statusDot(status?.status)}`} />
                  {EXCHANGE_LABELS[exchange]}
                </span>
                <strong className={`rounded px-1 font-mono text-[11px] text-emerald-700 ${flashes[btcBookKey(exchange)]?.bid === "up" ? "flash-up" : flashes[btcBookKey(exchange)]?.bid === "down" ? "flash-down" : ""}`}>
                  {formatPrice(book?.bids[0]?.price ?? "-")}
                </strong>
                <strong className={`rounded px-1 font-mono text-[11px] text-rose-700 ${flashes[btcBookKey(exchange)]?.ask === "up" ? "flash-up" : flashes[btcBookKey(exchange)]?.ask === "down" ? "flash-down" : ""}`}>
                  {formatPrice(book?.asks[0]?.price ?? "-")}
                </strong>
                <span className="text-right font-mono text-[10px] font-semibold text-zinc-500">{book ? formatAge(age) : "--"}</span>
              </div>
            );
          })}
        </div>
      </div>
      <details className="mt-3 border-t border-zinc-100 pt-3">
        <summary className="cursor-pointer font-mono text-[10px] font-black uppercase text-sky-700">Abrir profundidad top-5</summary>
        <div className="mt-3 grid gap-2">
          {exchangesShown.map((exchange) => (
            <MarketCard
              key={exchange}
              book={books[btcBookKey(exchange)]}
              exchange={exchange}
              flash={flashes[btcBookKey(exchange)]}
              status={statuses.find((item) => item.exchange === exchange)}
            />
          ))}
        </div>
      </details>
    </Panel>
  );
}

function MarketCard({
  book,
  exchange,
  flash,
  status
}: {
  book?: NormalizedOrderBook;
  exchange: ExchangeId;
  flash?: { bid: string; ask: string; until: number };
  status?: ExchangeConnectionStatus;
}) {
  const bid = book?.bids[0];
  const ask = book?.asks[0];
  const spread = bid && ask ? (((Number(ask.price) - Number(bid.price)) / Number(ask.price)) * 100).toFixed(4) : "0.0000";
  const age = book ? Math.max(0, Date.now() - book.receivedAt) : 0;
  return (
    <article className="rounded-xl border border-zinc-200 bg-white p-3 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${statusDot(status?.status)}`} />
          <h3 className="text-sm font-black text-zinc-900">{EXCHANGE_LABELS[exchange]}</h3>
        </div>
        <span className="font-mono text-[10px] font-semibold text-zinc-500">{book ? formatAge(age) : "warming"}</span>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <PriceTile label="Bid" tone="emerald" value={bid?.price ?? "-"} flash={flash?.bid} />
        <PriceTile label="Ask" tone="rose" value={ask?.price ?? "-"} flash={flash?.ask} />
        <PriceTile label="Spread" tone="sky" value={`${spread}%`} />
      </div>

      <details className="mt-2">
        <summary className="cursor-pointer font-mono text-[10px] font-black uppercase text-sky-700">Ver profundidad</summary>
        <div className="mt-2 grid grid-cols-2 gap-3">
          <DepthSide levels={book?.bids ?? []} side="bid" title="Profundidad bid" />
          <DepthSide levels={book?.asks ?? []} side="ask" title="Profundidad ask" />
        </div>
      </details>
    </article>
  );
}

function PriceChartPanel({ marketDrift, priceSeries }: { marketDrift: number; priceSeries: PricePoint[] }) {
  return (
    <Panel className="min-h-0">
      <div className="flex items-center justify-between">
        <PanelTitle eyebrow="Convergencia" title="Mapa de precios" />
        <div className="rounded-lg border border-sky-100 bg-sky-50 px-3 py-2 text-right font-mono">
          <div className="text-[10px] font-bold uppercase text-sky-600">Dispersión</div>
          <div className="text-sm font-black text-sky-700">${marketDrift.toFixed(2)}</div>
        </div>
      </div>
      <div className="mt-3 h-56">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={priceSeries}>
            <CartesianGrid stroke="#e4edf7" vertical={false} />
            <XAxis dataKey="time" hide />
            <YAxis domain={["dataMin - 25", "dataMax + 25"]} hide />
            <Tooltip contentStyle={{ background: "#ffffff", border: "1px solid #dbeafe", borderRadius: 12, color: "#27272a" }} />
            <Line type="monotone" dataKey="binance" stroke="#0ea5e9" dot={false} isAnimationActive={false} strokeWidth={2} />
            <Line type="monotone" dataKey="kraken" stroke="#10b981" dot={false} isAnimationActive={false} strokeWidth={2} />
            <Line type="monotone" dataKey="coinbase" stroke="#f59e0b" dot={false} isAnimationActive={false} strokeWidth={2} />
            <Line type="monotone" dataKey="okx" stroke="#8b5cf6" dot={false} isAnimationActive={false} strokeWidth={2} />
            <Line type="monotone" dataKey="bybit" stroke="#ec4899" dot={false} isAnimationActive={false} strokeWidth={2} />
            <Line type="monotone" dataKey="bitfinex" stroke="#64748b" dot={false} isAnimationActive={false} strokeWidth={2} />
            <Line type="monotone" dataKey="gate" stroke="#14b8a6" dot={false} isAnimationActive={false} strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}

function ActiveEdgePanel({
  latestExecutable,
  latestSignal,
  latestTrade,
  metrics,
  risk
}: {
  latestExecutable?: Opportunity;
  latestSignal?: Opportunity;
  latestTrade?: Trade;
  metrics: PerformanceMetrics;
  risk: RiskState;
}) {
  const freshExecutable = latestExecutable && Date.now() - latestExecutable.createdAt < 2500 ? latestExecutable : undefined;
  const featured = freshExecutable ?? latestSignal;
  const positive = freshExecutable ? Number(freshExecutable.expectedValueUsd) >= 0 : latestTrade ? Number(latestTrade.pnlUsd) >= 0 : featured ? Number(featured.expectedValueUsd) >= 0 : true;
  const status = risk.circuitBreakerActive ? "Ejecución pausada" : freshExecutable ? "Oportunidad ejecutable" : metrics.tradesExecuted ? "Sesión activa" : "Buscando oportunidades";
  const primaryRoute = risk.circuitBreakerActive
    ? "Los controles de riesgo detuvieron la ejecución tras tres pérdidas consecutivas. Los datos siguen activos."
    : freshExecutable
      ? freshExecutable.route
      : latestTrade
        ? `Última ejecución: ${latestTrade.route}`
        : featured?.route ?? "Esperando la primera señal";
  return (
    <Panel
      className={
        risk.circuitBreakerActive
          ? "border-rose-200 bg-gradient-to-r from-rose-50 via-white to-amber-50"
          : freshExecutable
            ? "border-emerald-200 bg-gradient-to-r from-emerald-50 via-white to-sky-50"
            : "bg-gradient-to-r from-sky-50 via-white to-violet-50"
      }
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-center">
        <div>
          <SectionKicker>Señal prioritaria</SectionKicker>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h2 className="text-2xl font-black text-zinc-950">{status}</h2>
            {risk.circuitBreakerActive && <StatusPill label="Circuit breaker" tone="rose" />}
            {featured && <StatusPill label={featured.executionStyle} tone={freshExecutable ? "green" : "sky"} />}
            {featured?.highImpact && <StatusPill label="Impacto alto" tone="amber" />}
          </div>
          <div className="mt-3 min-h-[30px] text-sm font-black text-zinc-800">
            {primaryRoute}
          </div>
        </div>

        <div className="grid grid-cols-5 gap-2 font-mono sm:min-w-[540px]">
          <SignalNumber label="Score" value={freshExecutable ? String(freshExecutable.score) : featured ? String(featured.score) : "--"} tone="sky" />
          <SignalNumber label="Net" value={freshExecutable ? `${freshExecutable.netSpreadPct}%` : featured ? `${featured.netSpreadPct}%` : "--"} tone={positive ? "emerald" : "rose"} />
          <SignalNumber label="EV" value={freshExecutable ? `$${freshExecutable.expectedValueUsd}` : latestTrade ? `$${latestTrade.pnlUsd}` : featured ? `$${featured.expectedValueUsd}` : "$0.00"} tone={positive ? "emerald" : "rose"} />
          <SignalNumber label="Superv." value={featured?.edgeModel ? `${(Number(featured.edgeModel.survivalProbability) * 100).toFixed(0)}%` : "--"} tone={featured?.edgeModel && Number(featured.edgeModel.survivalProbability) >= 0.55 ? "emerald" : "amber"} />
          <SignalNumber label="Ejec." value={String(metrics.tradesExecuted)} tone="zinc" />
        </div>
      </div>
    </Panel>
  );
}

function StrategyMatrix({ stats }: { stats: StrategyStat[] }) {
  return (
    <div className="grid gap-3 md:grid-cols-3">
      {stats.map((stat) => {
        const tone = stat.type === "CROSS_EXCHANGE" ? "sky" : stat.type === "STAT_ARB" ? "emerald" : "amber";
        return (
          <Panel key={stat.type} className="p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <SectionKicker>{strategyLabel[stat.type]}</SectionKicker>
                <div className="mt-1 text-xl font-black text-zinc-950">{stat.total}</div>
              </div>
              <StatusPill label={`${stat.executable} ejecutables`} tone={tone} />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <TinyMetric label="Score medio" value={stat.averageScore.toFixed(0)} tone={tone} />
              <TinyMetric label="Mejor" value={`$${stat.bestProfit.toFixed(2)}`} tone={stat.bestProfit >= 0 ? "emerald" : "rose"} />
            </div>
            <ProgressBar value={stat.total ? stat.executable / stat.total * 100 : 0} tone={tone} />
          </Panel>
        );
      })}
    </div>
  );
}

function MissedOpportunityPanel({ opportunities }: { opportunities: Opportunity[] }) {
  return (
    <Panel className="p-3">
      <div className="flex items-center justify-between gap-3">
        <PanelTitle eyebrow="Decisiones descartadas" title="Por qué no se ejecutó" />
        <StatusPill label={`${opportunities.length} explicadas`} tone={opportunities.length ? "amber" : "emerald"} />
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {opportunities.length ? (
          opportunities.slice(0, 3).map((opportunity) => (
            <div key={opportunity.id} className="rounded-xl border border-amber-100 bg-amber-50/45 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs font-black text-zinc-800">{opportunity.route}</span>
                <span className="font-mono text-xs font-black text-amber-700">{opportunity.score}</span>
              </div>
              <div className="mt-1 grid grid-cols-3 gap-1 font-mono text-[10px] font-black">
                <span className={Number(opportunity.netSpreadPct) >= 0 ? "text-emerald-700" : "text-rose-700"}>{opportunity.netSpreadPct}%</span>
                <span className="text-zinc-500">{rejectCause(opportunity)}</span>
                <span className="text-right text-zinc-500">{opportunity.edgeModel ? `${(Number(opportunity.edgeModel.survivalProbability) * 100).toFixed(0)}% surv` : "rule"}</span>
              </div>
            </div>
          ))
        ) : (
          <EmptyState compact text="No hay rechazos recientes." />
        )}
      </div>
    </Panel>
  );
}

function SignalFeed({ opportunities, replaying }: { opportunities: Opportunity[]; replaying: boolean }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  const [visibleSignals, setVisibleSignals] = useState(opportunities);

  useEffect(() => {
    if (!paused) setVisibleSignals(opportunities);
  }, [opportunities, paused]);

  const resume = () => {
    setVisibleSignals(opportunities);
    setPaused(false);
    viewportRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <Panel className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
      <div className="flex items-center justify-between">
        <PanelTitle eyebrow={replaying ? "Replay" : "Flujo en vivo"} title="Señales recientes" />
        {paused ? (
          <button className="rounded-full border border-sky-200 bg-sky-50 px-3 py-1 font-mono text-[10px] font-black uppercase text-sky-700" onClick={resume} type="button">
            Ver señales nuevas
          </button>
        ) : (
          <span className="rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1 font-mono text-[10px] font-black uppercase text-zinc-500">
            {opportunities.length} visibles
          </span>
        )}
      </div>
      <div
        className="signal-tape mt-3 min-h-0 overflow-y-auto pr-1"
        onScroll={(event) => setPaused(event.currentTarget.scrollTop > 18)}
        ref={viewportRef}
      >
        <div className="grid gap-2">
          {visibleSignals.length ? (
            visibleSignals.slice(0, 18).map((opportunity) => <SignalRow key={opportunity.id} opportunity={opportunity} />)
          ) : (
            <EmptyState text="Esperando señales." />
          )}
        </div>
      </div>
    </Panel>
  );
}

function SignalRow({ opportunity }: { opportunity: Opportunity }) {
  const positive = Number(opportunity.expectedProfitUsd) >= 0;
  const active = opportunity.status === "DETECTED" || opportunity.status === "EVALUATING";
  return (
    <article className={`opportunity-live rounded-xl border p-3 ${active ? "border-emerald-200 bg-emerald-50/60" : "border-zinc-200 bg-white"}`}>
      <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-center">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill label={strategyLabel[opportunity.type]} tone={opportunityTone(opportunity.type)} />
            <StatusPill label={opportunity.status} tone={statusTone(opportunity.status)} />
            {opportunity.edgeModel && <StatusPill label={`AET ${opportunity.edgeModel.modelScore}`} tone={opportunity.edgeModel.edgeQuality === "EXPLOIT" ? "emerald" : opportunity.edgeModel.edgeQuality === "WATCH" ? "amber" : "rose"} />}
            {opportunity.highImpact && <StatusPill label="Impacto" tone="amber" />}
          </div>
          <h3 className="mt-2 truncate text-sm font-black text-zinc-900">{opportunity.route}</h3>
          <div className="mt-1 truncate font-mono text-[10px] font-semibold text-zinc-500">
            {opportunity.executionStyle}
            {opportunity.edgeModel
              ? ` / survival ${(Number(opportunity.edgeModel.survivalProbability) * 100).toFixed(0)}% / adverse ${opportunity.edgeModel.adverseSelectionBps}bps / quote ${opportunity.edgeModel.quoteAgeMs}ms`
              : ""}
          </div>
        </div>

        <div className="grid grid-cols-4 gap-2 font-mono md:w-[360px]">
          <SignalNumber compact label="Score" value={String(opportunity.score)} tone="sky" />
          <SignalNumber compact label="Net" value={`${opportunity.netSpreadPct}%`} tone={positive ? "emerald" : "rose"} />
          <SignalNumber compact label="EV" value={`$${opportunity.expectedValueUsd}`} tone={Number(opportunity.expectedValueUsd) >= 0 ? "emerald" : "rose"} />
          <SignalNumber compact label={opportunity.edgeModel ? "Surv" : "Size"} value={opportunity.edgeModel ? `${(Number(opportunity.edgeModel.survivalProbability) * 100).toFixed(0)}%` : Number(opportunity.tradeSizeBtc).toFixed(4)} tone={opportunity.edgeModel && Number(opportunity.edgeModel.survivalProbability) >= 0.55 ? "emerald" : "zinc"} />
        </div>
      </div>
    </article>
  );
}

function PerformancePanel({ metrics, mode, pnlSeries, risk }: { metrics: PerformanceMetrics; mode: "LIVE" | "DEMO"; pnlSeries: Array<{ index: number; pnl: number }>; risk: RiskState }) {
  const positive = Number(metrics.netPnlUsd) >= 0;
  return (
    <Panel>
      <div className="flex items-start justify-between gap-3">
        <PanelTitle eyebrow="Rendimiento paper" title="Execution Net P&L" />
        <div className="text-right">
          <div className={`font-mono text-3xl font-black ${positive ? "text-emerald-600" : "text-rose-600"}`}>${metrics.netPnlUsd}</div>
          <div className="font-mono text-[10px] font-bold uppercase text-zinc-500">{risk.riskColor} risk</div>
        </div>
      </div>

      <div className="mt-3 h-48 rounded-xl border border-emerald-100 bg-emerald-50/35 p-2">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={pnlSeries}>
            <defs>
              <linearGradient id="pnlGradient" x1="0" x2="0" y1="0" y2="1">
                <stop offset="5%" stopColor="#10b981" stopOpacity={0.48} />
                <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#d9f3e8" vertical={false} />
            <XAxis dataKey="index" hide />
            <YAxis hide />
            <Tooltip contentStyle={{ background: "#ffffff", border: "1px solid #bbf7d0", borderRadius: 12, color: "#27272a" }} />
            <Area type="monotone" dataKey="pnl" stroke="#10b981" fill="url(#pnlGradient)" isAnimationActive={false} strokeWidth={2.4} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <CostWaterfall metrics={metrics} />

      <div className="mt-3 grid grid-cols-3 gap-2">
        <TinyMetric label="Win rate" value={`${metrics.winRatePct}%`} tone="emerald" />
        <TinyMetric label="Promedio" value={`$${metrics.averageProfitUsd}`} tone={Number(metrics.averageProfitUsd) >= 0 ? "emerald" : "rose"} />
        <TinyMetric label="Mejor trade" value={`$${metrics.bestTradeUsd}`} tone="sky" />
        <TinyMetric label="Comisiones" value={`$${metrics.totalFeesPaidUsd}`} tone="amber" />
        <TinyMetric label="Tasa de ejec." value={`${metrics.opportunityExecutionRatioPct}%`} tone="violet" />
        <TinyMetric label="Sharpe" value={metrics.sharpeLikeRatio} tone="zinc" />
      </div>
      <div className={`mt-3 rounded-xl border px-3 py-2 text-xs font-semibold leading-5 ${metrics.tradesExecuted ? "border-emerald-100 bg-emerald-50/60 text-emerald-800" : "border-sky-100 bg-sky-50/70 text-sky-800"}`}>
        {metrics.tradesExecuted
          ? `${metrics.tradesExecuted} fills paper registrados. El P&L refleja ejecución simulada después de costos.`
          : mode === "LIVE"
            ? "Live activo: todavía no existe un edge neto ejecutable. El motor sigue escaneando feeds reales sin inventar fills."
            : "Demo activo: el siguiente pulso de fragmentación alimentará un edge controlado para demostrar queue, fill y P&L."}
      </div>
    </Panel>
  );
}

function CostWaterfall({ metrics }: { metrics: PerformanceMetrics }) {
  const stages = [
    { label: "Gross edge", subtractive: false, tone: "sky" as const, value: metrics.grossPnlUsd },
    { label: "Fees", subtractive: true, tone: "amber" as const, value: metrics.totalFeesPaidUsd },
    { label: "Slippage", subtractive: true, tone: "rose" as const, value: metrics.totalSlippageUsd },
    { label: "Quote basis", subtractive: true, tone: "amber" as const, value: metrics.totalQuoteConversionCostUsd },
    { label: "Execution risk", subtractive: true, tone: "violet" as const, value: metrics.totalExecutionRiskUsd },
    { label: "Execution net", subtractive: false, tone: Number(metrics.netPnlUsd) >= 0 ? "emerald" as const : "rose" as const, value: metrics.netPnlUsd }
  ];
  return (
    <div className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50/75 p-3">
      <div className="flex items-center justify-between gap-3">
        <SectionKicker>Waterfall de ejecución</SectionKicker>
        <span className="font-mono text-[9px] font-black uppercase text-zinc-400">Gross - costos = net</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-6">
        {stages.map((stage, index) => (
          <div className={`relative rounded-lg border bg-white px-2 py-2 ${toneBorder(stage.tone)}`} key={stage.label}>
            <span className="block font-mono text-[8px] font-black uppercase text-zinc-500">{stage.label}</span>
            <strong className={`mt-1 block truncate font-mono text-xs ${toneText(stage.tone)}`}>
              {waterfallValue(stage.value, stage.subtractive)}
            </strong>
            {index < stages.length - 1 && <span className="absolute -right-2.5 top-1/2 hidden -translate-y-1/2 font-mono text-xs font-black text-zinc-300 sm:block">→</span>}
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-100 bg-amber-50/65 px-2 py-2 font-mono text-[10px] font-black">
        <span className="text-amber-700">Rebalance amortizado -${metrics.totalRebalanceCostUsd}</span>
        <span className={Number(metrics.rebalanceAdjustedPnlUsd) >= 0 ? "text-emerald-700" : "text-rose-700"}>
          Rebalance-adjusted P&L ${metrics.rebalanceAdjustedPnlUsd}
        </span>
      </div>
    </div>
  );
}

function waterfallValue(value: string, subtractive: boolean): string {
  const amount = Number(value);
  if (!subtractive) return `$${value}`;
  return amount >= 0 ? `-$${value}` : `+$${Math.abs(amount).toFixed(2)}`;
}

function LearningPanel({ bare = false, learning }: { bare?: boolean; learning: LearningSummary }) {
  const costPositive = Number(learning.opportunityCostUsd) >= 0;
  const last = learning.lastOutcome;
  const content = (
    <>
      <div className="flex items-start justify-between gap-3">
        <PanelTitle eyebrow="Calibración adaptativa" title="Shadow Learning" />
        <StatusPill label={`${learning.evaluatedSignals} eval`} tone={learning.evaluatedSignals ? "sky" : "zinc"} />
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        <TinyMetric label="Costo de oportunidad" value={`$${learning.opportunityCostUsd}`} tone={costPositive ? "amber" : "emerald"} />
        <TinyMetric label="Acierto del modelo" value={`${learning.hitRatePct}%`} tone={Number(learning.hitRatePct) >= 55 ? "emerald" : "amber"} />
        <TinyMetric label="Pérdida evitada" value={`$${learning.avoidedLossUsd}`} tone="emerald" />
        <TinyMetric label="Ganancia perdida" value={`$${learning.missedProfitUsd}`} tone={Number(learning.missedProfitUsd) > 0 ? "amber" : "zinc"} />
        <TinyMetric label="Evitadas" value={String(learning.avoidedLosses)} tone="emerald" />
        <TinyMetric label="Falsos +" value={String(learning.falsePositives)} tone={learning.falsePositives ? "rose" : "zinc"} />
        <TinyMetric label="Calibración" value={String(learning.calibrationObservations)} tone="sky" />
        <TinyMetric label="Brier score" value={learning.brierScore} tone={Number(learning.brierScore) <= 0.25 ? "emerald" : "amber"} />
      </div>

      <div className="mt-3 rounded-xl border border-sky-100 bg-white/80 px-3 py-2">
        {last ? (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-xs font-black text-zinc-800">{last.route}</span>
              <StatusPill label={last.label.replace(/_/g, " ")} tone={learningLabelTone(last.label)} />
            </div>
            <div className="mt-1 flex items-center justify-between gap-3 font-mono text-[10px] font-black text-zinc-500">
              <span>{last.horizonMs}ms markout</span>
              <span className={Number(last.realizedProfitUsd) >= 0 ? "text-emerald-700" : "text-rose-700"}>${last.realizedProfitUsd}</span>
            </div>
          </>
        ) : (
          <div className="font-mono text-[10px] font-bold text-zinc-500">Esperando que las señales maduren para calcular sus markouts.</div>
        )}
      </div>
    </>
  );
  return bare ? content : <Panel className="bg-gradient-to-br from-white via-white to-sky-50/60">{content}</Panel>;
}

function ExecutionPanel({
  controlsLocked,
  executionQueue,
  executionTransitions,
  reconcileSandbox,
  refreshSandboxBalances,
  runtime,
  setExecutionRuntimeMode,
  setSandboxKillSwitch,
  trades
}: {
  controlsLocked: boolean;
  executionQueue: Opportunity[];
  executionTransitions: ExecutionTransition[];
  reconcileSandbox: () => void;
  refreshSandboxBalances: () => void;
  runtime: ExecutionRuntimeState;
  setExecutionRuntimeMode: (mode: ExecutionRuntimeMode) => void;
  setSandboxKillSwitch: (active: boolean) => void;
  trades: Trade[];
}) {
  const configured = runtime.venues.filter((venue) => venue.configured).length;
  return (
    <Panel>
      <details className="mb-3 rounded-xl border border-sky-100 bg-sky-50/60">
        <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 px-3 py-3">
          <div>
            <SectionKicker>Puente de validación firmado</SectionKicker>
            <div className="mt-1 text-xs font-black text-zinc-800">TEST_ORDER sin movimiento de fondos</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill label={runtime.mode} tone={runtime.mode === "SANDBOX" ? "violet" : "zinc"} />
            <StatusPill label={runtime.orderMode.replace(/_/g, " ")} tone={runtime.orderMode === "LIVE_SANDBOX" ? "amber" : "sky"} />
            <span className="font-mono text-[10px] font-black text-zinc-500">{configured}/{runtime.venues.length} mercados</span>
          </div>
        </summary>
        <div className="border-t border-sky-100 px-3 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <SectionKicker>Controles protegidos</SectionKicker>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="font-mono text-[10px] font-black text-zinc-500">
                Límite por validación: ${runtime.maxNotionalUsd}
              </span>
            </div>
          </div>
          <button
            className={`rounded-xl border px-3 py-2 font-mono text-[10px] font-black transition ${
              runtime.mode === "SANDBOX"
                ? "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50"
                : "border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100"
            }`}
            onClick={() => setExecutionRuntimeMode(runtime.mode === "SANDBOX" ? "PAPER" : "SANDBOX")}
            disabled={controlsLocked}
            type="button"
          >
            {controlsLocked ? "ADMIN REQUERIDO" : runtime.mode === "SANDBOX" ? "VOLVER A PAPER" : "HABILITAR TEST_ORDER"}
          </button>
        </div>
        {runtime.lastReport && (
          <div className="mt-2 flex items-center justify-between gap-3 border-t border-sky-100 pt-2 font-mono text-[10px] font-black text-zinc-500">
            <span className="truncate">{runtime.lastReport.reason}</span>
            <span className={runtime.lastReport.status === "FAILED" ? "text-rose-700" : runtime.lastReport.status === "SUBMITTED" ? "text-emerald-700" : "text-sky-700"}>
              {runtime.lastReport.status}
            </span>
          </div>
        )}
        <div className="mt-2 grid grid-cols-3 gap-2 border-t border-sky-100 pt-2">
          <TinyMetric label="P&L sandbox" value={`$${Number(runtime.ledger.realizedPnlUsd).toFixed(4)}`} tone={Number(runtime.ledger.realizedPnlUsd) >= 0 ? "emerald" : "rose"} />
          <TinyMetric label="Validaciones" value={String(runtime.ledger.executions)} tone="sky" />
          <TinyMetric label="Fees sandbox" value={`$${Number(runtime.ledger.feesUsd).toFixed(4)}`} tone="amber" />
        </div>
        <div className="mt-2 grid gap-2 border-t border-sky-100 pt-2 sm:grid-cols-2">
          {runtime.venues.map((venue) => {
            const btc = venue.balances.find((balance) => balance.asset === "BTC");
            const usdt = venue.balances.find((balance) => balance.asset === "USDT");
            return (
              <div className="rounded-lg border border-white bg-white/80 px-2 py-2" key={venue.exchange}>
                <div className="flex items-center justify-between gap-2">
                  <strong className="text-[10px] font-black uppercase text-zinc-700">{venue.exchange}</strong>
                  <span className={`font-mono text-[9px] font-black ${venue.lastError ? "text-rose-700" : venue.configured ? "text-emerald-700" : "text-zinc-400"}`}>
                    {venue.lastError ? "CHECK" : venue.configured ? "READY" : "NO KEY"}
                  </span>
                </div>
                <div className="mt-1 flex justify-between gap-2 font-mono text-[9px] font-bold text-zinc-500">
                  <span>{Number(btc?.available ?? 0).toFixed(5)} BTC</span>
                  <span>${Number(usdt?.available ?? 0).toFixed(2)}</span>
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <button className="rounded-lg border border-sky-200 bg-white px-2 py-1 font-mono text-[9px] font-black text-sky-700 hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-45" disabled={controlsLocked} onClick={refreshSandboxBalances} type="button">
            ACTUALIZAR SALDOS
          </button>
          <button className="rounded-lg border border-violet-200 bg-white px-2 py-1 font-mono text-[9px] font-black text-violet-700 hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-45" disabled={controlsLocked} onClick={reconcileSandbox} type="button">
            CONCILIAR
          </button>
          <button
            className={`rounded-lg border px-2 py-1 font-mono text-[9px] font-black ${runtime.killSwitchActive ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700"}`}
            disabled={controlsLocked}
            onClick={() => setSandboxKillSwitch(!runtime.killSwitchActive)}
            type="button"
          >
            {runtime.killSwitchActive ? "REACTIVAR" : "DETENER SANDBOX"}
          </button>
          <StatusPill label={runtime.killSwitchActive ? "Sandbox detenido" : "Sandbox disponible"} tone={runtime.killSwitchActive ? "rose" : "emerald"} />
        </div>
        {runtime.lastReconciliation && (
          <div className="mt-2 truncate font-mono text-[9px] font-bold text-zinc-500">
            REC {runtime.lastReconciliation.status} / residual {runtime.lastReconciliation.residualBtc} BTC / hedge {runtime.lastReconciliation.hedgeAction}
          </div>
        )}
        {runtime.lastPreflight && (
          <div className={`mt-1 truncate font-mono text-[9px] font-bold ${runtime.lastPreflight.status === "READY" ? "text-emerald-700" : "text-rose-700"}`}>
            PREFLIGHT {runtime.lastPreflight.status} / {runtime.lastPreflight.reason}
          </div>
        )}
        </div>
      </details>
      <div className="grid gap-3 lg:grid-cols-2">
        <div>
          <div className="mb-2 flex items-center justify-between">
            <SectionKicker>Cola priorizada</SectionKicker>
            <span className="font-mono text-[10px] font-black text-zinc-500">{executionQueue.length} pendientes</span>
          </div>
          <div className="grid max-h-40 gap-2 overflow-y-auto pr-1">
            {executionQueue.length ? (
              executionQueue.slice(0, 5).map((item) => (
                <div key={item.id} className="rounded-lg border border-sky-100 bg-sky-50 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-black text-zinc-800">{item.route}</span>
                    <span className="font-mono text-sm font-black text-sky-700">{item.score}</span>
                  </div>
                  <div className="mt-1 font-mono text-[10px] font-semibold text-zinc-500">{item.executionStyle}</div>
                </div>
              ))
            ) : (
              <EmptyState text="Cola vacía." compact />
            )}
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <SectionKicker>Ejecuciones paper</SectionKicker>
            <span className="font-mono text-[10px] font-black text-zinc-500">{trades.length} fills</span>
          </div>
          <div className="grid max-h-40 gap-2 overflow-y-auto pr-1">
            {trades.length ? trades.slice(0, 8).map((trade) => <TradeRow key={trade.id} trade={trade} />) : <EmptyState text="Aún no hay fills." compact />}
          </div>
        </div>
      </div>
      <details className="mt-3 border-t border-zinc-100 pt-3">
        <summary className="cursor-pointer font-mono text-[10px] font-black uppercase text-sky-700">
          Ver state machine · {executionTransitions.length} eventos
        </summary>
        <div className="mt-2 grid max-h-40 gap-1 overflow-y-auto">
          {executionTransitions.length ? executionTransitions.slice(0, 14).map((transition) => (
            <div className="grid grid-cols-[92px_1fr] gap-2 rounded-lg bg-zinc-50 px-2 py-1.5 font-mono text-[9px]" key={`${transition.opportunityId}:${transition.state}:${transition.at}`}>
              <strong className="text-sky-700">{transition.state}</strong>
              <span className="truncate text-zinc-500">{transition.route} · {transition.detail}</span>
            </div>
          )) : <EmptyState compact text="Esperando una ejecución admitida por EV." />}
        </div>
      </details>
    </Panel>
  );
}

function WalletPanel({
  applyWalletSeed,
  mode,
  seed,
  totals,
  update,
  wallets
}: {
  applyWalletSeed: () => void;
  mode: "LIVE" | "DEMO";
  seed: WalletSeed;
  totals: { btc: number; usdt: number; rebalanceCount: number };
  update: (exchange: ExchangeId, asset: "btc" | "usdt", value: string) => void;
  wallets: WalletBalance[];
}) {
  return (
    <Panel className="min-h-0 overflow-hidden">
      <div className="flex items-center justify-between gap-3">
        <PanelTitle eyebrow="Capital simulado" title="Balances por mercado" />
        <div className="grid grid-cols-2 gap-2 font-mono">
          <TinyMetric label="BTC" value={totals.btc.toFixed(4)} tone="zinc" />
          <TinyMetric label="USD eq." value={`$${totals.usdt.toLocaleString("en-US", { maximumFractionDigits: 0 })}`} tone="emerald" />
        </div>
      </div>

      <details className="mt-3">
        <summary className="cursor-pointer font-mono text-[10px] font-black uppercase text-sky-700">Ver asignación de balances</summary>
        <div className="mt-2 grid gap-2">
          {wallets.map((wallet) => (
            <WalletRow key={wallet.exchange} wallet={wallet} />
          ))}
        </div>
      </details>

      {mode === "DEMO" && (
        <div className="mt-3 rounded-xl border border-violet-100 bg-violet-50/60 p-3">
          <div className="mb-2 flex items-center justify-between">
            <SectionKicker>Capital inicial del demo</SectionKicker>
            <button className="rounded-lg border border-violet-200 bg-white px-3 py-1.5 font-mono text-[10px] font-black text-violet-700" onClick={applyWalletSeed} type="button">
              APLICAR
            </button>
          </div>
          <WalletSeedEditor seed={seed} update={update} />
        </div>
      )}

      {totals.rebalanceCount > 0 && <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-black text-amber-700">SE REQUIERE REBALANCEO</div>}
    </Panel>
  );
}

function RiskDock({
  adminAuthenticated,
  exportSessionCsv,
  mode,
  replayHistory,
  resetRisk,
  risk,
  runScenario,
  stressOpen,
  setStressOpen
}: {
  adminAuthenticated: boolean;
  exportSessionCsv: () => void;
  mode: "LIVE" | "DEMO";
  replayHistory: () => void;
  resetRisk: () => void;
  risk: RiskState;
  runScenario: (scenario: ScenarioKind) => void;
  stressOpen: boolean;
  setStressOpen: (open: boolean) => void;
}) {
  const scenarioSeconds = Math.ceil(risk.scenarioRemainingMs / 1000);
  const scenarioLocked = mode === "LIVE";
  const adminLocked = mode === "LIVE" && !adminAuthenticated;
  return (
    <footer className="min-w-0 border-t border-sky-100 bg-white/92 px-4 py-3 shadow-[0_-8px_24px_rgba(186,230,253,0.25)] backdrop-blur">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3 font-mono text-xs">
          <span className="flex items-center gap-2 font-black text-zinc-800">
            <span className={`h-2.5 w-2.5 rounded-full ${risk.riskColor === "RED" ? "bg-rose-500" : risk.riskColor === "AMBER" ? "bg-amber-500" : "bg-emerald-500"}`} />
            RIESGO {risk.riskColor}
          </span>
          <span>Breaker {risk.circuitBreakerActive ? "ACTIVO" : "LIBRE"}</span>
          <span>Pérdidas {risk.consecutiveLosses}/3</span>
          <span>Exposición {risk.exposureBtc} BTC</span>
          <span>P&L diario ${risk.dailyPnlUsd}</span>
          <span className="text-zinc-500">
            {risk.activeScenario !== "NONE" ? `${risk.activeScenario.replace(/_/g, " ")} ${scenarioSeconds}s` : risk.haltedReason}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 font-mono text-xs font-black text-emerald-700 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-45" disabled={adminLocked} onClick={resetRisk} type="button">
            REINICIAR RIESGO
          </button>
          <button className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-2 font-mono text-xs font-black text-sky-700 transition hover:bg-sky-100" onClick={replayHistory} type="button">
            REPLAY 5 MIN
          </button>
          <button className="rounded-xl border border-violet-200 bg-violet-50 px-4 py-2 font-mono text-xs font-black text-violet-700 transition hover:bg-violet-100" onClick={exportSessionCsv} type="button">
            EXPORTAR CSV
          </button>
          <button
            className="cursor-pointer rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 font-mono text-xs font-black text-amber-700 transition hover:bg-amber-100"
            onClick={() => setStressOpen(!stressOpen)}
            type="button"
          >
            LABORATORIO DE ESTRÉS
          </button>
        </div>
      </div>
    </footer>
  );
}

function ScenarioButton({ disabled, label, onClick }: { disabled: boolean; label: string; onClick: () => void }) {
  return (
    <button
      className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-left font-mono text-[10px] font-black text-amber-700 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-45"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}

function WalletRow({ wallet }: { wallet: WalletBalance }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white px-3 py-2">
      <div className="mb-2 flex items-center justify-between">
        <strong className="text-sm font-black text-zinc-900">{EXCHANGE_LABELS[wallet.exchange]}</strong>
        {wallet.rebalancingNeeded && <StatusPill label="Rebalance" tone="amber" />}
      </div>
      <div className="grid grid-cols-3 gap-2">
        <TinyMetric label="BTC" value={Number(wallet.btc).toFixed(4)} tone="zinc" />
        <TinyMetric label="USD eq." value={`$${wallet.usdt}`} tone="emerald" />
        <TinyMetric label="Move Cost" value={`$${wallet.rebalancingCostUsd}`} tone="amber" />
      </div>
    </div>
  );
}

function WalletSeedEditor({
  seed,
  update
}: {
  seed: WalletSeed;
  update: (exchange: ExchangeId, asset: "btc" | "usdt", value: string) => void;
}) {
  return (
    <div className="grid gap-2">
      {exchanges.map((exchange) => (
        <div key={exchange} className="grid grid-cols-[70px_1fr_1fr] items-center gap-2">
          <span className="text-xs font-black text-zinc-600">{EXCHANGE_LABELS[exchange]}</span>
          <input
            className="min-w-0 rounded-lg border border-violet-100 bg-white px-2 py-1 font-mono text-xs text-zinc-900 outline-none focus:border-violet-300"
            min="0"
            onChange={(event) => update(exchange, "btc", event.target.value)}
            step="0.01"
            type="number"
            value={seed[exchange].btc}
          />
          <input
            className="min-w-0 rounded-lg border border-violet-100 bg-white px-2 py-1 font-mono text-xs text-zinc-900 outline-none focus:border-violet-300"
            min="0"
            onChange={(event) => update(exchange, "usdt", event.target.value)}
            step="100"
            type="number"
            value={seed[exchange].usdt}
          />
        </div>
      ))}
    </div>
  );
}

function TradeRow({ trade }: { trade: Trade }) {
  const positive = Number(trade.pnlUsd) >= 0;
  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-black text-zinc-800">{trade.route}</span>
        <strong className={`font-mono text-sm ${positive ? "text-emerald-600" : "text-rose-600"}`}>${trade.pnlUsd}</strong>
      </div>
      <div className="mt-1 flex items-center justify-between font-mono text-[10px] font-semibold text-zinc-500">
        <span>{trade.type}</span>
        <span>{trade.status} / rebalance ${trade.rebalanceAdjustedPnlUsd}</span>
      </div>
    </div>
  );
}

function DepthSide({ levels, side, title }: { levels: NormalizedOrderBook["bids"]; side: "bid" | "ask"; title: string }) {
  const max = Math.max(...levels.map((level) => Number(level.size)), 0.0001);
  return (
    <div>
      <div className="mb-1 font-mono text-[10px] font-black uppercase text-zinc-500">{title}</div>
      <div className="grid gap-1">
        {levels.slice(0, 5).map((level, index) => (
          <div key={`${level.price}-${index}`} className="relative overflow-hidden rounded-lg bg-zinc-50 px-2 py-1 font-mono text-[10px]">
            <span
              className={`absolute inset-y-0 right-0 ${side === "bid" ? "bg-emerald-400/14" : "bg-rose-400/14"}`}
              style={{ width: `${Math.min(100, Number(level.size) / max * 100)}%` }}
            />
            <span className="relative flex justify-between gap-2">
              <b>{Number(level.price).toLocaleString("en-US", { maximumFractionDigits: 2 })}</b>
              <i className="not-italic text-zinc-500">{Number(level.size).toFixed(4)}</i>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PriceTile({
  flash,
  label,
  tone,
  value
}: {
  flash?: string;
  label: string;
  tone: "emerald" | "rose" | "sky";
  value: string;
}) {
  const flashClass = flash === "up" ? "flash-up" : flash === "down" ? "flash-down" : "";
  return (
    <div className={`rounded-lg border px-2 py-2 ${toneSurface(tone)}`}>
      <span className="block text-[10px] font-black uppercase opacity-70">{label}</span>
      <strong className={`mt-1 block truncate rounded font-mono text-xs ${toneText(tone)} ${flashClass}`}>{formatPrice(value)}</strong>
    </div>
  );
}

function SignalNumber({
  compact = false,
  label,
  tone,
  value
}: {
  compact?: boolean;
  label: string;
  tone: Tone;
  value: string;
}) {
  return (
    <div className={`rounded-lg border bg-white/80 ${compact ? "px-2 py-1.5" : "px-3 py-2"} ${toneBorder(tone)}`}>
      <span className="block text-[9px] font-black uppercase text-zinc-500">{label}</span>
      <strong className={`${compact ? "text-xs" : "text-sm"} block truncate font-mono ${toneText(tone)}`}>{value}</strong>
    </div>
  );
}

function TinyMetric({ label, tone, value }: { label: string; tone: Tone; value: string }) {
  return (
    <div className={`rounded-lg border bg-white/80 px-2 py-2 ${toneBorder(tone)}`}>
      <span className="block text-[9px] font-black uppercase text-zinc-500">{label}</span>
      <strong className={`mt-1 block truncate font-mono text-xs ${toneText(tone)}`}>{value}</strong>
    </div>
  );
}

function HealthStat({ label, tone, value }: { label: string; tone: Tone; value: string }) {
  return (
    <div className={`rounded-xl border bg-white/75 px-3 py-2 ${toneBorder(tone)}`}>
      <span className="block text-[9px] font-black uppercase text-zinc-500">{label}</span>
      <strong className={`mt-1 block font-mono text-sm ${toneText(tone)}`}>{value}</strong>
    </div>
  );
}

function TopMetric({ label, tone, value }: { label: string; tone: Tone; value: string }) {
  return (
    <div className={`w-[84px] rounded-xl border bg-white px-3 py-2 font-mono shadow-sm ${toneBorder(tone)}`}>
      <span className="block text-[9px] font-black uppercase text-zinc-500">{label}</span>
      <strong className={`block text-xs ${toneText(tone)}`}>{value}</strong>
    </div>
  );
}

function SegmentedMode({ mode, setMode }: { mode: "LIVE" | "DEMO"; setMode: (mode: "LIVE" | "DEMO") => void }) {
  return (
    <div className="flex rounded-xl border border-zinc-200 bg-zinc-50 p-1 font-mono text-xs font-black">
      <button
        aria-pressed={mode === "LIVE"}
        className={`rounded-lg px-3 py-2 transition ${mode === "LIVE" ? "bg-white text-sky-700 shadow-sm" : "text-zinc-500 hover:text-zinc-800"}`}
        onClick={() => setMode("LIVE")}
        type="button"
      >
        LIVE
      </button>
      <button
        aria-pressed={mode === "DEMO"}
        className={`rounded-lg px-3 py-2 transition ${mode === "DEMO" ? "bg-white text-violet-700 shadow-sm" : "text-zinc-500 hover:text-zinc-800"}`}
        onClick={() => setMode("DEMO")}
        type="button"
      >
        DEMO
      </button>
    </div>
  );
}

function StatusPill({ label, pulse = false, tone }: { label: string; pulse?: boolean; tone: Tone }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] font-black uppercase ${tonePill(tone)}`}>
      {pulse && <span className={`h-1.5 w-1.5 animate-pulse rounded-full ${toneDot(tone)}`} />}
      {label}
    </span>
  );
}

function Panel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm shadow-sky-100/70 ${className}`}>{children}</div>;
}

function PanelTitle({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div>
      <SectionKicker>{eyebrow}</SectionKicker>
      <h2 className="mt-1 text-lg font-black text-zinc-950">{title}</h2>
    </div>
  );
}

function SectionKicker({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-[10px] font-black uppercase tracking-normal text-sky-700">{children}</span>;
}

function ProgressBar({ tone, value }: { tone: Tone; value: number }) {
  return (
    <div className="mt-3 h-2 overflow-hidden rounded-full bg-zinc-100">
      <div className={`h-full rounded-full ${toneBg(tone)}`} style={{ width: `${Math.max(3, Math.min(100, value))}%` }} />
    </div>
  );
}

function EmptyState({ compact = false, text }: { compact?: boolean; text: string }) {
  return (
    <div className={`rounded-xl border border-dashed border-zinc-200 bg-zinc-50 text-center text-xs font-bold text-zinc-500 ${compact ? "p-3" : "p-5"}`}>
      {text}
    </div>
  );
}

interface StrategyStat {
  averageScore: number;
  bestProfit: number;
  executable: number;
  total: number;
  type: OpportunityType;
}

interface MarketIntel {
  fragmentation: number;
  grossEdge: number;
  microSkewBps: number;
  pressure: number;
  pressureAbs: number;
  regime: "Active" | "Tight" | "Wide";
  route: string;
  survival: number;
}

function buildStrategyStats(opportunities: Opportunity[]): StrategyStat[] {
  return opportunityTypes.map((type) => {
    const matches = opportunities.filter((opportunity) => opportunity.type === type);
    const executable = matches.filter((opportunity) => opportunity.status === "DETECTED" || opportunity.status === "EVALUATING").length;
    const totalScore = matches.reduce((sum, opportunity) => sum + opportunity.score, 0);
    const bestProfit = matches.reduce((best, opportunity) => Math.max(best, Number(opportunity.expectedProfitUsd)), Number.NEGATIVE_INFINITY);
    return {
      averageScore: matches.length ? totalScore / matches.length : 0,
      bestProfit: Number.isFinite(bestProfit) ? bestProfit : 0,
      executable,
      total: matches.length,
      type
    };
  });
}

function buildMarketIntel(books: Record<string, NormalizedOrderBook>, opportunities: Opportunity[]): MarketIntel {
  const btcBooks = exchanges.map((exchange) => books[btcBookKey(exchange)]).filter((book): book is NormalizedOrderBook => Boolean(book));
  const mids = btcBooks.map(midFromBook).filter((value) => value > 0);
  const fragmentation = mids.length > 1 ? Math.max(...mids) - Math.min(...mids) : 0;
  const pressureValues = btcBooks.map(bookImbalance);
  const pressure = pressureValues.length ? pressureValues.reduce((sum, value) => sum + value, 0) / pressureValues.length : 0;
  const microSkews = btcBooks.map(microSkewBps).filter((value) => Number.isFinite(value));
  const microSkew = microSkews.length ? microSkews.reduce((sum, value) => sum + value, 0) / microSkews.length : 0;
  const bestAsk = bestAskBook(btcBooks);
  const bestBid = bestBidBook(btcBooks);
  const grossEdge = bestAsk && bestBid ? bestBid.price - bestAsk.price : 0;
  const route = bestAsk && bestBid ? `${EXCHANGE_LABELS[bestAsk.exchange]} -> ${EXCHANGE_LABELS[bestBid.exchange]}` : "Route warming";
  const recent = opportunities.slice(0, 80);
  const executable = recent.filter((opportunity) => opportunity.status === "DETECTED" || opportunity.status === "EVALUATING").length;
  const survival = recent.length ? executable / recent.length * 100 : 0;
  const regime: MarketIntel["regime"] = fragmentation > 90 ? "Wide" : fragmentation > 20 ? "Active" : "Tight";

  return {
    fragmentation,
    grossEdge,
    microSkewBps: microSkew,
    pressure,
    pressureAbs: Math.abs(pressure),
    regime,
    route,
    survival
  };
}

// Live book batches repaint only the panels that actually consume changing data.
// This keeps charts, journals and controls from rerendering on every websocket pulse.
const MemoTerminalToolbar = memo(TerminalToolbar);
const MemoSystemHealth = memo(SystemHealth);
const MemoMicrostructurePanel = memo(MicrostructurePanel);
const MemoMarketStack = memo(MarketStack);
const MemoPriceChartPanel = memo(PriceChartPanel);
const MemoActiveEdgePanel = memo(ActiveEdgePanel);
const MemoSignalFeed = memo(SignalFeed);
const MemoPerformancePanel = memo(PerformancePanel);
const MemoLearningPanel = memo(LearningPanel);
const MemoExecutionPanel = memo(ExecutionPanel);
const MemoWalletPanel = memo(WalletPanel);

function makePnlSeries(trades: Trade[]): Array<{ index: number; pnl: number }> {
  return trades
    .slice()
    .reverse()
    .reduce<Array<{ index: number; pnl: number }>>((series, trade, index) => {
      const previous = series.at(-1)?.pnl ?? 0;
      series.push({ index: index + 1, pnl: previous + Number(trade.pnlUsd) });
      return series;
    }, [{ index: 0, pnl: 0 }]);
}

function summarizeWallets(wallets: WalletBalance[]): { btc: number; rebalanceCount: number; usdt: number } {
  return wallets.reduce(
    (sum, wallet) => ({
      btc: sum.btc + Number(wallet.btc),
      rebalanceCount: sum.rebalanceCount + (wallet.rebalancingNeeded ? 1 : 0),
      usdt: sum.usdt + Number(wallet.usdt)
    }),
    { btc: 0, rebalanceCount: 0, usdt: 0 }
  );
}

function midFromBook(book?: NormalizedOrderBook): number {
  const bid = Number(book?.bids[0]?.price ?? 0);
  const ask = Number(book?.asks[0]?.price ?? 0);
  return bid && ask ? (bid + ask) / 2 : 0;
}

function bookImbalance(book: NormalizedOrderBook): number {
  const bidDepth = sumSize(book.bids);
  const askDepth = sumSize(book.asks);
  const total = bidDepth + askDepth;
  return total ? (bidDepth - askDepth) / total * 100 : 0;
}

function microSkewBps(book: NormalizedOrderBook): number {
  const bidPrice = Number(book.bids[0]?.price ?? 0);
  const askPrice = Number(book.asks[0]?.price ?? 0);
  const bidSize = Number(book.bids[0]?.size ?? 0);
  const askSize = Number(book.asks[0]?.size ?? 0);
  const total = bidSize + askSize;
  if (!bidPrice || !askPrice || !total) return 0;
  const mid = (bidPrice + askPrice) / 2;
  const microprice = (bidPrice * askSize + askPrice * bidSize) / total;
  return mid ? (microprice - mid) / mid * 10000 : 0;
}

function sumSize(levels: NormalizedOrderBook["bids"]): number {
  return levels.slice(0, 5).reduce((sum, level) => sum + Number(level.size), 0);
}

function opportunityTouchesExchange(opportunity: Opportunity, visibleExchanges: ExchangeId[]): boolean {
  if (opportunity.buyExchange && !visibleExchanges.includes(opportunity.buyExchange)) return false;
  if (opportunity.sellExchange && !visibleExchanges.includes(opportunity.sellExchange)) return false;
  if (opportunity.exchange && !visibleExchanges.includes(opportunity.exchange)) return false;
  return true;
}

function toggleAtLeastOne<T>(items: T[], item: T): T[] {
  if (!items.includes(item)) return [...items, item];
  return items.length > 1 ? items.filter((candidate) => candidate !== item) : items;
}

function toggleAtLeastTwo(items: ExchangeId[], item: ExchangeId): ExchangeId[] {
  if (!items.includes(item)) return [...items, item];
  return items.length > 2 ? items.filter((candidate) => candidate !== item) : items;
}

function bestAskBook(books: NormalizedOrderBook[]): { exchange: ExchangeId; price: number } | null {
  return books.reduce<{ exchange: ExchangeId; price: number } | null>((best, book) => {
    const price = Number(book.asks[0]?.price ?? 0);
    if (!price) return best;
    if (!best || price < best.price) return { exchange: book.exchange, price };
    return best;
  }, null);
}

function bestBidBook(books: NormalizedOrderBook[]): { exchange: ExchangeId; price: number } | null {
  return books.reduce<{ exchange: ExchangeId; price: number } | null>((best, book) => {
    const price = Number(book.bids[0]?.price ?? 0);
    if (!price) return best;
    if (!best || price > best.price) return { exchange: book.exchange, price };
    return best;
  }, null);
}

function formatAge(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatPrice(value: string): string {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return value;
  return numberValue.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

type Tone = "amber" | "emerald" | "green" | "rose" | "sky" | "violet" | "zinc";

function riskTone(riskColor: RiskState["riskColor"]): Tone {
  if (riskColor === "RED") return "rose";
  if (riskColor === "AMBER") return "amber";
  return "green";
}

function statusLabel(status: "ALL" | "EXECUTABLE" | "REJECTED"): string {
  if (status === "EXECUTABLE") return "Ejecutables";
  if (status === "REJECTED") return "Descartadas";
  return "Todas";
}

function regimeLabel(regime: MarketIntel["regime"]): string {
  if (regime === "Wide") return "Disperso";
  if (regime === "Tight") return "Compacto";
  return "Activo";
}

function opportunityTone(type: OpportunityType): Tone {
  if (type === "STAT_ARB") return "emerald";
  if (type === "TRIANGULAR") return "amber";
  return "sky";
}

function statusTone(status: Opportunity["status"]): Tone {
  if (status === "DETECTED" || status === "EXECUTED") return "emerald";
  if (status === "EVALUATING") return "amber";
  if (status === "REJECTED" || status === "EXPIRED") return "rose";
  return "sky";
}

function learningLabelTone(label: NonNullable<LearningSummary["lastOutcome"]>["label"]): Tone {
  if (label === "MISSED_PROFIT") return "amber";
  if (label === "AVOIDED_LOSS" || label === "CONFIRMED_EDGE") return "emerald";
  if (label === "FALSE_POSITIVE") return "rose";
  return "zinc";
}

function rejectCause(opportunity: Opportunity): string {
  const reason = opportunity.reason.toLowerCase();
  if (reason.includes("circuit")) return "breaker";
  if (reason.includes("quote skew") || reason.includes("stale")) return "stale quote";
  if (reason.includes("impact") || opportunity.highImpact) return "liquidity";
  if (reason.includes("survival") || reason.includes("adverse")) return "adverse";
  if (Number(opportunity.netSpreadPct) < 0) return "fees";
  return "threshold";
}

function statusDot(status?: ExchangeConnectionStatus["status"]): string {
  if (status === "live" || status === "polling") return "bg-emerald-500";
  if (status === "error") return "bg-rose-500";
  return "bg-amber-500";
}

function riskColorClass(riskColor: RiskState["riskColor"]): string {
  if (riskColor === "RED") return "text-rose-600";
  if (riskColor === "AMBER") return "text-amber-600";
  return "text-emerald-600";
}

function toneText(tone: Tone): string {
  const map: Record<Tone, string> = {
    amber: "text-amber-700",
    emerald: "text-emerald-700",
    green: "text-emerald-700",
    rose: "text-rose-700",
    sky: "text-sky-700",
    violet: "text-violet-700",
    zinc: "text-zinc-800"
  };
  return map[tone];
}

function toneBorder(tone: Tone): string {
  const map: Record<Tone, string> = {
    amber: "border-amber-100",
    emerald: "border-emerald-100",
    green: "border-emerald-100",
    rose: "border-rose-100",
    sky: "border-sky-100",
    violet: "border-violet-100",
    zinc: "border-zinc-200"
  };
  return map[tone];
}

function toneSurface(tone: Tone): string {
  const map: Record<Tone, string> = {
    amber: "border-amber-100 bg-amber-50/80 text-amber-700",
    emerald: "border-emerald-100 bg-emerald-50/80 text-emerald-700",
    green: "border-emerald-100 bg-emerald-50/80 text-emerald-700",
    rose: "border-rose-100 bg-rose-50/80 text-rose-700",
    sky: "border-sky-100 bg-sky-50/80 text-sky-700",
    violet: "border-violet-100 bg-violet-50/80 text-violet-700",
    zinc: "border-zinc-200 bg-zinc-50 text-zinc-800"
  };
  return map[tone];
}

function tonePill(tone: Tone): string {
  const map: Record<Tone, string> = {
    amber: "border-amber-200 bg-amber-50 text-amber-700",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-700",
    green: "border-emerald-200 bg-emerald-50 text-emerald-700",
    rose: "border-rose-200 bg-rose-50 text-rose-700",
    sky: "border-sky-200 bg-sky-50 text-sky-700",
    violet: "border-violet-200 bg-violet-50 text-violet-700",
    zinc: "border-zinc-200 bg-zinc-50 text-zinc-700"
  };
  return map[tone];
}

function toneDot(tone: Tone): string {
  const map: Record<Tone, string> = {
    amber: "bg-amber-500",
    emerald: "bg-emerald-500",
    green: "bg-emerald-500",
    rose: "bg-rose-500",
    sky: "bg-sky-500",
    violet: "bg-violet-500",
    zinc: "bg-zinc-500"
  };
  return map[tone];
}

function toneBg(tone: Tone): string {
  const map: Record<Tone, string> = {
    amber: "bg-amber-400",
    emerald: "bg-emerald-400",
    green: "bg-emerald-400",
    rose: "bg-rose-400",
    sky: "bg-sky-400",
    violet: "bg-violet-400",
    zinc: "bg-zinc-400"
  };
  return map[tone];
}
