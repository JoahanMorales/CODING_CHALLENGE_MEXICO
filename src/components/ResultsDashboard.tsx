"use client";

import { useEffect, useState } from "react";
import type { BenchmarkSummary, PublicGatewaySummary } from "@/lib/types";

export function ResultsDashboard() {
  const [benchmark, setBenchmark] = useState<BenchmarkSummary | null>(null);
  const [summary, setSummary] = useState<PublicGatewaySummary | null>(null);
  const [gatewayOffline, setGatewayOffline] = useState(false);

  useEffect(() => {
    let active = true;
    const loadBenchmark = async () => {
      const response = await fetch("/benchmarks/2026-05-30-live-paper-session.json");
      if (active && response.ok) setBenchmark(await response.json() as BenchmarkSummary);
    };
    const loadGateway = async () => {
      try {
        const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080"}/public/summary`, { cache: "no-store" });
        if (!response.ok) throw new Error("gateway offline");
        if (active) {
          setSummary(await response.json() as PublicGatewaySummary);
          setGatewayOffline(false);
        }
      } catch {
        if (active) setGatewayOffline(true);
      }
    };
    void loadBenchmark();
    void loadGateway();
    const timer = window.setInterval(() => void loadGateway(), 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className="grid gap-8">
      <section className="grid gap-4 lg:grid-cols-[1.08fr_0.92fr]">
        <div className="rounded-3xl border border-sky-100 bg-white p-6 shadow-sm shadow-sky-100/70">
          <p className="font-mono text-[10px] font-black uppercase text-sky-700">Paper benchmark inmutable</p>
          <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="text-3xl font-black text-zinc-950">Sesión reproducible de 10 minutos</h2>
              <p className="mt-2 text-sm font-semibold leading-6 text-zinc-500">Datos live, ejecución paper y costos conservadores. No representa ganancia monetaria realizada.</p>
            </div>
            <Label>Paper benchmark</Label>
          </div>
          <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Metric label="Venues" value={String(benchmark?.venueCount ?? "--")} tone="sky" />
            <Metric label="Rutas" value={String(benchmark?.routeCount ?? "--")} tone="sky" />
            <Metric label="Señales" value={String(benchmark?.signalsScored ?? "--")} tone="zinc" />
            <Metric label="Paper P&L" value={`$${benchmark?.paperPnlUsd ?? "--"}`} tone="emerald" />
            <Metric label="Trades paper" value={String(benchmark?.paperTrades ?? "--")} tone="emerald" />
            <Metric label="Latencia avg" value={`${benchmark?.averageDetectionLatencyMs ?? "--"}ms`} tone="sky" />
            <Metric label="Latencia p95" value={`${benchmark?.p95DetectionLatencyMs ?? "--"}ms`} tone="sky" />
            <Metric label="Avoided loss" value={`$${benchmark?.shadowLearning.avoidedLossUsd ?? "--"}`} tone="amber" />
          </div>
        </div>

        <div className="rounded-3xl border border-emerald-100 bg-emerald-50/55 p-6">
          <p className="font-mono text-[10px] font-black uppercase text-emerald-700">Signed TEST_ORDER validation</p>
          <h2 className="mt-4 text-2xl font-black text-zinc-950">{benchmark?.testOrderValidation.status ?? "Loading evidence"}</h2>
          <p className="mt-3 text-sm font-semibold leading-6 text-zinc-600">{benchmark?.testOrderValidation.note ?? "Loading immutable benchmark evidence."}</p>
          <div className="mt-6 grid grid-cols-2 gap-3">
            <Metric label="Venue" value={benchmark?.testOrderValidation.venue ?? "--"} tone="emerald" />
            <Metric label="Funds moved" value={benchmark?.testOrderValidation.fundsMoved ? "YES" : "NO"} tone="emerald" />
          </div>
          <div className="mt-4 rounded-xl border border-emerald-200 bg-white/70 px-4 py-3 text-xs font-black text-emerald-700">No real-money execution</div>
        </div>
      </section>

      <section className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="font-mono text-[10px] font-black uppercase text-sky-700">Gateway sanitario live</p>
            <h2 className="mt-2 text-2xl font-black text-zinc-950">{gatewayOffline ? "Backend no disponible" : "Backend enlazado"}</h2>
          </div>
          <span className={`h-3 w-3 rounded-full ${gatewayOffline ? "bg-amber-500" : "animate-pulse bg-emerald-500"}`} />
        </div>
        <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Metric label="Mercados live" value={summary ? `${summary.exchanges.filter((exchange) => exchange.status === "live" || exchange.status === "polling").length}/7` : "--"} tone="emerald" />
          <Metric label="Scanner universe" value={summary ? String(summary.scannerUniverse.length) : "--"} tone="sky" />
          <Metric label="Señales live" value={summary ? String(summary.metrics.opportunitiesDetected) : "--"} tone="zinc" />
          <Metric label="Latencia live" value={summary ? `${summary.metrics.averageDetectionLatencyMs}ms` : "--"} tone="sky" />
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-3xl border border-zinc-200 bg-white p-6">
          <p className="font-mono text-[10px] font-black uppercase text-amber-700">Por qué rechazamos</p>
          <h2 className="mt-2 text-2xl font-black text-zinc-950">La disciplina también es resultado</h2>
          <div className="mt-5 grid gap-3">
            {Object.entries(benchmark?.rejectedByCause ?? {}).map(([cause, value]) => (
              <div className="flex items-center justify-between rounded-xl border border-zinc-100 bg-zinc-50 px-4 py-3" key={cause}>
                <span className="text-sm font-black capitalize text-zinc-700">{cause}</span>
                <strong className="font-mono text-sm text-amber-700">{value}</strong>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-3xl border border-zinc-200 bg-white p-6">
          <p className="font-mono text-[10px] font-black uppercase text-sky-700">Shadow Learning</p>
          <h2 className="mt-2 text-2xl font-black text-zinc-950">Aprender sin perseguir ruido</h2>
          <div className="mt-5 grid grid-cols-2 gap-3">
            <Metric label="Evaluadas" value={String(benchmark?.shadowLearning.evaluatedSignals ?? "--")} tone="sky" />
            <Metric label="Avoided losses" value={String(benchmark?.shadowLearning.avoidedLosses ?? "--")} tone="emerald" />
            <Metric label="Avoided $" value={`$${benchmark?.shadowLearning.avoidedLossUsd ?? "--"}`} tone="emerald" />
            <Metric label="Model hit" value={`${benchmark?.shadowLearning.hitRatePct ?? "--"}%`} tone="sky" />
          </div>
        </div>
      </section>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full border border-sky-200 bg-sky-50 px-3 py-1.5 font-mono text-[10px] font-black uppercase text-sky-700">{children}</span>;
}

function Metric({ label, tone, value }: { label: string; tone: "amber" | "emerald" | "sky" | "zinc"; value: string }) {
  const colors = {
    amber: "border-amber-100 text-amber-700",
    emerald: "border-emerald-100 text-emerald-700",
    sky: "border-sky-100 text-sky-700",
    zinc: "border-zinc-200 text-zinc-800"
  };
  return (
    <div className={`min-w-0 rounded-xl border bg-white/80 px-3 py-3 ${colors[tone]}`}>
      <span className="block font-mono text-[9px] font-black uppercase text-zinc-500">{label}</span>
      <strong className="mt-1 block truncate font-mono text-sm font-black">{value}</strong>
    </div>
  );
}

