"use client";

import { useEffect, useState } from "react";
import type { PublicGatewaySummary } from "@/lib/types";

export function PublicHealthBadge({ expanded = false }: { expanded?: boolean }) {
  const [summary, setSummary] = useState<PublicGatewaySummary | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080"}/public/summary`, { cache: "no-store" });
        if (!response.ok) throw new Error("gateway unavailable");
        const next = await response.json() as PublicGatewaySummary;
        if (active) {
          setSummary(next);
          setOffline(false);
        }
      } catch {
        if (active) setOffline(true);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const live = summary?.exchanges.filter((exchange) => exchange.status === "live" || exchange.status === "polling").length ?? 0;
  if (!expanded) {
    return (
      <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-[10px] font-black uppercase ${offline ? "border-amber-200 bg-amber-50 text-amber-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"}`}>
        <span className={`h-2 w-2 rounded-full ${offline ? "bg-amber-500" : "animate-pulse bg-emerald-500"}`} />
        {offline ? "Gateway local pendiente" : `${live}/7 venues live`}
      </span>
    );
  }

  return (
    <div className="grid gap-3 rounded-2xl border border-sky-100 bg-white/85 p-4 shadow-sm shadow-sky-100/60">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[10px] font-black uppercase text-sky-700">Gateway sanitario</span>
        <span className={`h-2.5 w-2.5 rounded-full ${offline ? "bg-amber-500" : "animate-pulse bg-emerald-500"}`} />
      </div>
      <strong className="text-lg font-black text-zinc-950">{offline ? "Esperando backend" : `${live}/7 mercados enlazados`}</strong>
      <p className="text-xs font-semibold leading-5 text-zinc-500">
        {offline ? "La experiencia editorial sigue disponible. Inicia Railway o el gateway local para ver datos en vivo." : `Scanner activo en ${summary?.scannerUniverse.length ?? 0} venues. Última lectura ${summary?.time ? new Date(summary.time).toLocaleTimeString() : "--"}.`}
      </p>
    </div>
  );
}

