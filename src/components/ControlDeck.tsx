"use client";

import { useMemo } from "react";
import { EXCHANGE_IDS, EXCHANGE_LABELS } from "@/lib/config/exchanges";
import { DEFAULT_ENGINE_PARAMS } from "@/lib/services/ArbitrageEngine";
import { useArbitrageStore } from "@/store/useArbitrageStore";
import type { EngineParams, ExchangeId } from "@/lib/types";

// ControlDeck — the strategy command center. Every knob here writes straight into
// the running ArbitrageEngine (demo kernel + live gateway) via setEngineParams /
// setScannerUniverse, so what the operator dials is exactly what detection uses.
// This is the parametrization surface the challenge weighs most heavily: the
// operator controls the edge threshold, position cap, fee-stress margin and the
// active venue universe live, with no redeploy.

interface Knob {
  key: keyof EngineParams;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  accent: string; // tailwind accent-* colour
}

const KNOBS: Knob[] = [
  {
    key: "minNetEdgeBps",
    label: "Umbral de ganancia neta",
    hint: "Edge mínimo, tras fees, para ejecutar. Bájalo y aparecen más trades marginales; súbelo y solo pasan las dislocaciones gordas.",
    min: 0,
    max: 40,
    step: 0.5,
    format: (v) => `${v.toFixed(1)} bps`,
    accent: "accent-emerald-500"
  },
  {
    key: "maxTradeSizeBtc",
    label: "Tamaño máx. de orden",
    hint: "Techo de posición por operación, sin importar la profundidad disponible. Controla la exposición por trade.",
    min: 0.001,
    max: 1,
    step: 0.001,
    format: (v) => `${v.toFixed(3)} BTC`,
    accent: "accent-sky-500"
  },
  {
    key: "feeStressMultiplier",
    label: "Estrés de fees",
    hint: "Margen de seguridad: asume que fees y slippage son este múltiplo peores. 1.0 = fees reales; 2.0 = doble de conservador.",
    min: 0.5,
    max: 3,
    step: 0.05,
    format: (v) => `${v.toFixed(2)}×`,
    accent: "accent-amber-500"
  }
];

