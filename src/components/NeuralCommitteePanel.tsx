"use client";

import { useEffect, useState } from "react";

interface ModelMetric {
  auc: number;
  brier: number;
}

interface NeuralStudy {
  generatedAt: string;
  heldOutSamples: number;
  winRatePct: number;
  tree: ModelMetric;
  neural: ModelMetric;
  committee: ModelMetric;
  neuralArch: number[] | null;
}

// Derive the verdict from the numbers on screen so it can never contradict them.
function deriveTakeaway(d: NeuralStudy): string {
  const ranked = [
    { name: "árbol con gradient boosting", m: d.tree },
    { name: "red neuronal", m: d.neural },
    { name: "comité", m: d.committee }
  ].sort((a, b) => a.m.brier - b.m.brier);
  const best = ranked[0];
  if (best.name === "comité") {
    return `El comité (promedio de ambos modelos) logra el mejor Brier (${d.committee.brier.toFixed(3)}) con AUC ${d.committee.auc.toFixed(3)}: dos familias que separan winners de losers por caminos distintos se corrigen el ruido de calibración mutuamente.`;
  }
  return `En este held-out la ${best.name} es el modelo individual más fuerte (AUC ${best.m.auc.toFixed(3)}, Brier ${best.m.brier.toFixed(3)}); el comité promedia ambas opiniones como segunda voz. Dos modelos independientes, de arquitectura distinta, reducen el riesgo de que una sola familia se equivoque en conjunto.`;
}

export function NeuralCommitteePanel() {
  const [data, setData] = useState<NeuralStudy | null>(null);

  useEffect(() => {
    let alive = true;
    void fetch("/data/neural-study.json")
      .then((response) => (response.ok ? response.json() : null))
      .then((json: NeuralStudy | null) => {
        if (alive && json && json.tree && json.neural && json.committee) setData(json);
      })
      .catch(() => {
        // No artifact deployed -> panel stays hidden, like the other evidence panels.
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!data) return null;

  const arch = data.neuralArch?.join(" · ") ?? "24 · 32 · 16 · 1";
  const winner =
    data.committee.brier <= Math.min(data.tree.brier, data.neural.brier) ? "committee" : data.tree.brier <= data.neural.brier ? "tree" : "neural";

  return (
    <section className="mt-6 overflow-hidden rounded-3xl border border-zinc-200/70 bg-white shadow-sm shadow-sky-100/60">
      <div className="border-b border-zinc-100 bg-gradient-to-r from-sky-50/70 via-white to-emerald-50/60 px-6 py-5 sm:px-8">
        <p className="font-mono text-[10px] font-black uppercase tracking-[0.18em] text-sky-700">Inteligencia · comité de dos modelos</p>
        <h2 className="mt-2 text-2xl font-black tracking-tight text-zinc-950 sm:text-3xl">Árboles y red neuronal, votando juntos</h2>
        <p className="mt-2 max-w-3xl text-sm font-semibold leading-6 text-zinc-600">
          Un ensemble de árboles con gradient boosting parte fronteras alineadas a los ejes; una red neuronal las curva. Las dos
          familias, entrenadas en la Jetson sobre {data.heldOutSamples.toLocaleString("es-MX")} ensayos held-out ({data.winRatePct}%
          winners), se validan por separado y promedian sus opiniones.
        </p>
      </div>

      <div className="grid gap-4 px-6 py-6 sm:grid-cols-3 sm:px-8">
        <ModelCard highlight={winner === "tree"} metric={data.tree} subtitle="Gradient boosting · ≤32 stumps" title="Árbol" tone="sky" />
        <ModelCard highlight={winner === "neural"} metric={data.neural} subtitle={`MLP · ${arch} · ReLU`} title="Red neuronal" tone="violet" />
        <ModelCard highlight={winner === "committee"} metric={data.committee} shipped subtitle="Promedio de ambos modelos" title="Comité" tone="emerald" />
      </div>

      <div className="mx-6 mb-6 rounded-2xl border border-sky-100 bg-sky-50/50 px-5 py-4 text-sm font-semibold leading-6 text-sky-900 sm:mx-8">
        {deriveTakeaway(data)}
      </div>
    </section>
  );
}

const toneMap: Record<string, { border: string; text: string; ring: string; chip: string }> = {
  sky: { border: "border-sky-200", text: "text-sky-700", ring: "ring-sky-200", chip: "bg-sky-100 text-sky-700" },
  violet: { border: "border-violet-200", text: "text-violet-700", ring: "ring-violet-200", chip: "bg-violet-100 text-violet-700" },
  emerald: { border: "border-emerald-200", text: "text-emerald-700", ring: "ring-emerald-200", chip: "bg-emerald-100 text-emerald-700" }
};

function ModelCard({
  highlight,
  metric,
  shipped = false,
  subtitle,
  title,
  tone
}: {
  highlight: boolean;
  metric: ModelMetric;
  shipped?: boolean;
  subtitle: string;
  title: string;
  tone: string;
}) {
  const t = toneMap[tone];
  return (
    <div className={`relative rounded-2xl border bg-white p-5 ${t.border} ${highlight ? `ring-2 ${t.ring}` : ""}`}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-black tracking-tight text-zinc-950">{title}</h3>
        {shipped && <span className={`rounded-full px-2 py-0.5 font-mono text-[8px] font-black uppercase tracking-wider ${t.chip}`}>Warm-start</span>}
      </div>
      <p className="mt-1 font-mono text-[10px] font-bold uppercase tracking-wide text-zinc-400">{subtitle}</p>
      <div className="mt-4 flex items-end justify-between">
        <div>
          <span className="block font-mono text-[9px] font-black uppercase tracking-wider text-zinc-400">AUC held-out</span>
          <strong className={`font-mono text-3xl font-black ${t.text}`}>{metric.auc.toFixed(3)}</strong>
        </div>
        <div className="text-right">
          <span className="block font-mono text-[9px] font-black uppercase tracking-wider text-zinc-400">Brier</span>
          <strong className="font-mono text-lg font-black text-zinc-700">{metric.brier.toFixed(3)}</strong>
        </div>
      </div>
    </div>
  );
}
