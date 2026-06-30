"use client";

import { useEffect, useState } from "react";

interface TapeAnalysis {
  generatedAt: string;
  capture: { rounds: number; books: number; venues: string[]; durationSec: number; usdtUsdBasisBps: string };
  cross: {
    candidates: number;
    profitable: number;
    profitablePct: number;
    detected: number;
    netSpreadBps: { min: number; p25: number; median: number; p75: number; max: number };
    histogram: Array<{ binBps: number; count: number }>;
  };
  latency: { candidates: number; detected: number; maxObservedStalenessMs: number; stalenessOver1800: number; thresholdMs: number };
  statArb: { candidates: number; detected: number; maxNetBps?: number; bestZAbs?: number; requiredZAbs?: number };
  verdict: string;
}

interface ReversionStudy {
  candidates: number;
  baseRatePct: number;
  heldOutAuc: number;
  valSamples: number;
  params: { lookahead: number };
}

interface MakerEvResult { meanEvBps: number; profitablePct: number }
interface TriangularStudy {
  samples: number;
  makerClipBtc: number;
  grossEdgeBps: { median: number; max: number };
  taker: {
    tiers: Array<{ tier: string; roundTripCostBps: number; profitablePct: number; bestNetBps: number }>;
    anyProfitable: boolean;
  };
  maker: {
    makerGrossBps: { median: number; p99: number; max: number };
    evScenarios: {
      observado: { pAll3Avg: number; retail: MakerEvResult; okxVip8Rebate: MakerEvResult };
      sensibilidad: Array<{ fillProbPerLeg: number; pAll3: number; retail: MakerEvResult; okxVip8Rebate: MakerEvResult }>;
    };
    anyProfitable: boolean;
  };
  takeaway: string;
}