export function ControlDeck() {
  const engineParams = useArbitrageStore((state) => state.engineParams);
  const setEngineParams = useArbitrageStore((state) => state.setEngineParams);
  const scannerUniverse = useArbitrageStore((state) => state.scannerUniverse);
  const setScannerUniverse = useArbitrageStore((state) => state.setScannerUniverse);
  const mode = useArbitrageStore((state) => state.mode);
  const adminAuthenticated = useArbitrageStore((state) => state.adminAuthenticated);

  const locked = mode === "LIVE" && !adminAuthenticated;
  const activeSet = useMemo(() => new Set(scannerUniverse), [scannerUniverse]);
  const isDefault =
    engineParams.minNetEdgeBps === DEFAULT_ENGINE_PARAMS.minNetEdgeBps &&
    engineParams.maxTradeSizeBtc === DEFAULT_ENGINE_PARAMS.maxTradeSizeBtc &&
    engineParams.feeStressMultiplier === DEFAULT_ENGINE_PARAMS.feeStressMultiplier;

  function toggleExchange(id: ExchangeId) {
    if (locked) return;
    const next = new Set(activeSet);
    if (next.has(id)) {
      if (next.size <= 2) return; // engine needs ≥2 venues to cross
      next.delete(id);
    } else {
      next.add(id);
    }
    setScannerUniverse(EXCHANGE_IDS.filter((e) => next.has(e)));
  }

  return (
    <div className="flex-shrink-0 rounded-2xl border border-indigo-200/70 bg-gradient-to-br from-indigo-50/60 via-white to-white p-4 shadow-sm shadow-indigo-100/70">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="live-dot inline-block h-1.5 w-1.5 rounded-full bg-indigo-500" />
          <span className="font-mono text-[10px] font-black uppercase tracking-[0.14em] text-indigo-700">
            Parámetros de estrategia
          </span>
        </div>
        <button
          type="button"
          disabled={locked || isDefault}
          onClick={() => setEngineParams({ ...DEFAULT_ENGINE_PARAMS })}
          className="rounded-md border border-zinc-200 px-2 py-0.5 font-mono text-[9px] font-black uppercase text-zinc-400 transition enabled:hover:border-indigo-300 enabled:hover:text-indigo-600 disabled:opacity-40"
        >
          Reset
        </button>
      </div>

      <p className="mt-2 text-[11px] font-semibold leading-4 text-zinc-500">
        En vivo hacia el motor de detección. Lo que ajustas aquí es exactamente lo que el bot usa para decidir cada operación.
      </p>

      <div className="mt-4 flex flex-col gap-4">
        {KNOBS.map((knob) => {
          const value = engineParams[knob.key];
          return (
            <label key={knob.key} className="block">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[12px] font-black text-zinc-800">{knob.label}</span>
                <span className="rounded-md bg-zinc-900 px-2 py-0.5 font-mono text-[11px] font-black tabular-nums text-white">
                  {knob.format(value)}
                </span>
              </div>
              <input
                type="range"
                min={knob.min}
                max={knob.max}
                step={knob.step}
                value={value}
                disabled={locked}
                onChange={(e) => setEngineParams({ [knob.key]: Number(e.target.value) } as Partial<EngineParams>)}
                className={`mt-2 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-zinc-200 ${knob.accent} disabled:cursor-not-allowed disabled:opacity-50`}
              />
              <p className="mt-1 text-[10px] font-medium leading-tight text-zinc-400">{knob.hint}</p>
            </label>
          );
        })}
      </div>

      {/* Live derived readout: the effective net-edge floor the engine is using
          right now = min edge × fee-stress. Makes the interaction between two
          knobs legible instead of implicit. */}
      <div className="mt-3 flex items-center justify-between rounded-lg bg-zinc-900 px-3 py-1.5">
        <span className="font-mono text-[9px] font-black uppercase tracking-wider text-zinc-400">Umbral efectivo</span>
        <span className="font-mono text-[12px] font-black tabular-nums text-emerald-400">
          {(engineParams.minNetEdgeBps * engineParams.feeStressMultiplier).toFixed(1)} bps
        </span>
      </div>

      <div className="mt-4 border-t border-zinc-100 pt-3">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[10px] font-black uppercase tracking-wider text-zinc-500">Exchanges activos</span>
          <span className="font-mono text-[10px] font-black tabular-nums text-indigo-600">{activeSet.size}/{EXCHANGE_IDS.length}</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {EXCHANGE_IDS.map((id) => {
            const on = activeSet.has(id);
            return (
              <button
                key={id}
                type="button"
                disabled={locked}
                onClick={() => toggleExchange(id)}
                className={`rounded-lg border px-2 py-1 font-mono text-[10px] font-black uppercase tracking-wide transition disabled:cursor-not-allowed disabled:opacity-50 ${
                  on
                    ? "border-indigo-300 bg-indigo-500 text-white shadow-sm shadow-indigo-200"
                    : "border-zinc-200 bg-white text-zinc-400 hover:border-zinc-300"
                }`}
              >
                {EXCHANGE_LABELS[id]}
              </button>
            );
          })}
        </div>
        <p className="mt-2 font-mono text-[9px] font-bold uppercase tracking-wider text-zinc-400">
          {activeSet.size * (activeSet.size - 1)} rutas dirigidas cross-venue en escaneo
        </p>
      </div>

      {locked && (
        <p className="mt-3 rounded-lg bg-amber-50 px-2.5 py-1.5 font-mono text-[9px] font-black uppercase tracking-wider text-amber-700">
          Modo LIVE: desbloquea admin para reparametrizar en producción
        </p>
      )}
    </div>
  );
}
