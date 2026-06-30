"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useArbitrageStore } from "@/store/useArbitrageStore";
import type { OpportunityType } from "@/lib/types";
import { IconCrown, IconTrendUp } from "@/components/icons";

const STRATEGIES: OpportunityType[] = ["CROSS_EXCHANGE", "TRIANGULAR", "STAT_ARB", "LATENCY_ARB"];

const META: Record<OpportunityType, { label: string; blurb: string; tone: string; accent: string; bar: string }> = {
  CROSS_EXCHANGE: { label: "Cross-Exchange", blurb: "Compra barato en un venue, vende caro en otro", tone: "sky", accent: "text-sky-700", bar: "from-sky-400 to-sky-300" },
  TRIANGULAR: { label: "Triangular", blurb: "Ciclo BTC → USDT → ETH → BTC", tone: "amber", accent: "text-amber-700", bar: "from-amber-400 to-amber-300" },
  STAT_ARB: { label: "Stat-Arb", blurb: "Reversión a la media con gate de cointegración", tone: "emerald", accent: "text-emerald-700", bar: "from-emerald-400 to-emerald-300" },
  LATENCY_ARB: { label: "Latencia", blurb: "Levanta una cotización rancia contra una fresca", tone: "violet", accent: "text-violet-700", bar: "from-violet-400 to-violet-300" }
};

const RANK_STYLE = [
  "border-amber-300 bg-gradient-to-b from-amber-100 to-amber-200 text-amber-800",
  "border-zinc-300 bg-gradient-to-b from-zinc-100 to-zinc-200 text-zinc-700",
  "border-orange-300 bg-gradient-to-b from-orange-100 to-orange-200 text-orange-800",
  "border-zinc-200 bg-zinc-50 text-zinc-400"
];

interface Tally {
  trades: number;
  wins: number;
  pnl: number;
  detected: number;
  streak: number;
}
interface Standing extends Tally {
  type: OpportunityType;
  rank: number;
  delta: number; // previous rank - current rank (positive = climbed)
}

function emptyTally(): Tally {
  return { trades: 0, wins: 0, pnl: 0, detected: 0, streak: 0 };
}

