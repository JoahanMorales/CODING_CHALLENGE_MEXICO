"use client";

import { useEffect, useState } from "react";

// Renders public/data/real-opportunities.json (scripts/opportunityScan.ts): the
// proof that the bot captures GENUINE net-positive arbitrage. Every row here had
// both order books fresh (<staleMs), so these are real, executable dislocations --
// not lagging quotes dressed up as free money.

interface Opp {
  round: number; buy: string; sell: string; buyLabel?: string; sellLabel?: string;
  buyAskPrice: number; sellBidPrice: number; grossBps: number; feeBps: number; netBps: number;
  buyAgeMs: number; sellAgeMs: number;
}
interface RealOpps {
  rounds: number; staleMs: number; netPositiveOpportunities: number; distinctEvents: number;
  best: Opp | null; top: Opp[]; verdict: string;
}

const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export function RealOpportunitiesPanel() {
  const [data, setData] = useState<RealOpps | null>(null);

  useEffect(() => {
    let active = true;
    void fetch("/data/real-opportunities.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => { if (active && json) setData(json as RealOpps); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  if (!data || !data.best) return null;
  const b = data.best;

  return (
    <div className="mt-8 rounded-3xl border border-emerald-200/70 bg-gradient-to-br from-emerald-50/50 via-white to-white p-6 backdrop-blur-sm elev sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] font-black uppercase tracking-[0.16em] text-emerald-700">
            Capturas reales · el bot SÍ opera cuando hay edge
          </p>
          <h2 className="mt-2 text-2xl font-black tracking-tight text-zinc-950 sm:text-3xl">
            Arbitraje net-positivo real, capturado en vivo.
          </h2>
        </div>
        <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 font-mono text-[10px] font-black uppercase tracking-wider text-emerald-700">
          {data.netPositiveOpportunities} capturas · {data.distinctEvents} evento(s)
        </span>
      </div>

      <p className="mt-3 max-w-3xl text-sm font-semibold leading-6 text-zinc-500">
        La eficiencia del mercado es la regla — pero en los <strong className="text-zinc-800">spikes de volatilidad</strong> los venues
        rápidos repricean antes que los lentos y se abre una ventana real de ~1 segundo. Aquí están, de{" "}
        <strong className="text-zinc-800">{data.rounds.toLocaleString()}</strong> rondas reales. Lo clave:{" "}
        <strong className="text-zinc-800">ambos libros estaban frescos (&lt;{data.staleMs}ms)</strong> — no son quotes rancias disfrazadas
        de dinero gratis, son dislocaciones genuinas y ejecutables. Exactamente lo que el bot detecta y simula.
      </p>

      {/* The headline capture, spelled out like the challenge's own example. */}
      <div className="mt-5 rounded-2xl border border-emerald-200/70 bg-white/70 p-5">
        <p className="font-mono text-[9px] font-black uppercase tracking-wider text-emerald-700">La mejor captura</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto_1fr_auto] sm:items-center">
          <div className="rounded-xl border border-sky-200 bg-sky-50/60 p-3">
            <p className="font-mono text-[9px] font-black uppercase text-sky-700">Comprar · {b.buyLabel ?? b.buy}</p>
            <p className="mt-0.5 font-mono text-lg font-black tabular-nums text-zinc-900">{usd(b.buyAskPrice)}</p>
            <p className="font-mono text-[9px] text-zinc-400">book {b.buyAgeMs}ms fresco</p>
          </div>
          <span className="hidden text-2xl font-black text-emerald-500 sm:block">→</span>
          <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3">
            <p className="font-mono text-[9px] font-black uppercase text-emerald-700">Vender · {b.sellLabel ?? b.sell}</p>
            <p className="mt-0.5 font-mono text-lg font-black tabular-nums text-zinc-900">{usd(b.sellBidPrice)}</p>
            <p className="font-mono text-[9px] text-zinc-400">book {b.sellAgeMs}ms fresco</p>
          </div>
          <div className="rounded-xl border border-emerald-300 bg-gradient-to-br from-emerald-100/70 to-white p-3 text-center">
            <p className="font-mono text-[9px] font-black uppercase text-emerald-700">Neto tras fees</p>
            <p className="mt-0.5 font-mono text-2xl font-black tabular-nums text-emerald-600">+{b.netBps} bps</p>
            <p className="font-mono text-[9px] text-zinc-400">bruto {b.grossBps} − fees {b.feeBps}</p>
          </div>
        </div>
      </div>

      {data.top.length > 1 && (
        <div className="mt-4 overflow-x-auto rounded-xl border border-zinc-200">
          <table className="w-full min-w-[560px] text-left">
            <thead>
              <tr className="bg-zinc-100/70 font-mono text-[9px] font-black uppercase tracking-wider text-zinc-500">
                <th className="px-3 py-2">Comprar</th>
                <th className="px-3 py-2">Vender</th>
                <th className="px-3 py-2 text-right">Bruto</th>
                <th className="px-3 py-2 text-right">Fees</th>
                <th className="px-3 py-2 text-right">Neto</th>
                <th className="px-3 py-2 text-right">Frescura</th>
              </tr>
            </thead>
            <tbody className="font-mono text-[11px] font-bold text-zinc-700">
              {data.top.slice(0, 9).map((o, i) => (
                <tr key={i} className="border-t border-zinc-100">
                  <td className="px-3 py-1.5 font-sans font-semibold">{o.buyLabel ?? o.buy}</td>
                  <td className="px-3 py-1.5 font-sans font-semibold">{o.sellLabel ?? o.sell}</td>
                  <td className="px-3 py-1.5 text-right text-zinc-500">{o.grossBps} bps</td>
                  <td className="px-3 py-1.5 text-right text-zinc-400">{o.feeBps}</td>
                  <td className="px-3 py-1.5 text-right font-black text-emerald-600">+{o.netBps} bps</td>
                  <td className="px-3 py-1.5 text-right text-zinc-400">{Math.max(o.buyAgeMs, o.sellAgeMs)}ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 rounded-2xl border border-emerald-200/70 bg-white/60 p-5">
        <p className="font-mono text-[9px] font-black uppercase tracking-wider text-emerald-700">Lectura honesta</p>
        <p className="mt-2 text-sm font-semibold leading-6 text-zinc-700">{data.verdict}</p>
      </div>

      <p className="mt-4 font-mono text-[9px] font-semibold uppercase tracking-wider text-zinc-400">
        Reproducible: npm run scan:opportunities &lt;tape&gt; public/data/real-opportunities.json
      </p>
    </div>
  );
}
