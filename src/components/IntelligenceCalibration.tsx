"use client";

import { useEffect, useState } from "react";
import { useArbitrageStore } from "@/store/useArbitrageStore";

interface ModelCard {
  source?: string;
  signals?: number;
  auc?: number;
  mlValidated?: boolean;
  trees?: number;
}

export function IntelligenceCalibration() {
  const init = useArbitrageStore((state) => state.init);
  const learning = useArbitrageStore((state) => state.learning);
  const mode = useArbitrageStore((state) => state.mode);
  const [model, setModel] = useState<ModelCard | null>(null);

  useEffect(() => {
    init();
  }, [init]);

  useEffect(() => {
    let active = true;
    void fetch("/model/edge-model.json")
      .then((response) => (response.ok ? response.json() : null))
      .then((bundle) => {
        if (!active || !bundle) return;
        setModel({
          source: bundle.source,
          signals: bundle.signals,
          auc: bundle.auc,
          mlValidated: bundle.mlValidated,
          trees: Array.isArray(bundle.ml?.trees) ? bundle.ml.trees.length : 0
        });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const brier = Number(learning.brierScore);
  const observations = learning.calibrationObservations;
  const warming = observations < 5;
  const mlBrier = Number(learning.mlBrierScore);
  const mlObservations = learning.mlObservations;
  const mlWarming = mlObservations < 5;
  const quality = warming ? "Calentando" : brier <= 0.18 ? "Calibrado" : brier <= 0.25 ? "Aceptable" : "Sesgado";
  const qualityTone = warming ? "zinc" : brier <= 0.18 ? "emerald" : brier <= 0.25 ? "amber" : "rose";

  return (
    <div className="rounded-3xl border border-zinc-200/70 bg-white/80 p-6 backdrop-blur-sm elev sm:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="live-dot inline-block h-2 w-2 rounded-full bg-emerald-500" />
          <span className="font-mono text-[10px] font-black uppercase tracking-[0.16em] text-sky-700">
            Calibración en vivo · {mode}
          </span>
        </div>
        <Badge tone={qualityTone}>{quality}</Badge>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-[auto_auto_1fr] lg:items-center">
        <div className="rounded-2xl border border-zinc-200/70 bg-gradient-to-br from-sky-50 via-white to-violet-50 px-6 py-5">
          <span className="block font-mono text-[9px] font-black uppercase tracking-wider text-zinc-400">Brier AET · rutas</span>
          <strong className="mt-1 block font-mono text-4xl font-black leading-none tracking-tight text-zinc-950">
            {warming ? "—" : brier.toFixed(4)}
          </strong>
          <span className="mt-2 block text-[11px] font-semibold text-zinc-500">
            menor es mejor · {observations} obs.
          </span>
        </div>

        <div className="rounded-2xl border border-violet-200/70 bg-gradient-to-br from-violet-50 via-white to-sky-50 px-6 py-5">
          <span className="block font-mono text-[9px] font-black uppercase tracking-wider text-violet-400">Brier ML · ensemble</span>
          <strong className="mt-1 block font-mono text-4xl font-black leading-none tracking-tight text-zinc-950">
            {mlWarming ? "—" : mlBrier.toFixed(4)}
          </strong>
          <span className="mt-2 block text-[11px] font-semibold text-zinc-500">
            gradient-boosted · {mlObservations} obs.
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <Stat label="Edges confirmados" value={learning.confirmedEdges} tone="emerald" />
          <Stat label="Pérdidas evitadas" value={learning.avoidedLosses} tone="emerald" />
          <Stat label="Profit perdido" value={learning.missedProfits} tone="amber" />
          <Stat label="Falsos positivos" value={learning.falsePositives} tone="rose" />
          <Stat label="Hit rate" value={`${learning.hitRatePct}%`} tone="sky" />
          <Stat label="Pérdida evitada" value={`$${learning.avoidedLossUsd}`} tone="emerald" />
          <Stat label="Mejor missed" value={`$${learning.bestMissedUsd}`} tone="amber" />
          <Stat label="Señales evaluadas" value={learning.evaluatedSignals} tone="zinc" />
        </div>
      </div>

      {model && (model.trees ?? 0) > 0 && (
        <div className="mt-5 flex flex-wrap items-center gap-2.5 rounded-2xl border border-violet-200/70 bg-violet-50/60 px-4 py-3">
          <span className="font-mono text-[9px] font-black uppercase tracking-wider text-violet-700">Ensemble ML pre-entrenado</span>
          <Stat label="Árboles" value={model.trees ?? 0} tone="violet" />
          <Stat label="AUC held-out" value={(model.auc ?? 0).toFixed(3)} tone="emerald" />
          <Stat label="Ensayos" value={model.signals ?? 0} tone="sky" />
          <Badge tone={model.mlValidated ? "emerald" : "amber"}>{model.mlValidated ? "Validado · discrimina" : "Reentrena en LIVE"}</Badge>
        </div>
      )}

      <p className="mt-5 text-sm font-semibold leading-6 text-zinc-500">
        Cada señal —ejecutada o descartada— se reevalúa contra el mercado posterior con markouts a 100/500/2000 ms.
        El error de pronóstico recalibra el sesgo por ruta del Edge Tensor y alimenta el Brier score, de modo que el
        modelo aprende de sus aciertos <span className="text-zinc-900">y</span> de las oportunidades que dejó pasar.
        El ensemble gradient-boosted se pre-entrena offline (<span className="font-mono text-zinc-700">npm run train</span>) y
        se valida con AUC sobre un held-out disjunto antes de desplegarse; sobre datos reales grabados de los 7 exchanges
        (<span className="font-mono text-zinc-700">npm run record</span>) confirma que el arbitraje cross-exchange retail no
        sobrevive fees+base, por lo que el valor está en rechazarlo con precisión.
      </p>
    </div>
  );
}

const toneMap: Record<string, string> = {
  emerald: "border-emerald-200 bg-emerald-50 text-emerald-700",
  amber: "border-amber-200 bg-amber-50 text-amber-700",
  rose: "border-rose-200 bg-rose-50 text-rose-700",
  sky: "border-sky-200 bg-sky-50 text-sky-700",
  violet: "border-violet-200 bg-violet-50 text-violet-700",
  zinc: "border-zinc-200 bg-zinc-50 text-zinc-700"
};

function Stat({ label, tone, value }: { label: string; tone: string; value: string | number }) {
  return (
    <div className={`rounded-xl border px-3 py-2.5 ${toneMap[tone]}`}>
      <span className="block text-[9px] font-black uppercase tracking-wider opacity-70">{label}</span>
      <strong className="mt-0.5 block font-mono text-lg font-black leading-none tracking-tight">{value}</strong>
    </div>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone: string }) {
  return (
    <span className={`rounded-full border px-3 py-1 font-mono text-[10px] font-black uppercase tracking-wider ${toneMap[tone]}`}>
      {children}
    </span>
  );
}