export function StrategyTournament() {
  const init = useArbitrageStore((state) => state.init);
  const trades = useArbitrageStore((state) => state.trades);
  const opportunities = useArbitrageStore((state) => state.opportunities);
  const executionQueue = useArbitrageStore((state) => state.executionQueue);
  const mode = useArbitrageStore((state) => state.mode);

  const acc = useRef<Record<OpportunityType, Tally>>({
    CROSS_EXCHANGE: emptyTally(), TRIANGULAR: emptyTally(), STAT_ARB: emptyTally(), LATENCY_ARB: emptyTally()
  });
  const seenTrades = useRef<Set<string>>(new Set());
  const seenDetected = useRef<Set<string>>(new Set());
  const prevRank = useRef<Record<OpportunityType, number>>({ CROSS_EXCHANGE: 1, TRIANGULAR: 2, STAT_ARB: 3, LATENCY_ARB: 4 });
  const [standings, setStandings] = useState<Standing[]>([]);

  useEffect(() => {
    init();
  }, [init]);

  // Reset the season when the data source changes (DEMO <-> LIVE clears trades).
  useEffect(() => {
    acc.current = { CROSS_EXCHANGE: emptyTally(), TRIANGULAR: emptyTally(), STAT_ARB: emptyTally(), LATENCY_ARB: emptyTally() };
    seenTrades.current = new Set();
    seenDetected.current = new Set();
    prevRank.current = { CROSS_EXCHANGE: 1, TRIANGULAR: 2, STAT_ARB: 3, LATENCY_ARB: 4 };
    setStandings([]);
  }, [mode]);

  useEffect(() => {
    // Accumulate filled paper trades (newest-first, windowed) by id so the season
    // total is a true cumulative tally regardless of the store's rolling window.
    for (const trade of trades) {
      if (trade.status === "REJECTED") continue;
      if (seenTrades.current.has(trade.id)) continue;
      seenTrades.current.add(trade.id);
      const tally = acc.current[trade.type];
      const pnl = Number(trade.pnlUsd);
      tally.trades += 1;
      tally.pnl += pnl;
      if (pnl > 0) tally.wins += 1;
      // Every fill came from a detected signal: count it so "señales" >= fills.
      if (!seenDetected.current.has(trade.opportunityId)) {
        seenDetected.current.add(trade.opportunityId);
        tally.detected += 1;
      }
    }
    // Current win streak per strategy from the live (newest-first) trade list.
    for (const type of STRATEGIES) {
      let streak = 0;
      for (const trade of trades) {
        if (trade.type !== type || trade.status === "REJECTED") continue;
        if (Number(trade.pnlUsd) > 0) streak += 1;
        else break;
      }
      acc.current[type].streak = streak;
    }
    recompute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trades]);

  useEffect(() => {
    // Count detected signals from both the live opportunity feed and the execution
    // queue: in DEMO an executable signal is queued immediately and may never sit
    // in the opportunity list as DETECTED, so the queue is the reliable source.
    const detectedNow = [...opportunities.filter((o) => o.status === "DETECTED"), ...executionQueue];
    for (const opportunity of detectedNow) {
      if (seenDetected.current.has(opportunity.id)) continue;
      seenDetected.current.add(opportunity.id);
      acc.current[opportunity.type].detected += 1;
    }
    recompute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opportunities, executionQueue]);

  function recompute(): void {
    const ranked = STRATEGIES.map((type) => ({ type, ...acc.current[type] }))
      .sort((a, b) => b.pnl - a.pnl || b.wins - a.wins || b.trades - a.trades || b.detected - a.detected)
      .map((entry, index) => {
        const rank = index + 1;
        const delta = prevRank.current[entry.type] - rank;
        return { ...entry, rank, delta };
      });
    ranked.forEach((entry) => {
      prevRank.current[entry.type] = entry.rank;
    });
    setStandings(ranked);
  }

  const view = standings.length ? standings : STRATEGIES.map((type, i) => ({ type, rank: i + 1, delta: 0, ...emptyTally() }));
  const maxAbsPnl = useMemo(() => Math.max(1, ...view.map((s) => Math.abs(s.pnl))), [view]);
  const leader = view[0];
  const anyActivity = view.some((s) => s.trades > 0 || s.detected > 0);

  return (
    <div className="rounded-3xl border border-zinc-200/70 bg-white/80 p-5 backdrop-blur-sm elev sm:p-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="live-dot inline-block h-2 w-2 rounded-full bg-emerald-500" />
          <span className="font-mono text-[10px] font-black uppercase tracking-[0.16em] text-sky-700">
            Torneo de estrategias · {mode}
          </span>
        </div>
        <span className="rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1 font-mono text-[10px] font-black uppercase tracking-wider text-zinc-600">
          temporada en vivo
        </span>
      </div>

      {/* Leader spotlight */}
      <div className={`mt-4 flex flex-col gap-3 rounded-2xl border p-5 sm:flex-row sm:items-center sm:justify-between ${toneBox(META[leader.type].tone)}`}>
        <div className="flex items-center gap-3">
          <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl border ${anyActivity ? "border-amber-300 bg-amber-100 text-amber-700" : "border-zinc-200 bg-zinc-100 text-zinc-400"}`}>
            <IconCrown className="h-5 w-5" />
          </span>
          <div>
            <span className="block font-mono text-[9px] font-black uppercase tracking-wider opacity-70">Líder de la temporada</span>
            <strong className="block text-xl font-black tracking-tight text-zinc-950 sm:text-2xl">
              {anyActivity ? META[leader.type].label : "Esperando señales…"}
            </strong>
            <span className="text-[11px] font-semibold text-zinc-500">{META[leader.type].blurb}</span>
          </div>
        </div>
        <div className="text-left sm:text-right">
          <span className="block font-mono text-[9px] font-black uppercase tracking-wider opacity-70">P&L de temporada</span>
          <strong className={`font-mono text-2xl font-black tabular-nums sm:text-3xl ${leader.pnl >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
            {leader.pnl >= 0 ? "+" : ""}{leader.pnl.toFixed(2)} <span className="text-base">USD</span>
          </strong>
        </div>
      </div>

      {/* Standings */}
      <div className="mt-4 space-y-2.5">
        {view.map((entry) => {
          const meta = META[entry.type];
          const barPct = Math.max(3, (Math.abs(entry.pnl) / maxAbsPnl) * 100);
          const winRate = entry.trades ? Math.round((entry.wins / entry.trades) * 100) : 0;
          return (
            <div
              key={entry.type}
              className={`grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-2xl border px-3 py-3 transition-all duration-500 sm:px-4 ${
                entry.rank === 1 && anyActivity ? toneBox(meta.tone) : "border-zinc-200/70 bg-white/70"
              }`}
            >
              <div className="flex w-10 flex-col items-center">
                <span className={`grid h-8 w-8 place-items-center rounded-lg border font-mono text-sm font-black ${RANK_STYLE[entry.rank - 1]}`}>
                  {entry.rank}
                </span>
                {entry.delta !== 0 && (
                  <span className={`mt-0.5 font-mono text-[9px] font-black ${entry.delta > 0 ? "text-emerald-600" : "text-rose-500"}`}>
                    {entry.delta > 0 ? `▲${entry.delta}` : `▼${Math.abs(entry.delta)}`}
                  </span>
                )}
              </div>

              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <strong className={`truncate text-sm font-black tracking-tight ${meta.accent}`}>{meta.label}</strong>
                  {entry.streak >= 2 && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-orange-50 px-1.5 py-0.5 font-mono text-[9px] font-black text-orange-700">
                      <IconTrendUp className="h-2.5 w-2.5" strokeWidth={2.5} />
                      {entry.streak}
                    </span>
                  )}
                </div>
                <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-zinc-100">
                  <div
                    className={`h-full rounded-full bg-gradient-to-r transition-all duration-700 ${entry.pnl >= 0 ? meta.bar : "from-rose-400 to-rose-300"}`}
                    style={{ width: `${barPct}%` }}
                  />
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] font-semibold text-zinc-500">
                  <span>{entry.trades} fills</span>
                  <span>{winRate}% win</span>
                  <span>{entry.detected} señales</span>
                </div>
              </div>

              <div className="text-right">
                <strong className={`block font-mono text-base font-black tabular-nums sm:text-lg ${entry.pnl >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                  {entry.pnl >= 0 ? "+" : ""}{entry.pnl.toFixed(2)}
                </strong>
                <span className="font-mono text-[9px] font-bold uppercase tracking-wider text-zinc-400">USD</span>
              </div>
            </div>
          );
        })}
      </div>

      <p className="mt-4 text-[11px] font-semibold leading-5 text-zinc-500">
        Cada estrategia compite con su <span className="text-zinc-700">P&L de paper trading real</span> de esta sesión (no simulado aparte).
        El ranking se reordena en vivo conforme el motor ejecuta. En <span className="font-mono">DEMO</span> dominan Cross y Triangular;
        Stat-Arb y Latencia despiertan con dislocaciones y feeds rezagados del modo <span className="font-mono">LIVE</span>.
      </p>
    </div>
  );
}

function toneBox(tone: string): string {
  const map: Record<string, string> = {
    sky: "border-sky-200 bg-gradient-to-br from-sky-50 via-white to-white",
    amber: "border-amber-200 bg-gradient-to-br from-amber-50 via-white to-white",
    emerald: "border-emerald-200 bg-gradient-to-br from-emerald-50 via-white to-white",
    violet: "border-violet-200 bg-gradient-to-br from-violet-50 via-white to-white"
  };
  return map[tone] ?? "border-zinc-200 bg-white";
}
