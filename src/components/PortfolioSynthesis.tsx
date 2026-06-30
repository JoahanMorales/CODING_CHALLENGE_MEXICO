"use client";

import { useEffect, useState } from "react";

interface StrategyStat { meanBps: number; stdevBps: number; sharpeLike: number }
interface PortfolioStudy {
  rounds: number;
  durationSec: number;
  strategies: { cross: StrategyStat; statArb: StrategyStat; triangular: StrategyStat };
  portfolio: StrategyStat;
  linearityCheck: { sumOfIndividualMeansBps: number; portfolioMeanBps: number; differenceBps: number; confirms: boolean };
  correlations: { crossVsStatArb: number; crossVsTriangular: number; statArbVsTriangular: number };
  portfolioBeatsBestSingle: boolean;
  takeaway: string;
}

const LABEL: Record<string, string> = { cross: "Cross-Exchange", statArb: "Stat-Arb", triangular: "Triangular (maker)" };

export function PortfolioSynthesis() {
  const [data, setData] = useState<PortfolioStudy | null>(null);

  useEffect(() => {
    let active = true;
    void fetch("/data/portfolio-study.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (active && j) setData(j as PortfolioStudy);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  if (!data) return null;

  const rows = [
    { key: "cross", ...data.strategies.cross },
    { key: "statArb", ...data.strategies.statArb },
    { key: "triangular", ...data.strategies.triangular },
    { key: "portfolio", meanBps: data.portfolio.meanBps, stdevBps: data.portfolio.stdevBps, sharpeLike: data.portfolio.sharpeLike }
  ];
  const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.meanBps)));

  return (
    <div className="mt-8 rounded-3xl border border-zinc-200/70 bg-white/80 p-6 backdrop-blur-sm elev sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] font-black uppercase tracking-[0.16em] text-sky-700">La síntesis · ¿le ganamos al mercado combinando todo?</p>
          <h2 className="mt-2 text-2xl font-black tracking-tight text-zinc-950 sm:text-3xl">Un portafolio multi-estrategia, probado en vivo.</h2>
        </div>
        <span className={`rounded-full border px-3 py-1 font-mono text-[10px] font-black uppercase tracking-wider ${data.portfolio.meanBps > 0 ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-zinc-300 bg-zinc-50 text-zinc-600"}`}>
          {data.rounds.toLocaleString()} rondas sincronizadas
        </span>
      </div>

      <p className="mt-3 max-w-3xl text-sm font-semibold leading-6 text-zinc-500">
        Conectamos las mismas 5 venues + las 3 patas de Binance <strong className="text-zinc-800">al mismo tiempo</strong> (no capturas separadas pegadas),
        y en cada ronda sincronizada de ~700ms medimos el mejor edge ajustado a riesgo de las tres estrategias —
        Cross-Exchange y Stat-Arb vía el motor real (Kelly + ensemble AET+ML), Triangular vía el modelo maker de Avellaneda-Stoikov con
        probabilidad de fill real. Esto es la unión de todo lo aprendido en una sola pregunta: ¿diversificar las señales que tenemos cambia el resultado?
      </p>

      <div className="mt-5 space-y-2.5">
        {rows.map((r) => {
          const barPct = Math.max(3, (Math.abs(r.meanBps) / maxAbs) * 100);
          const isPortfolio = r.key === "portfolio";
          return (
            <div key={r.key} className={`grid grid-cols-[1fr_auto] items-center gap-3 rounded-2xl border px-4 py-3 ${isPortfolio ? "border-sky-300 bg-sky-50/60" : "border-zinc-200/70 bg-white/70"}`}>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <strong className={`text-sm font-black tracking-tight ${isPortfolio ? "text-sky-800" : "text-zinc-700"}`}>
                    {isPortfolio ? "PORTAFOLIO (suma)" : LABEL[r.key]}
                  </strong>
                  <span className="font-mono text-[9px] font-bold text-zinc-400">sharpe {r.sharpeLike.toFixed(2)}</span>
                </div>
                <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-zinc-100">
                  <div
                    className={`h-full rounded-full ${r.meanBps >= 0 ? "bg-gradient-to-r from-emerald-400 to-emerald-300" : "bg-gradient-to-r from-rose-400 to-rose-300"}`}
                    style={{ width: `${barPct}%` }}
                  />
                </div>
              </div>
              <strong className={`font-mono text-base font-black tabular-nums ${r.meanBps >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                {r.meanBps >= 0 ? "+" : ""}{r.meanBps.toFixed(2)} bps
              </strong>
            </div>
          );
        })}
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-zinc-200/70 bg-zinc-50/60 p-5">
          <p className="font-mono text-[9px] font-black uppercase tracking-wider text-zinc-500">Chequeo de linealidad (no es opinión, es matemática)</p>
          <p className="mt-2 text-sm font-semibold leading-6 text-zinc-600">
            Suma de medias individuales: <strong className="font-mono text-zinc-800">{data.linearityCheck.sumOfIndividualMeansBps.toFixed(2)} bps</strong>.
            Media real del portafolio: <strong className="font-mono text-zinc-800">{data.linearityCheck.portfolioMeanBps.toFixed(2)} bps</strong>.
            Diferencia: <strong className="font-mono text-zinc-800">{data.linearityCheck.differenceBps.toFixed(4)} bps</strong>.
            La expectativa es lineal por definición: el valor esperado de una suma es la suma de los valores esperados, sin excepción.
            Combinar apuestas de EV negativo nunca produce, matemáticamente, un portafolio de EV positivo.
          </p>
        </div>
        <div className="rounded-2xl border border-zinc-200/70 bg-zinc-50/60 p-5">
          <p className="font-mono text-[9px] font-black uppercase tracking-wider text-zinc-500">Lo que SÍ hace la diversificación</p>
          <p className="mt-2 text-sm font-semibold leading-6 text-zinc-600">
            Correlaciones entre estrategias: cross↔stat-arb <strong className="font-mono text-zinc-800">{data.correlations.crossVsStatArb.toFixed(2)}</strong>,
            cross↔triangular <strong className="font-mono text-zinc-800">{data.correlations.crossVsTriangular.toFixed(2)}</strong>,
            stat-arb↔triangular <strong className="font-mono text-zinc-800">{data.correlations.statArbVsTriangular.toFixed(2)}</strong>.
            Al no ser perfectamente correlacionadas, combinarlas sí reduce la <em>varianza</em> del resultado (Sharpe del portafolio vs. cada componente) —
            pero la varianza más baja no cambia el signo de la expectativa. Diversificar suaviza el camino; no convierte una apuesta perdedora en ganadora.
          </p>
        </div>
      </div>

      <div className="mt-5 rounded-2xl border border-violet-200/70 bg-gradient-to-br from-violet-50/50 via-white to-sky-50/40 p-5">
        <p className="font-mono text-[9px] font-black uppercase tracking-wider text-violet-700">Conclusión</p>
        <p className="mt-2 text-sm font-semibold leading-6 text-zinc-700">{data.takeaway}</p>
        <p className="mt-3 text-[11px] font-semibold leading-5 text-zinc-500">
          No es falta de esfuerzo ni de imaginación: es la propiedad matemática de un mercado eficiente. Donde sí ganamos —y es real— es en
          construir el sistema que mide esto con rigor, lo demuestra con datos en vivo, y toma la decisión correcta (no operar) en vez de fingir un edge
          que no existe. Esa disciplina es el producto.
        </p>
      </div>
    </div>
  );
}
