"use client";

import { useEffect, useState } from "react";

// Renders public/data/maker-edge.json (scripts/makerEdgeStudy.ts): the maker-side
// complement to the taker fee study. Per venue, what a passive quote CAPTURES (half
// spread) vs the RISK it carries (mid move over the quote's lifetime). Honest
// component decomposition -- no fill simulation, no single net-edge claim.

interface VenueRow {
  venue: string; label: string; halfSpreadBps: number; midMoveBps: number; ratio: number; breakevenRebateBps: number;
}
interface MakerEdge {
  rounds: number; markoutRounds: number;
  liquidVenues: { meanHalfSpreadBps: number; meanMidMoveBps: number; ratio: number };
  bestRealRebateBps: number;
  perVenue: VenueRow[];
  verdict: string;
}

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

export function MakerEdgePanel() {
  const [data, setData] = useState<MakerEdge | null>(null);

  useEffect(() => {
    let active = true;
    void fetch("/data/maker-edge.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => { if (active && json) setData(json as MakerEdge); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  if (!data) return null;
  // Log-scaled bar so a 0.8x and a 1400x venue both read.
  const maxLog = Math.max(...data.perVenue.map((v) => Math.log10(Math.max(1, v.ratio))));

  return (
    <div className="mt-8 rounded-3xl border border-zinc-200/70 bg-white/80 p-6 backdrop-blur-sm elev sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] font-black uppercase tracking-[0.16em] text-sky-700">
            Lado maker · ¿el spread paga por el riesgo?
          </p>
          <h2 className="mt-2 text-2xl font-black tracking-tight text-zinc-950 sm:text-3xl">
            El otro lado del mercado: proveer liquidez tampoco es gratis.
          </h2>
        </div>
        <span className="rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1 font-mono text-[10px] font-black uppercase tracking-wider text-zinc-600">
          {data.rounds.toLocaleString()} rondas
        </span>
      </div>

      <p className="mt-3 max-w-3xl text-sm font-semibold leading-6 text-zinc-500">
        Si el arbitraje taker es ruinoso, ¿y ser <strong className="text-zinc-800">maker</strong>? Un market-maker cobra el medio
        spread por cada fill, pero carga el riesgo de que el precio se mueva en su contra (selección adversa). Descomponemos las dos
        piezas — medidas directas, sin simular fills (imposible de hacer bien sin trades): lo que{" "}
        <strong className="text-zinc-800">capturas</strong> (medio spread) vs el <strong className="text-zinc-800">movimiento del mid</strong>{" "}
        durante la vida de la quote (~{data.markoutRounds} rondas). En las venues líquidas el spread es apenas{" "}
        <strong className="text-emerald-600">{data.liquidVenues.meanHalfSpreadBps} bps</strong> (1 tick) contra{" "}
        <strong className="text-rose-600">{data.liquidVenues.meanMidMoveBps} bps</strong> de movimiento — el riesgo es{" "}
        <strong className="text-rose-600">~{data.liquidVenues.ratio}×</strong> el spread.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Metric label="Medio spread (líquidas)" value={`${data.liquidVenues.meanHalfSpreadBps} bps`} tone="emerald" />
        <Metric label="Mid move / quote" value={`${data.liquidVenues.meanMidMoveBps} bps`} tone="rose" />
        <Metric label="Riesgo ÷ spread" value={`~${data.liquidVenues.ratio}×`} tone="amber" />
        <Metric label="Mejor rebate real" value={`${data.bestRealRebateBps} bps`} tone="sky" />
      </div>

      <p className="mt-5 font-mono text-[9px] font-black uppercase tracking-wider text-sky-700">
        Por venue — medio spread capturable vs movimiento del mid (riesgo)
      </p>
      <div className="mt-2 overflow-x-auto rounded-xl border border-zinc-200">
        <table className="w-full min-w-[520px] text-left">
          <thead>
            <tr className="bg-zinc-100/70 font-mono text-[9px] font-black uppercase tracking-wider text-zinc-500">
              <th className="px-3 py-2">Venue</th>
              <th className="px-3 py-2 text-right">Medio spread</th>
              <th className="px-3 py-2 text-right">Mid move</th>
              <th className="px-3 py-2">Riesgo ÷ spread</th>
              <th className="px-3 py-2 text-right">¿Spread cubre?</th>
            </tr>
          </thead>
          <tbody className="font-mono text-[11px] font-bold text-zinc-700">
            {data.perVenue.map((v) => {
              const covers = v.ratio < 1;
              return (
                <tr key={v.venue} className="border-t border-zinc-100">
                  <td className="px-3 py-1.5 font-sans font-semibold text-zinc-700">{v.label}</td>
                  <td className="px-3 py-1.5 text-right text-zinc-500">{v.halfSpreadBps} bps</td>
                  <td className="px-3 py-1.5 text-right text-zinc-500">{v.midMoveBps} bps</td>
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-2">
                      <div className="h-2.5 w-28 overflow-hidden rounded-full bg-zinc-100">
                        <div
                          className={`h-full rounded-full ${covers ? "bg-gradient-to-r from-emerald-500 to-emerald-300" : "bg-gradient-to-r from-rose-500 to-rose-300"}`}
                          style={{ width: `${Math.max(4, (Math.log10(Math.max(1, v.ratio)) / maxLog) * 100)}%` }}
                        />
                      </div>
                      <span className="tabular-nums text-zinc-500">{v.ratio}×</span>
                    </div>
                  </td>
                  <td className={`px-3 py-1.5 text-right ${covers ? "text-emerald-600" : "text-rose-500"}`}>{covers ? "sí" : "no"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-4 rounded-2xl border border-amber-200/70 bg-gradient-to-br from-amber-50/40 via-white to-white p-5">
        <p className="font-mono text-[9px] font-black uppercase tracking-wider text-amber-700">Lectura honesta</p>
        <p className="mt-2 text-sm font-semibold leading-6 text-zinc-700">{data.verdict}</p>
        <p className="mt-3 text-[11px] font-semibold leading-5 text-zinc-500">
          El matiz que lo hace creíble: en la única venue de spread ancho (Bitfinex) el spread <em>sí</em> supera el movimiento —
          por eso queda ancha, pocos makers compiten ahí. En las líquidas, la competencia ya comprimió el spread por debajo de la
          selección adversa. Eficiencia de mercado, ahora también del lado maker — no un edge simulado, componentes medidos.
        </p>
      </div>

      <p className="mt-4 font-mono text-[9px] font-semibold uppercase tracking-wider text-zinc-400">
        Reproducible: npm run study:maker &lt;tape&gt; public/data/maker-edge.json
      </p>
    </div>
  );
}
