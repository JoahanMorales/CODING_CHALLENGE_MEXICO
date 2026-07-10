"use client";

import { EXCHANGE_IDS } from "@/lib/config/exchanges";
import { useArbitrageStore } from "@/store/useArbitrageStore";

// A prominent live scoreboard pinned to the top of the terminal: cumulative net
// P&L, opportunities detected vs executed, win rate, and the most recent capture.
// Everything a judge should read in three seconds -- this bot detects, executes,
// and the P&L is right there, updating in real time. Reads the same store the rest
// of the terminal renders from, so it never drifts.

function fmtUsd(value: string | number): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "$0";
  const sign = n < 0 ? "−" : "+";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "emerald" | "sky" | "amber" }) {
  const color = tone === "emerald" ? "text-emerald-300" : tone === "sky" ? "text-sky-300" : tone === "amber" ? "text-amber-300" : "text-white/85";
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="font-mono text-[9px] font-black uppercase tracking-[0.15em] text-white/40">{label}</span>
      <span className={`font-mono text-sm font-black tabular-nums ${color}`}>{value}</span>
    </div>
  );
}

export function TerminalHero() {
  const metrics = useArbitrageStore((state) => state.metrics);
  const latest = useArbitrageStore((state) => state.trades[0]);
  const net = Number(metrics.netPnlUsd);
  const positive = net >= 0;

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-white/10 bg-[#070b16] px-4 py-2.5 sm:px-6">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[9px] font-black uppercase tracking-[0.18em] text-white/40">P&amp;L neto acumulado</span>
        <span className={`font-mono text-xl font-black tabular-nums ${positive ? "text-emerald-400" : "text-rose-400"}`}>
          {fmtUsd(metrics.netPnlUsd)}
        </span>
      </div>
      <Stat label="Detectadas" value={metrics.opportunitiesDetected.toLocaleString("en-US")} tone="sky" />
      <Stat label="Ejecutadas" value={metrics.tradesExecuted.toLocaleString("en-US")} tone="emerald" />
      <Stat label="Win rate" value={`${metrics.winRatePct}%`} />
      <Stat label="Mejor" value={fmtUsd(metrics.bestTradeUsd)} tone="emerald" />
      {latest ? (
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <span className="live-dot inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
          <span className="hidden font-mono text-[10px] font-bold uppercase tracking-wider text-white/40 sm:inline">Última captura</span>
          <span className="max-w-[220px] truncate font-mono text-[11px] font-bold text-white/80">{latest.route}</span>
          <span className={`font-mono text-[12px] font-black tabular-nums ${Number(latest.pnlUsd) >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
            {fmtUsd(latest.pnlUsd)}
          </span>
        </div>
      ) : (
        <span className="ml-auto flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-wider text-white/35">
          <span className="live-dot inline-block h-1.5 w-1.5 rounded-full bg-sky-400" />
          Escaneando {EXCHANGE_IDS.length} exchanges en vivo…
        </span>
      )}
    </div>
  );
}
