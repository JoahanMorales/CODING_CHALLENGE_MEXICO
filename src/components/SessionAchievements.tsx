"use client";

import { useEffect, useRef, useState } from "react";
import { useArbitrageStore } from "@/store/useArbitrageStore";
import type { OpportunityType } from "@/lib/types";
import { IconAward, IconGem, IconLock, IconShield, IconTarget, IconTrendUp, IconZap } from "@/components/icons";

type IconType = (props: { className?: string }) => React.ReactNode;

interface Progress {
  fills: number;
  pnl: number;
  typesActive: number;
  maxStreak: number;
  survivedStress: boolean;
}

interface Achievement {
  id: string;
  Icon: IconType;
  title: string;
  desc: string;
  unlocked: (p: Progress) => boolean;
}

const ACHIEVEMENTS: Achievement[] = [
  { id: "first", Icon: IconZap, title: "Primer fill", desc: "Ejecuta tu primer paper trade", unlocked: (p) => p.fills >= 1 },
  { id: "quad", Icon: IconTarget, title: "Cuádruple amenaza", desc: "Las 4 estrategias logran al menos un fill", unlocked: (p) => p.typesActive >= 4 },
  { id: "streak", Icon: IconTrendUp, title: "En racha", desc: "Una racha de 5 fills ganadores seguidos", unlocked: (p) => p.maxStreak >= 5 },
  { id: "survivor", Icon: IconShield, title: "Sobreviviente", desc: "Ejecuta durante un escenario de estrés", unlocked: (p) => p.survivedStress },
  { id: "edge", Icon: IconGem, title: "Cazador de edges", desc: "Acumula +$100 de P&L de sesión", unlocked: (p) => p.pnl >= 100 },
  { id: "century", Icon: IconAward, title: "Centurión", desc: "100 fills en una sesión", unlocked: (p) => p.fills >= 100 }
];

function xpFor(p: Progress): number {
  return Math.round(p.fills * 12 + Math.max(0, p.pnl) + p.maxStreak * 8);
}
function levelFor(xp: number): { level: number; into: number; span: number } {
  let level = 1;
  let need = 60;
  let acc = 0;
  while (xp >= acc + need) {
    acc += need;
    level += 1;
    need = Math.round(need * 1.35);
  }
  return { level, into: xp - acc, span: need };
}

export function SessionAchievements() {
  const init = useArbitrageStore((state) => state.init);
  const trades = useArbitrageStore((state) => state.trades);
  const risk = useArbitrageStore((state) => state.risk);
  const mode = useArbitrageStore((state) => state.mode);

  const seen = useRef<Set<string>>(new Set());
  const tally = useRef<Record<OpportunityType, number>>({ CROSS_EXCHANGE: 0, TRIANGULAR: 0, STAT_ARB: 0, LATENCY_ARB: 0 });
  const maxStreak = useRef(0);
  const survived = useRef(false);
  const fills = useRef(0);
  const pnl = useRef(0);
  const [progress, setProgress] = useState<Progress>({ fills: 0, pnl: 0, typesActive: 0, maxStreak: 0, survivedStress: false });

  useEffect(() => {
    init();
  }, [init]);

  useEffect(() => {
    seen.current = new Set();
    tally.current = { CROSS_EXCHANGE: 0, TRIANGULAR: 0, STAT_ARB: 0, LATENCY_ARB: 0 };
    maxStreak.current = 0;
    survived.current = false;
    fills.current = 0;
    pnl.current = 0;
    setProgress({ fills: 0, pnl: 0, typesActive: 0, maxStreak: 0, survivedStress: false });
  }, [mode]);

  useEffect(() => {
    const stressActive = risk.activeScenario !== "NONE" || risk.marketCrashMode;
    for (const trade of trades) {
      if (trade.status === "REJECTED" || seen.current.has(trade.id)) continue;
      seen.current.add(trade.id);
      fills.current += 1;
      pnl.current += Number(trade.pnlUsd);
      tally.current[trade.type] += 1;
      if (stressActive) survived.current = true;
    }
    // Longest current win streak across strategies (newest-first list).
    for (const type of Object.keys(tally.current) as OpportunityType[]) {
      let streak = 0;
      for (const trade of trades) {
        if (trade.type !== type || trade.status === "REJECTED") continue;
        if (Number(trade.pnlUsd) > 0) streak += 1;
        else break;
      }
      if (streak > maxStreak.current) maxStreak.current = streak;
    }
    setProgress({
      fills: fills.current,
      pnl: pnl.current,
      typesActive: Object.values(tally.current).filter((c) => c > 0).length,
      maxStreak: maxStreak.current,
      survivedStress: survived.current
    });
  }, [trades, risk.activeScenario, risk.marketCrashMode]);

  const xp = xpFor(progress);
  const { level, into, span } = levelFor(xp);
  const unlockedCount = ACHIEVEMENTS.filter((a) => a.unlocked(progress)).length;

  return (
    <div className="rounded-3xl border border-zinc-200/70 bg-white/80 p-5 backdrop-blur-sm elev sm:p-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="font-mono text-[10px] font-black uppercase tracking-[0.16em] text-violet-700">Progreso de la sesión</span>
        <span className="rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1 font-mono text-[10px] font-black uppercase tracking-wider text-zinc-600">
          {unlockedCount}/{ACHIEVEMENTS.length} logros
        </span>
      </div>

      <div className="mt-4 flex items-center gap-4">
        <div className="flex h-16 w-16 shrink-0 flex-col items-center justify-center rounded-2xl border border-violet-200 bg-gradient-to-br from-violet-100 to-sky-100">
          <span className="font-mono text-[8px] font-black uppercase tracking-wider text-violet-500">Nivel</span>
          <strong className="font-mono text-2xl font-black leading-none text-violet-700">{level}</strong>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-end justify-between">
            <span className="font-mono text-[11px] font-bold text-zinc-500">{xp} XP</span>
            <span className="font-mono text-[10px] font-semibold text-zinc-400">{into}/{span} al nivel {level + 1}</span>
          </div>
          <div className="mt-1.5 h-2.5 w-full overflow-hidden rounded-full bg-zinc-100">
            <div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-sky-400 transition-all duration-700" style={{ width: `${Math.min(100, (into / span) * 100)}%` }} />
          </div>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        {ACHIEVEMENTS.map((achievement) => {
          const got = achievement.unlocked(progress);
          const Glyph = got ? achievement.Icon : IconLock;
          return (
            <div
              key={achievement.id}
              className={`flex items-start gap-2.5 rounded-2xl border px-3 py-3 transition-all duration-500 ${
                got ? "border-emerald-200 bg-emerald-50/70" : "border-zinc-200/70 bg-zinc-50/40"
              }`}
            >
              <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg border ${got ? "border-emerald-200 bg-white text-emerald-600" : "border-zinc-200 bg-white text-zinc-300"}`}>
                <Glyph className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <strong className={`block text-xs font-black tracking-tight ${got ? "text-emerald-800" : "text-zinc-500"}`}>{achievement.title}</strong>
                <span className="block text-[10px] font-semibold leading-snug text-zinc-400">{achievement.desc}</span>
              </div>
            </div>
          );
        })}
      </div>

      <p className="mt-4 text-[11px] font-semibold leading-5 text-zinc-500">
        XP y logros se acumulan con la actividad real de paper trading de esta sesión. Corre un escenario de estrés desde el
        terminal para desbloquear <span className="text-zinc-700">Sobreviviente</span>.
      </p>
    </div>
  );
}
