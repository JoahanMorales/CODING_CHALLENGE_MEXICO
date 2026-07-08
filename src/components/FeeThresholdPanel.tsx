"use client";

import { useEffect, useState } from "react";

// Renders public/data/fee-threshold.json (scripts/feeThresholdSweep.ts): the real
// cross-venue gross-spread distribution re-priced across a sweep of hypothetical
// round-trip fees, turning "untradeable at retail fees" into a hard threshold --
// exactly how low fees would have to go, and which venue tier (if any) gets there.

interface FeeTier { name: string; roundTripBps: number; profitablePct: number }
interface CurvePoint { roundTripFeeBps: number; profitablePct: number; netPnlUsd: number; grossPnlUsd: number }
interface FeeThreshold {
  tape: string;
  rounds: number;
  crossDislocations: number;
  grossSpreadBps: { min: number; p50: number; p95: number; max: number };
  meanRetailRoundTripFeeBps: number;
  breakEvenFeeBps: { forHalfProfitable: number; forTop5Profitable: number };
  feeTiers: FeeTier[];
  curve: CurvePoint[];
  verdict: string;
}

const usd = (n: number) => (Math.abs(n) >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${Math.round(n)}`);

function Metric({ label, value, tone }: { label: string; value: string; tone: "sky" | "emerald" | "rose" | "amber" }) {
  const tones: Record<string, string> = {
    sky: "border-sky-200 bg-sky-50/60 text-sky-700",
    emerald: "border-emerald-200 bg-emerald-50/60 text-emerald-700",
    rose: "border-rose-200 bg-rose-50/60 text-rose-700",
    amber: "border-amber-200 bg-amber-50/60 text-amber-700"
  };
  return (
    <div className={`rounded-2xl border p-3 ${tones[tone]}`}>
      <p className="font-mono text-[9px] font-black uppercase tracking-wider opacity-80">{label}</p>
      <p className="mt-1 text-lg font-black tabular-nums text-zinc-900">{value}</p>
    </div>
  );
}

export function FeeThresholdPanel() {
  const [data, setData] = useState<FeeThreshold | null>(null);

  useEffect(() => {
    let active = true;
    void fetch("/data/fee-threshold.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => { if (active && json) setData(json as FeeThreshold); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  if (!data) return null;

  const maxPct = Math.max(1, ...data.curve.map((c) => c.profitablePct));
  const retail = data.meanRetailRoundTripFeeBps;

  return (
    <div className="mt-8 rounded-3xl border border-zinc-200/70 bg-white/80 p-6 backdrop-blur-sm elev sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] font-black uppercase tracking-[0.16em] text-sky-700">
            Umbral de rentabilidad · ¿a qué fee dejaría de ser ruinoso?
          </p>
          <h2 className="mt-2 text-2xl font-black tracking-tight text-zinc-950 sm:text-3xl">
            El mercado ya descontó el arbitraje. Mira el fee que necesitarías.
          </h2>
        </div>
        <span className="rounded-full border border-rose-200 bg-rose-50 px-3 py-1 font-mono text-[10px] font-black uppercase tracking-wider text-rose-700">
          {data.crossDislocations.toLocaleString()} dislocaciones reales
        </span>
      </div>

      <p className="mt-3 max-w-3xl text-sm font-semibold leading-6 text-zinc-500">
        Reprocesamos cada dislocación cross-venue del tape con su <strong className="text-zinc-800">spread bruto</strong> (antes de fees) y la
        re-precificamos a un barrido de tarifas round-trip: <code className="rounded bg-zinc-100 px-1 font-mono text-[11px]">neto = bruto − fee</code>.
        Así la tesis cualitativa se vuelve un número: la mediana del edge bruto es apenas{" "}
        <strong className="text-zinc-800">{data.grossSpreadBps.p50} bps</strong>, así que necesitarías un fee round-trip{" "}
        <strong className="text-rose-600">≤ {data.breakEvenFeeBps.forHalfProfitable} bps</strong> para que la mitad de las dislocaciones fueran
        rentables — muy por debajo del retail (~{retail.toFixed(0)} bps efectivos).
      </p>

      <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Metric label="Edge bruto (mediana)" value={`${data.grossSpreadBps.p50} bps`} tone="amber" />
        <Metric label="Edge bruto (p95)" value={`${data.grossSpreadBps.p95} bps`} tone="sky" />
        <Metric label="Fee retail efectivo" value={`${retail.toFixed(0)} bps`} tone="rose" />
        <Metric label="Break-even (mitad)" value={`≤ ${data.breakEvenFeeBps.forHalfProfitable} bps`} tone="emerald" />
      </div>

      <p className="mt-5 font-mono text-[9px] font-black uppercase tracking-wider text-sky-700">
        Curva de eficiencia — % de dislocaciones rentables según el fee round-trip
      </p>
      <div className="mt-3 space-y-1.5">
        {data.curve.map((c) => {
          const good = c.profitablePct >= 50;
          const mid = c.profitablePct > 0 && c.profitablePct < 50;
          return (
            <div key={c.roundTripFeeBps} className="grid grid-cols-[minmax(0,90px)_1fr_auto] items-center gap-2.5">
              <span className="font-mono text-[11px] font-bold tabular-nums text-zinc-600">
                {c.roundTripFeeBps > 0 ? `${c.roundTripFeeBps} bps` : c.roundTripFeeBps === 0 ? "0 (sin fee)" : `${c.roundTripFeeBps} (rebate)`}
              </span>
              <div className="h-3 w-full overflow-hidden rounded-full bg-zinc-100">
                <div
                  className={`h-full rounded-full ${good ? "bg-gradient-to-r from-emerald-500 to-emerald-300" : mid ? "bg-gradient-to-r from-amber-400 to-amber-300" : "bg-gradient-to-r from-rose-400 to-rose-300"}`}
                  style={{ width: `${Math.max(2, (c.profitablePct / maxPct) * 100)}%` }}
                />
              </div>
              <span className="font-mono text-[10px] font-bold tabular-nums text-zinc-500">
                {c.profitablePct}% · {usd(c.netPnlUsd)}
              </span>
            </div>
          );
        })}
      </div>

      <p className="mt-5 font-mono text-[9px] font-black uppercase tracking-wider text-zinc-500">
        ¿Qué tier de fee real llega ahí?
      </p>
      <div className="mt-2 overflow-x-auto rounded-xl border border-zinc-200">
        <table className="w-full min-w-[420px] text-left">
          <thead>
            <tr className="bg-zinc-100/70 font-mono text-[9px] font-black uppercase tracking-wider text-zinc-500">
              <th className="px-3 py-2">Estructura de fee</th>
              <th className="px-3 py-2 text-right">Round-trip</th>
              <th className="px-3 py-2 text-right">% rentable</th>
            </tr>
          </thead>
          <tbody className="font-mono text-[11px] font-bold text-zinc-700">
            {data.feeTiers.map((t) => (
              <tr key={t.name} className="border-t border-zinc-100">
                <td className="px-3 py-1.5 font-sans font-semibold text-zinc-700">{t.name}</td>
                <td className="px-3 py-1.5 text-right text-zinc-500">{t.roundTripBps} bps</td>
                <td className={`px-3 py-1.5 text-right ${t.profitablePct >= 50 ? "text-emerald-600" : t.profitablePct > 0 ? "text-amber-600" : "text-rose-500"}`}>
                  {t.profitablePct}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 rounded-2xl border border-rose-200/70 bg-gradient-to-br from-rose-50/40 via-white to-white p-5">
        <p className="font-mono text-[9px] font-black uppercase tracking-wider text-rose-700">Lectura honesta</p>
        <p className="mt-2 text-sm font-semibold leading-6 text-zinc-700">{data.verdict}</p>
        <p className="mt-3 text-[11px] font-semibold leading-5 text-zinc-500">
          El edge existe en el spread bruto, pero es tan chico que solo un maker con rebates en ambas patas lo tocaría — y eso ya no es
          arbitraje sin riesgo, es market-making con riesgo de inventario. Por eso la ejecución se mantiene gateada.
        </p>
      </div>

      <p className="mt-4 font-mono text-[9px] font-semibold uppercase tracking-wider text-zinc-400">
        Reproducible: npm run study:fee &lt;tape&gt; public/data/fee-threshold.json
      </p>
    </div>
  );
}