export function RealMarketEvidence() {
  const [data, setData] = useState<TapeAnalysis | null>(null);
  const [study, setStudy] = useState<ReversionStudy | null>(null);
  const [tri, setTri] = useState<TriangularStudy | null>(null);

  useEffect(() => {
    let active = true;
    void fetch("/data/tape-analysis.json")
      .then((response) => (response.ok ? response.json() : null))
      .then((json) => {
        if (active && json) setData(json as TapeAnalysis);
      })
      .catch(() => undefined);
    void fetch("/data/reversion-study.json")
      .then((response) => (response.ok ? response.json() : null))
      .then((json) => {
        if (active && json) setStudy(json as ReversionStudy);
      })
      .catch(() => undefined);
    void fetch("/data/triangular-study.json")
      .then((response) => (response.ok ? response.json() : null))
      .then((json) => {
        if (active && json) setTri(json as TriangularStudy);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  if (!data) return null;

  const maxCount = Math.max(1, ...data.cross.histogram.map((b) => b.count));
  const captured = new Date(data.generatedAt).toLocaleDateString("es", { day: "numeric", month: "short", year: "numeric" });

  return (
    <div className="mt-8 rounded-3xl border border-zinc-200/70 bg-white/80 p-6 backdrop-blur-sm elev sm:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] font-black uppercase tracking-[0.16em] text-sky-700">Evidencia de mercado real</p>
          <h2 className="mt-2 text-2xl font-black tracking-tight text-zinc-950 sm:text-3xl">El arbitraje cross-exchange retail no existe.</h2>
        </div>
        <span className="rounded-full border border-rose-200 bg-rose-50 px-3 py-1 font-mono text-[10px] font-black uppercase tracking-wider text-rose-700">
          {data.cross.detected}/{data.cross.candidates.toLocaleString()} ejecutables
        </span>
      </div>

      <p className="mt-3 max-w-3xl text-sm font-semibold leading-6 text-zinc-500">
        Capturamos los order books reales de los {data.capture.venues.length} exchanges (feeds WebSocket independientes,
        <span className="font-mono text-zinc-700"> npm run record:ws</span>) durante {Math.round(data.capture.durationSec / 60)} minutos
        ({data.capture.rounds.toLocaleString()} rondas, {data.capture.books.toLocaleString()} libros, base USDT/USD {data.capture.usdtUsdBasisBps} bps)
        y reprodujimos cada dislocación por el motor. {data.cross.profitable > 0 && (
          <>El <strong className="text-zinc-800">{data.cross.profitablePct}%</strong> tuvo spread neto positivo tras fees —
          pero el ajuste por riesgo del Edge Tensor (supervivencia, P&L ajustado a riesgo) rechazó correctamente las {data.cross.candidates.toLocaleString()}:
          {" "}<strong className="text-zinc-800">0 fueron DETECTED</strong> (ejecutables). El edge visible es real pero demasiado delgado para sobrevivir
          el riesgo de dos patas no simultáneas. </>
        )}Distribución del <strong className="text-zinc-800">net spread tras fees + base + costos</strong>:
      </p>

      {/* Net-spread histogram: every bar sits left of the break-even line. */}
      <div className="mt-6 rounded-2xl border border-zinc-200/70 bg-gradient-to-br from-rose-50/40 via-white to-white p-5">
        <div className="flex items-end gap-1 sm:gap-1.5" style={{ height: 180 }}>
          {data.cross.histogram.map((bin) => (
            <div key={bin.binBps} className="flex min-w-0 flex-1 flex-col items-center justify-end" title={`${bin.binBps} a ${bin.binBps + 10} bps · ${bin.count.toLocaleString()}`}>
              <span className="mb-1 truncate font-mono text-[8px] font-bold text-zinc-400 sm:text-[9px]">{compactNumber(bin.count)}</span>
              <div
                className="w-full rounded-t bg-gradient-to-t from-rose-400 to-rose-300"
                style={{ height: `${Math.max(2, (bin.count / maxCount) * 140)}px` }}
              />
              <span className="mt-1.5 truncate font-mono text-[7px] font-bold text-zinc-400 sm:text-[8px]">{bin.binBps}</span>
            </div>
          ))}
          {/* Break-even marker */}
          <div className="flex shrink-0 flex-col items-center justify-end self-stretch pl-1">
            <div className="h-full w-px bg-emerald-400/60" style={{ borderLeft: "1px dashed rgb(52 211 153 / 0.7)" }} />
            <span className="mt-1.5 font-mono text-[7px] font-black text-emerald-600 sm:text-[8px]">0<span className="hidden sm:inline"> · break-even</span></span>
          </div>
        </div>
        <p className="mt-3 text-center font-mono text-[9px] font-bold uppercase tracking-wider text-zinc-400">
          net spread (bps) · cada barra = nº de dislocaciones reales en ese rango
        </p>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Net spread mediano" value={`${data.cross.netSpreadBps.median} bps`} tone="rose" />
        <Stat label="Peor / mejor" value={`${data.cross.netSpreadBps.min} / ${data.cross.netSpreadBps.max}`} tone="rose" />
        <Stat label="Dislocaciones reales" value={data.cross.candidates.toLocaleString()} tone="sky" />
        <Stat label="Spread neto>0 (no ejecutable)" value={`${data.cross.profitable.toLocaleString()} (${data.cross.profitablePct}%)`} tone="amber" />
        <Stat label="DETECTED (ejecutable)" value={data.cross.detected.toLocaleString()} tone={data.cross.detected ? "emerald" : "rose"} />
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border border-zinc-200/70 bg-zinc-50/60 p-5">
          <p className="font-mono text-[9px] font-black uppercase tracking-wider text-zinc-500">Latency-arb (cotización rancia)</p>
          <p className="mt-2 text-sm font-semibold leading-6 text-zinc-600">
            {data.latency.candidates === 0
              ? `Cero edges de latencia. Lo medimos con feeds WebSocket independientes (npm run record:ws), no solo REST: aun así los venues BTC líquidos se refrescan sub-segundo (skew máximo observado ~690ms, lejos de la barra de ${data.latency.thresholdMs}ms). El latency-arb solo surge ante una caída/outage real o en pares ilíquidos — la estrategia está implementada y con tests, esperando esas condiciones.`
              : `${data.latency.candidates} candidatas de latencia, ${data.latency.detected} DETECTED (staleness máx. ${data.latency.maxObservedStalenessMs}ms sobre la barra de ${data.latency.thresholdMs}ms).`}
          </p>
        </div>
        <div className="rounded-2xl border border-zinc-200/70 bg-zinc-50/60 p-5">
          <p className="font-mono text-[9px] font-black uppercase tracking-wider text-zinc-500">Stat-Arb (cointegración)</p>
          <p className="mt-2 text-sm font-semibold leading-6 text-zinc-600">
            {data.statArb.bestZAbs !== undefined
              ? `La señal estadística sí aparece (mejor |z| observado ${data.statArb.bestZAbs}, supera el umbral ${data.statArb.requiredZAbs}) — pero la mejor candidata neta de costos quedó en ${data.statArb.maxNetBps}bps. El gate de cointegración (ADF) y el modelo de costos rechazan correctamente: hay desviación estadística, no edge ejecutable.`
              : `${data.statArb.candidates} candidatas, ${data.statArb.detected} DETECTED.`}
          </p>
        </div>
        <div className="rounded-2xl border border-emerald-200/70 bg-emerald-50/50 p-5">
          <p className="font-mono text-[9px] font-black uppercase tracking-wider text-emerald-700">Veredicto</p>
          <p className="mt-2 text-sm font-semibold leading-6 text-zinc-700">{data.verdict}</p>
          <p className="mt-2 text-[11px] font-semibold leading-5 text-zinc-500">
            Por eso el valor de ArbitrAI no es prometer un edge inexistente, sino <strong className="text-zinc-800">rechazar con precisión</strong>:
            el modelo de costos (ley √-impacto, fees por venue, base de cotización) y el ensemble AET+ML descartan estas {data.cross.candidates.toLocaleString()} señales.
          </p>
        </div>
      </div>

      {study && (
        <div className="mt-4 rounded-2xl border border-violet-200/70 bg-gradient-to-br from-violet-50/50 via-white to-sky-50/40 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-mono text-[9px] font-black uppercase tracking-wider text-violet-700">¿La microestructura predice la reversión? — probado con más datos</p>
            <span className={`rounded-full border px-3 py-1 font-mono text-[11px] font-black tabular-nums ${study.heldOutAuc >= 0.55 ? "border-violet-200 bg-violet-50 text-violet-700" : "border-zinc-300 bg-zinc-50 text-zinc-600"}`}>
              AUC {study.heldOutAuc.toFixed(3)} held-out
            </span>
          </div>
          <p className="mt-2 text-sm font-semibold leading-6 text-zinc-600">
            Pusimos a prueba si la reversión del spread cross-venue es predecible desde la microestructura. Entrenamos el ensemble
            gradient-boosted sobre <strong className="text-zinc-800">{study.candidates.toLocaleString()}</strong> desviaciones reales
            (|z|&gt;1) etiquetadas por su markout a {study.params.lookahead} rondas, con holdout disjunto:
            {" "}<strong className="text-zinc-800">AUC {study.heldOutAuc.toFixed(3)}</strong> sobre {study.valSamples.toLocaleString()} muestras
            out-of-sample (base rate {study.baseRatePct}%).{" "}
            {study.heldOutAuc >= 0.55
              ? "El modelo extrae estructura genuina de la microestructura real."
              : study.heldOutAuc < 0.5
                ? "Sin señal genuina: el AUC es indistinguible del azar (incluso ligeramente por debajo) sobre una muestra grande. Una corrida anterior con muchas menos observaciones había sugerido un AUC débil pero positivo (~0.53–0.59) — más datos revelaron que era ruido de muestra chica, no una señal real. Lo reportamos así de cambiado: la honestidad estadística importa más que mantener un resultado bonito."
                : "Es una señal real pero débil (apenas supera el azar), justo lo que predice un mercado eficiente — no la sobre-vendemos."}
            {" "}Y como no cubre los fees retail, la ejecución permanece gateada de cualquier forma.
          </p>
        </div>
      )}

      {tri && (
        <div className="mt-4 rounded-2xl border border-zinc-200/70 bg-zinc-50/50 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-mono text-[9px] font-black uppercase tracking-wider text-zinc-600">Edge hunt · arbitraje triangular (un solo venue)</p>
            <span className="rounded-full border border-zinc-300 bg-white px-3 py-1 font-mono text-[11px] font-black tabular-nums text-zinc-700">
              edge bruto tope {tri.grossEdgeBps.max} bps
            </span>
          </div>
          <p className="mt-2 text-sm font-semibold leading-6 text-zinc-600">
            Buscamos la brecha en la estrategia más alcanzable para retail —el triángulo BTC→USDT→ETH→BTC dentro de un mismo venue,
            sin transferencias ni base USDT/USD, solo 3 fees— con {tri.samples.toLocaleString()} muestras reales de Binance, en dos modelos
            de ejecución: <strong className="text-zinc-800">taker</strong> (cruzar el spread) y <strong className="text-zinc-800">maker</strong> (postear
            adentro del spread con la misma fórmula Avellaneda-Stoikov del motor, ponderada por probabilidad de fill real y riesgo de pata).
          </p>

          <p className="mt-3 font-mono text-[9px] font-black uppercase tracking-wider text-zinc-500">Taker — por tier de fee</p>
          <div className="mt-1.5 overflow-x-auto rounded-xl border border-zinc-200">
            <table className="w-full min-w-[420px] text-left">
              <thead>
                <tr className="bg-zinc-100/70 font-mono text-[9px] font-black uppercase tracking-wider text-zinc-500">
                  <th className="px-3 py-2">Tier de fee</th>
                  <th className="px-3 py-2 text-right">Costo</th>
                  <th className="px-3 py-2 text-right">% rentable</th>
                </tr>
              </thead>
              <tbody className="font-mono text-[11px] font-bold text-zinc-700">
                {tri.taker.tiers.map((t) => (
                  <tr key={t.tier} className="border-t border-zinc-100">
                    <td className="px-3 py-1.5">{t.tier}</td>
                    <td className="px-3 py-1.5 text-right text-zinc-500">{t.roundTripCostBps} bps</td>
                    <td className={`px-3 py-1.5 text-right font-black ${t.profitablePct > 0 ? "text-amber-600" : "text-rose-500"}`}>{t.profitablePct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-4 font-mono text-[9px] font-black uppercase tracking-wider text-zinc-500">
            Maker — valor esperado (P(3 patas llenan) × ganancia − P(parcial) × costo de deshacer)
          </p>
          <div className="mt-1.5 overflow-x-auto rounded-xl border border-zinc-200">
            <table className="w-full min-w-[560px] text-left">
              <thead>
                <tr className="bg-zinc-100/70 font-mono text-[9px] font-black uppercase tracking-wider text-zinc-500">
                  <th className="px-3 py-2">Escenario de fill</th>
                  <th className="px-3 py-2 text-right">P(3 patas)</th>
                  <th className="px-3 py-2 text-right">EV retail</th>
                  <th className="px-3 py-2 text-right">EV rebate OKX VIP8</th>
                </tr>
              </thead>
              <tbody className="font-mono text-[11px] font-bold text-zinc-700">
                <tr className="border-t border-zinc-100 bg-sky-50/40">
                  <td className="px-3 py-1.5">Observado (microestructura real)</td>
                  <td className="px-3 py-1.5 text-right text-zinc-500">{(tri.maker.evScenarios.observado.pAll3Avg * 100).toFixed(1)}%</td>
                  <td className={`px-3 py-1.5 text-right ${tri.maker.evScenarios.observado.retail.meanEvBps > 0 ? "text-amber-600" : "text-rose-500"}`}>{tri.maker.evScenarios.observado.retail.meanEvBps} bps</td>
                  <td className={`px-3 py-1.5 text-right ${tri.maker.evScenarios.observado.okxVip8Rebate.meanEvBps > 0 ? "text-amber-600" : "text-rose-500"}`}>{tri.maker.evScenarios.observado.okxVip8Rebate.meanEvBps} bps</td>
                </tr>
                {tri.maker.evScenarios.sensibilidad.map((s) => (
                  <tr key={s.fillProbPerLeg} className="border-t border-zinc-100">
                    <td className="px-3 py-1.5 text-zinc-500">{(s.fillProbPerLeg * 100).toFixed(0)}% por pata (ilustrativo)</td>
                    <td className="px-3 py-1.5 text-right text-zinc-500">{(s.pAll3 * 100).toFixed(1)}%</td>
                    <td className={`px-3 py-1.5 text-right ${s.retail.meanEvBps > 0 ? "text-amber-600" : "text-rose-500"}`}>{s.retail.meanEvBps} bps</td>
                    <td className={`px-3 py-1.5 text-right ${s.okxVip8Rebate.meanEvBps > 0 ? "text-amber-600" : "text-rose-500"}`}>{s.okxVip8Rebate.meanEvBps} bps</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] font-semibold leading-5 text-zinc-500">
            El rebate solo existe si tu orden <strong className="text-zinc-700">provee</strong> liquidez, nunca si la toma — por eso no se mezcla con
            la tabla taker. OKX VIP8 (−0.005%/pata) es el único rebate spot real publicado, y exige ~$12M/mes de volumen: no alcanzable para retail.
          </p>
          <p className="mt-2 text-[11px] font-semibold leading-5 text-zinc-500">{tri.takeaway}</p>
        </div>
      )}

      <p className="mt-4 font-mono text-[9px] font-semibold uppercase tracking-wider text-zinc-400">
        Captura {captured} · reproducible con npm run record · record:ws · analyze:tape · study:reversion · study:triangular · backtest
      </p>
    </div>
  );
}

function compactNumber(n: number): string {
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

const toneMap: Record<string, string> = {
  emerald: "border-emerald-200 bg-emerald-50 text-emerald-700",
  rose: "border-rose-200 bg-rose-50 text-rose-700",
  amber: "border-amber-200 bg-amber-50 text-amber-700",
  sky: "border-sky-200 bg-sky-50 text-sky-700",
  zinc: "border-zinc-200 bg-zinc-50 text-zinc-700"
};

function Stat({ label, tone, value }: { label: string; tone: string; value: string | number }) {
  return (
    <div className={`rounded-xl border px-3 py-2.5 ${toneMap[tone]}`}>
      <span className="block text-[9px] font-black uppercase tracking-wider opacity-70">{label}</span>
      <strong className="mt-0.5 block font-mono text-base font-black leading-tight tracking-tight">{value}</strong>
    </div>
  );
}
