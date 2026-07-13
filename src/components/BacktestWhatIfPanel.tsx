"use client";

import { useEffect, useMemo, useState } from "react";
import { EXCHANGE_LABELS } from "@/lib/config/exchanges";
import { useArbitrageStore } from "@/store/useArbitrageStore";
import type { ExchangeId } from "@/lib/types";

// Interactive what-if backtest. It loads a compact sample of REAL cross-venue
// dislocations (scripts/buildBacktestSample.ts) and re-applies the operator's
// current economic gates — min net edge, fee-stress, slippage tolerance, min
// depth, quote freshness and the active-venue universe — recomputing executable
// trades and estimated net P&L live as the ControlDeck sliders move. It applies
// the same economic gates the engine uses (it does not re-run the ML/AET survival
// committee), so it is an honest lower-bound view of how parametrization changes
// outcomes on recorded real data.

interface Candidate {
  round: number; buy: ExchangeId; sell: ExchangeId; buyAsk: number; sellBid: number;
  grossBps: number; feeBps: number; buyDepth5: number; sellDepth5: number; buyAgeMs: number; sellAgeMs: number;
}
interface Sample {
  tape: string; roundsScanned: number; minGrossBps: number; candidateCount: number; candidates: Candidate[];
}

// Same √-law as feeMath.estimateSlippageRate, expressed in bps of one leg's notional.
function slippageBps(qty: number, depth: number): number {
  if (depth <= 0) return 0.006 * 20000;
  const participation = Math.min(1, qty / depth);
  const rate = Math.min(0.006, 0.0001 + 0.0011 * Math.sqrt(participation));
  return rate * 20000;
}

const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export function BacktestWhatIfPanel() {
  const [sample, setSample] = useState<Sample | null>(null);
  const p = useArbitrageStore((s) => s.engineParams);
  const scannerUniverse = useArbitrageStore((s) => s.scannerUniverse);

  useEffect(() => {
    let active = true;
    void fetch("/data/backtest-tape.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (active && j?.candidates) setSample(j as Sample); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  const activeSet = useMemo(() => new Set(scannerUniverse), [scannerUniverse]);

  const result = useMemo(() => {
    if (!sample) return null;
    const effMinEdge = p.minNetEdgeBps * p.feeStressMultiplier;
    let executable = 0;
    let netUsd = 0;
    let best: { bps: number; buy: ExchangeId; sell: ExchangeId } | null = null;
    for (const c of sample.candidates) {
      if (!activeSet.has(c.buy) || !activeSet.has(c.sell)) continue;
      const depth = Math.min(c.buyDepth5, c.sellDepth5);
      if (depth < p.minDepthBtc) continue;
      if (Math.max(c.buyAgeMs, c.sellAgeMs) > p.maxQuoteAgeMs) continue;
      const qty = Math.min(p.maxTradeSizeBtc, depth * 0.18);
      const slip = slippageBps(qty, depth);
      if (slip > p.maxSlippageBps) continue;
      const netBps = c.grossBps - c.feeBps - slip;
      if (netBps < effMinEdge) continue;
      executable += 1;
      netUsd += (netBps / 10000) * qty * c.buyAsk;
      if (!best || netBps > best.bps) best = { bps: netBps, buy: c.buy, sell: c.sell };
    }
    return { executable, netUsd, best, effMinEdge };
  }, [sample, p, activeSet]);

  if (!sample || !result) return null;

  return (
    <div className="flex-shrink-0 rounded-2xl border border-violet-200/70 bg-gradient-to-br from-violet-50/50 via-white to-white p-4 shadow-sm shadow-violet-100/60">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] font-black uppercase tracking-[0.14em] text-violet-700">Backtest what-if · datos reales</span>
        <span className="font-mono text-[9px] font-black uppercase tracking-wider text-zinc-400">live</span>
      </div>
      <p className="mt-1.5 text-[11px] font-semibold leading-4 text-zinc-500">
        Tus parámetros actuales aplicados sobre <strong className="text-zinc-700">{sample.roundsScanned.toLocaleString()}</strong> rondas reales grabadas. Mueve un slider arriba y mira cómo cambia.
      </p>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded-xl border border-violet-200/60 bg-white/70 p-3">
          <p className="font-mono text-[9px] font-black uppercase tracking-wider text-violet-700">Trades ejecutables</p>
          <p className="mt-0.5 font-mono text-2xl font-black tabular-nums text-zinc-900">{result.executable.toLocaleString()}</p>
          <p className="font-mono text-[9px] text-zinc-400">de {sample.candidateCount.toLocaleString()} dislocaciones</p>
        </div>
        <div className="rounded-xl border border-emerald-200/60 bg-gradient-to-br from-emerald-50/70 to-white p-3">
          <p className="font-mono text-[9px] font-black uppercase tracking-wider text-emerald-700">P&L neto estimado</p>
          <p className={`mt-0.5 font-mono text-2xl font-black tabular-nums ${result.netUsd >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{usd(result.netUsd)}</p>
          <p className="font-mono text-[9px] text-zinc-400">tras fees + slippage</p>
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between rounded-lg bg-zinc-900 px-3 py-1.5">
        <span className="font-mono text-[9px] font-black uppercase tracking-wider text-zinc-400">Mejor captura</span>
        <span className="font-mono text-[11px] font-black tabular-nums text-emerald-400">
          {result.best ? `${EXCHANGE_LABELS[result.best.buy]}→${EXCHANGE_LABELS[result.best.sell]} · +${result.best.bps.toFixed(1)} bps` : "—"}
        </span>
      </div>

      <p className="mt-2 font-mono text-[9px] font-medium leading-tight text-zinc-400">
        Aplica los gates económicos (no el comité ML/AET). Cota inferior honesta del efecto de la parametrización sobre tape real.
      </p>
    </div>
  );
}
