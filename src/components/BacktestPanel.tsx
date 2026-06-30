"use client";

import { useEffect, useState } from "react";

interface Backtest {
  ticks: number;
  bankrollStartUsd: number;
  trades: number;
  winRatePct: number;
  netPnlUsd: number;
  returnOnBankrollPct: number;
  profitFactor: number | null;
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
  sharpeLike: number;
  circuitBreakerTrips: number;
  bestTradeUsd: number;
  worstTradeUsd: number;
  perStrategy: Record<string, { trades: number; pnl: number }>;
  equityCurve: Array<{ i: number; equity: number; pnl: number }>;
}

const STRAT_LABEL: Record<string, string> = {
  CROSS_EXCHANGE: "Cross", TRIANGULAR: "Triangular", STAT_ARB: "Stat-Arb", LATENCY_ARB: "Latencia"
};

export function BacktestPanel() {
  const [bt, setBt] = useState<Backtest | null>(null);

  useEffect(() => {
    let active = true;
    void fetch("/data/backtest.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (active && j) setBt(j as Backtest);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  if (!bt || !bt.equityCurve.length) return null;

  // Equity curve geometry.
  const W = 720;
  const H = 200;
  const pad = 8;
  const pnls = bt.equityCurve.map((p) => p.pnl);
  const minP = Math.min(0, ...pnls);
  const maxP = Math.max(0, ...pnls);
  const span = Math.max(1, maxP - minP);
  const n = bt.equityCurve.length;
  const x = (idx: number) => pad + (idx / Math.max(1, n - 1)) * (W - 2 * pad);
  const y = (p: number) => H - pad - ((p - minP) / span) * (H - 2 * pad);
  const line = bt.equityCurve.map((p, idx) => `${idx === 0 ? "M" : "L"}${x(idx).toFixed(1)},${y(p.pnl).toFixed(1)}`).join(" ");
  const area = `${line} L${x(n - 1).toFixed(1)},${y(minP).toFixed(1)} L${x(0).toFixed(1)},${y(minP).toFixed(1)} Z`;
  const zeroY = y(0).toFixed(1);

  return (
    <div className="mt-8 rounded-3xl border border-zinc-200/70 bg-white/80 p-6 backdrop-blur-sm elev sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] font-black uppercase tracking-[0.16em] text-sky-700">Backtest de paper trading</p>
          <h2 className="mt-2 text-2xl font-black tracking-tight text-zinc-950 sm:text-3xl">Curva de equity con el modelo de costos real.</h2>
        </div>
        <span className="rounded-full border border-zinc-300 bg-zinc-50 px-3 py-1 font-mono text-[10px] font-black uppercase tracking-wider text-zinc-600">
          Simulación · no es P&L en vivo
        </span>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        <Metric label="P&L neto" value={`${bt.netPnlUsd >= 0 ? "+" : ""}$${bt.netPnlUsd.toLocaleString()}`} tone={bt.netPnlUsd >= 0 ? "emerald" : "rose"} />
        <Metric label="Win rate" value={`${bt.winRatePct}%`} tone="emerald" />
        <Metric label="Sharpe-like" value={bt.sharpeLike.toFixed(2)} tone="sky" />
        <Metric label="Max drawdown" value={`$${bt.maxDrawdownUsd.toLocaleString()}`} tone="amber" />
        <Metric label="Profit factor" value={bt.profitFactor ? bt.profitFactor.toFixed(2) : "∞"} tone="sky" />
        <Metric label="Trades" value={bt.trades.toLocaleString()} tone="zinc" />
      </div>

      <div className="mt-5 rounded-2xl border border-zinc-200/70 bg-gradient-to-b from-emerald-50/30 to-white p-4">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-44 w-full" preserveAspectRatio="none" role="img" aria-label="Curva de P&L acumulado">
          <defs>
            <linearGradient id="btfill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgb(16 185 129)" stopOpacity="0.22" />
              <stop offset="100%" stopColor="rgb(16 185 129)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <line x1={pad} y1={zeroY} x2={W - pad} y2={zeroY} stroke="rgb(212 212 216)" strokeWidth="1" strokeDasharray="4 4" />
          <path d={area} fill="url(#btfill)" />
          <path d={line} fill="none" stroke="rgb(5 150 105)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
        <div className="mt-1 flex justify-between font-mono text-[9px] font-bold uppercase tracking-wider text-zinc-400">
          <span>inicio · capital ${bt.bankrollStartUsd.toLocaleString()}</span>
          <span>{bt.ticks.toLocaleString()} ticks · {bt.circuitBreakerTrips} cortes de circuito</span>
          <span>P&L acumulado ({bt.returnOnBankrollPct}% s/capital)</span>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {Object.entries(bt.perStrategy).map(([type, s]) => (
          <span key={type} className="rounded-lg border border-zinc-200 bg-white/70 px-2.5 py-1.5 font-mono text-[10px] font-bold text-zinc-600">
            {STRAT_LABEL[type] ?? type}: {s.trades} · {s.pnl >= 0 ? "+" : ""}${s.pnl.toFixed(0)}
          </span>
        ))}
      </div>

      <p className="mt-4 text-[11px] font-semibold leading-5 text-zinc-500">
        Backtest reproducible (<span className="font-mono">npm run backtest</span>) de un libro de capital compartido sobre un mercado
        fragmentado simulado con expectancy positiva. Cada fill paga fees por venue, √-impacto, slippage, latencia/adverse-selection y
        rebalanceo, y la ejecución respeta el circuit breaker. <strong className="text-zinc-700">Es una simulación, no P&L en vivo</strong> —
        en mercados reales a fees retail el edge cross-exchange no sobrevive (ver evidencia abajo). El valor demostrado aquí es la calidad de
        decisión del motor y su gestión de riesgo, no una promesa de rendimiento.
      </p>
    </div>
  );
}

const toneMap: Record<string, string> = {
  emerald: "border-emerald-200 bg-emerald-50 text-emerald-700",
  rose: "border-rose-200 bg-rose-50 text-rose-700",
  amber: "border-amber-200 bg-amber-50 text-amber-700",
  sky: "border-sky-200 bg-sky-50 text-sky-700",
  zinc: "border-zinc-200 bg-zinc-50 text-zinc-700"
};

function Metric({ label, tone, value }: { label: string; tone: string; value: string }) {
  return (
    <div className={`rounded-xl border px-3 py-2.5 ${toneMap[tone]}`}>
      <span className="block text-[9px] font-black uppercase tracking-wider opacity-70">{label}</span>
      <strong className="mt-0.5 block font-mono text-base font-black leading-tight tracking-tight">{value}</strong>
    </div>
  );
}
