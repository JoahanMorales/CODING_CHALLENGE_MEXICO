"use client";

import { useEffect, useState } from "react";

interface SweepRow {
  threshold: number;
  trades: number;
  winRatePct: number;
  totalPnlUsd: number;
  meanPnlUsd: number;
}

interface OperatingPoint {
  generatedAt: string;
  source: string;
  tape?: string;
  trialsSettled: number;
  detectedByGate: number;
  evalSamples: number;
  aucEval: number;
  platt: {
    a: number;
    b: number;
    attached: boolean;
    calibSamples: number;
    evalSamples: number;
    brierPreCalibration: number;
    brierPostCalibration: number;
  } | null;
  gateBaseline: { trades: number; winRatePct: number; totalPnlUsd: number };
  sweep: SweepRow[];
  best: SweepRow | null;
  takeaway: string;
}

export function OperatingPointPanel() {
  const [data, setData] = useState<OperatingPoint | null>(null);

  useEffect(() => {
    let active = true;
    void fetch("/data/operating-point.json")
      .then((response) => (response.ok ? response.json() : null))
      .then((json) => {
        if (active && json) setData(json as OperatingPoint);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  // Only real-tape analyses belong on the evidence page; a generator-mode
  // artifact would be synthetic data dressed up as market evidence.
  if (!data || data.source !== "tape") return null;

  const bestPositive = data.best !== null && data.best.totalPnlUsd > 0;

  return (
    <div className="mt-8 rounded-3xl border border-zinc-200/70 bg-white/80 p-6 backdrop-blur-sm elev sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] font-black uppercase tracking-[0.16em] text-sky-700">
            Calibración + punto de operación · ¿existe algún umbral rentable?
          </p>
          <h2 className="mt-2 text-2xl font-black tracking-tight text-zinc-950 sm:text-3xl">
            Le preguntamos al modelo dónde operaría — y liquidamos su respuesta.
          </h2>
        </div>
        <span className={`rounded-full border px-3 py-1 font-mono text-[10px] font-black uppercase tracking-wider ${bestPositive ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700"}`}>
          {data.evalSamples.toLocaleString()} muestras eval
        </span>
      </div>

      <p className="mt-3 max-w-3xl text-sm font-semibold leading-6 text-zinc-500">
        Dos mejoras matemáticas sobre el ensemble, medidas en folds disjuntos del tape real (calibración y evaluación nunca se mezclan):
        primero <strong className="text-zinc-800">calibración de Platt</strong> (Platt 1999) — el AUC {data.aucEval.toFixed(4)} dice que el modelo
        rankea casi perfecto, pero Kelly consume la supervivencia como <em>probabilidad</em>, así que la escala importa tanto como el orden.
        Después, el <strong className="text-zinc-800">barrido de umbrales</strong>: para cada nivel de confianza del modelo, liquidamos
        contrafactualmente las señales que seleccionaría y medimos su P&L real.
      </p>

      {data.platt && (
        <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <Metric label="Brier sin calibrar" value={data.platt.brierPreCalibration.toFixed(4)} tone="amber" />
          <Metric label="Brier calibrado" value={data.platt.brierPostCalibration.toFixed(4)} tone={data.platt.brierPostCalibration < data.platt.brierPreCalibration ? "emerald" : "zinc"} />
          <Metric label="Platt (a · b)" value={`${data.platt.a.toFixed(2)} · ${data.platt.b.toFixed(2)}`} tone="sky" />
          <Metric label="¿Adjuntada al modelo?" value={data.platt.attached ? "Sí" : "No (no mejoró)"} tone={data.platt.attached ? "emerald" : "zinc"} />
        </div>
      )}

      <p className="mt-4 font-mono text-[9px] font-black uppercase tracking-wider text-zinc-500">
        Barrido de umbrales — P&L contrafactual de las señales seleccionadas (fold de evaluación, nunca visto por ningún fit)
      </p>
      <div className="mt-1.5 overflow-x-auto rounded-xl border border-zinc-200">
        <table className="w-full min-w-[560px] text-left">
          <thead>
            <tr className="bg-zinc-100/70 font-mono text-[9px] font-black uppercase tracking-wider text-zinc-500">
              <th className="px-3 py-2">Umbral de supervivencia</th>
              <th className="px-3 py-2 text-right">Trades</th>
              <th className="px-3 py-2 text-right">% ganador</th>
              <th className="px-3 py-2 text-right">P&L total</th>
              <th className="px-3 py-2 text-right">P&L medio</th>
            </tr>
          </thead>
          <tbody className="font-mono text-[11px] font-bold text-zinc-700">
            <tr className="border-t border-zinc-100 bg-sky-50/40">
              <td className="px-3 py-1.5">Gate actual (DETECTED)</td>
              <td className="px-3 py-1.5 text-right text-zinc-500">{data.gateBaseline.trades.toLocaleString()}</td>
              <td className="px-3 py-1.5 text-right text-zinc-500">{data.gateBaseline.winRatePct}%</td>
              <td className={`px-3 py-1.5 text-right ${data.gateBaseline.totalPnlUsd > 0 ? "text-emerald-600" : "text-rose-500"}`}>
                {formatUsd(data.gateBaseline.totalPnlUsd)}
              </td>
              <td className="px-3 py-1.5 text-right text-zinc-400">—</td>
            </tr>
            {data.sweep.map((row) => {
              const isBest = data.best !== null && row.threshold === data.best.threshold;
              return (
                <tr key={row.threshold} className={`border-t border-zinc-100 ${isBest ? "bg-emerald-50/50" : ""}`}>
                  <td className="px-3 py-1.5">
                    ≥ {row.threshold.toFixed(2)}
                    {isBest && <span className="ml-2 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[9px] font-black uppercase text-emerald-700">mejor</span>}
                  </td>
                  <td className="px-3 py-1.5 text-right text-zinc-500">{row.trades.toLocaleString()}</td>
                  <td className="px-3 py-1.5 text-right text-zinc-500">{row.winRatePct}%</td>
                  <td className={`px-3 py-1.5 text-right ${row.totalPnlUsd > 0 ? "text-emerald-600" : "text-rose-500"}`}>{formatUsd(row.totalPnlUsd)}</td>
                  <td className={`px-3 py-1.5 text-right ${row.meanPnlUsd > 0 ? "text-emerald-600" : "text-rose-500"}`}>{formatUsd(row.meanPnlUsd)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className={`mt-4 rounded-2xl border p-5 ${bestPositive ? "border-emerald-200/70 bg-gradient-to-br from-emerald-50/50 via-white to-teal-50/40" : "border-rose-200/70 bg-gradient-to-br from-rose-50/40 via-white to-white"}`}>
        <p className={`font-mono text-[9px] font-black uppercase tracking-wider ${bestPositive ? "text-emerald-700" : "text-rose-700"}`}>Lectura honesta</p>
        <p className="mt-2 text-sm font-semibold leading-6 text-zinc-700">{data.takeaway}</p>
        <p className="mt-3 text-[11px] font-semibold leading-5 text-zinc-500">
          &ldquo;Contrafactual&rdquo; significa: dislocaciones reales del tape, liquidadas por el simulador con su modelo completo de costos
          (latencia realizada, decaimiento de supervivencia, fills parciales). No es trading en vivo, y un resultado positivo aquí hereda
          los supuestos del modelo de costos — por eso se reporta junto a ellos, no como promesa.
        </p>
      </div>

      <p className="mt-4 font-mono text-[9px] font-semibold uppercase tracking-wider text-zinc-400">
        Reproducible: npm run train -- --tape &lt;tape&gt; --opOut public/data/operating-point.json
      </p>
    </div>
  );
}

function formatUsd(value: number): string {
  const abs = Math.abs(value);
  const magnitude = abs >= 1000 ? `$${(abs / 1000).toFixed(1)}k` : `$${abs.toFixed(2)}`;
  return value < 0 ? `−${magnitude}` : `+${magnitude}`;
}

const metricTone: Record<string, string> = {
  emerald: "border-emerald-200 bg-emerald-50 text-emerald-700",
  rose: "border-rose-200 bg-rose-50 text-rose-700",
  amber: "border-amber-200 bg-amber-50 text-amber-700",
  sky: "border-sky-200 bg-sky-50 text-sky-700",
  zinc: "border-zinc-200 bg-zinc-50 text-zinc-700"
};

function Metric({ label, tone, value }: { label: string; tone: string; value: string }) {
  return (
    <div className={`rounded-xl border px-3 py-2.5 ${metricTone[tone]}`}>
      <span className="block text-[9px] font-black uppercase tracking-wider opacity-70">{label}</span>
      <strong className="mt-0.5 block font-mono text-base font-black leading-tight tracking-tight">{value}</strong>
    </div>
  );
}
