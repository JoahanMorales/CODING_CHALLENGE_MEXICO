"use client";

import { useMemo } from "react";
import { EXCHANGE_LABELS } from "@/lib/config/exchanges";
import { useArbitrageStore } from "@/store/useArbitrageStore";

// Audit log of the automated inventory rebalancer (ExecutionSimulator.rebalance):
// every transfer it performs to keep venues within their operating band, with the
// real withdrawal/network fee it paid. Demonstrates automated, intelligent wallet
// management across exchanges — not just a static prefunded set.

export function RebalancePanel() {
  const actions = useArbitrageStore((state) => state.rebalanceActions);

  const totalCost = useMemo(
    () => actions.reduce((sum, a) => sum + Number(a.costUsd.replace(/[^0-9.-]/g, "")), 0),
    [actions]
  );

  return (
    <div className="flex-shrink-0 rounded-2xl border border-zinc-200 bg-white px-4 py-3 shadow-sm shadow-sky-100/70">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[10px] font-black uppercase tracking-wider text-sky-700">Rebalanceo automático</span>
        <span className="font-mono text-[10px] font-black tabular-nums text-zinc-400">
          {actions.length} transferencia{actions.length === 1 ? "" : "s"} · ${totalCost.toFixed(2)}
        </span>
      </div>

      {actions.length === 0 ? (
        <p className="mt-2 text-[11px] font-semibold leading-4 text-zinc-400">
          Inventario dentro de banda. Cuando un venue se queda corto, el motor jala el excedente del más holgado del mismo activo y lo registra aquí.
        </p>
      ) : (
        <div className="mt-2 max-h-44 space-y-1.5 overflow-y-auto pr-1">
          {actions.map((a) => (
            <div key={a.id} className="flex items-center justify-between gap-2 rounded-lg border border-zinc-100 bg-zinc-50/60 px-2.5 py-1.5">
              <div className="flex min-w-0 items-center gap-1.5">
                <span
                  className={`rounded px-1.5 py-0.5 font-mono text-[9px] font-black ${
                    a.asset === "BTC" ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"
                  }`}
                >
                  {a.asset}
                </span>
                <span className="truncate font-mono text-[11px] font-bold text-zinc-700">
                  {EXCHANGE_LABELS[a.fromExchange]} <span className="text-sky-500">→</span> {EXCHANGE_LABELS[a.toExchange]}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2 font-mono text-[10px] tabular-nums">
                <span className="font-black text-zinc-800">{a.amount}</span>
                <span className="text-zinc-400">fee {a.costUsd}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
