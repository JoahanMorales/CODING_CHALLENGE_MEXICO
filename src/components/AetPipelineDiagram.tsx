import { Fragment } from "react";

interface StageInfo {
  code: string;
  title: string;
  text: string;
  tone: string;
}

const phases: {
  label: string;
  description: string;
  tone: string;
  stages: StageInfo[];
}[] = [
  {
    label: "DATA INTAKE",
    description: "Captura y validación de datos crudos del mercado",
    tone: "sky",
    stages: [
      { code: "01", title: "Feeds públicos", text: "Siete venues envían order books por WebSocket. REST entra únicamente si un feed pierde frescura.", tone: "sky" },
      { code: "02", title: "Integridad", text: "Los libros reconstruidos vigilan sequence gaps. Kraken valida CRC32 antes de admitir precios al scanner.", tone: "sky" },
      { code: "03", title: "Quote normalization", text: "BTC/USD y BTC/USDT se convierten a USD comparable usando el basis USDT/USD sin perder el source price.", tone: "sky" },
    ],
  },
  {
    label: "ANÁLISIS",
    description: "Microestructura, costos y valor esperado",
    tone: "emerald",
    stages: [
      { code: "04", title: "Microestructura", text: "MLOFI top-5, microprice y volatilidad estiman presión inmediata y adverse selection.", tone: "emerald" },
      { code: "05", title: "Economía real", text: "Execution cost y rebalance cost se calculan por separado: fees, slippage, quote basis, latencia y retiro amortizado.", tone: "amber" },
      { code: "06", title: "Expected Value", text: "AET pondera fill probability de ambas piernas y penaliza el costo de unwind cuando una sola pierna sobrevive.", tone: "emerald" },
    ],
  },
  {
    label: "EJECUCIÓN",
    description: "Validación previa y máquina de estados",
    tone: "violet",
    stages: [
      { code: "07", title: "Preflight", text: "Antes de entrar a la queue valida frescura, integridad e inventario prefunded disponible para ambas piernas.", tone: "rose" },
      { code: "08", title: "State machine", text: "Cada señal conserva una traza: detected, validated, reserved, leg A, leg B y reconciled.", tone: "violet" },
    ],
  },
  {
    label: "APRENDIZAJE",
    description: "Shadow learning y cortafuegos",
    tone: "rose",
    stages: [
      { code: "09", title: "Shadow Learning", text: "Markouts a 100 ms, 500 ms y 2 s recalibran survival probability por ruta, incluso si la señal se descarta.", tone: "sky" },
      { code: "10", title: "Circuit breaker", text: "El motor detiene nuevas ejecuciones tras tres pérdidas materiales o al romper el daily loss limit.", tone: "rose" },
    ],
  },
];

const phaseColors: Record<string, { border: string; bg: string; badge: string; text: string; arrow: string }> = {
  sky: { border: "border-sky-200", bg: "bg-sky-50/60", badge: "bg-sky-600 text-white", text: "text-sky-700", arrow: "stroke-sky-300" },
  emerald: { border: "border-emerald-200", bg: "bg-emerald-50/60", badge: "bg-emerald-600 text-white", text: "text-emerald-700", arrow: "stroke-emerald-300" },
  violet: { border: "border-violet-200", bg: "bg-violet-50/60", badge: "bg-violet-600 text-white", text: "text-violet-700", arrow: "stroke-violet-300" },
  rose: { border: "border-rose-200", bg: "bg-rose-50/60", badge: "bg-rose-600 text-white", text: "text-rose-700", arrow: "stroke-rose-300" },
};

export function AetPipelineDiagram() {
  return (
    <div className="space-y-0">
      {phases.map((phase, phaseIndex) => {
        const colors = phaseColors[phase.tone] ?? phaseColors.sky;
        return (
          <Fragment key={phase.label}>
            {phaseIndex > 0 && (
              <div className="flex justify-center py-3">
                <VerticalArrow color={phaseColors[phases[phaseIndex - 1].tone]?.arrow ?? "stroke-sky-300"} />
              </div>
            )}
            <PhaseSection
              colors={colors}
              description={phase.description}
              label={phase.label}
              stages={phase.stages}
            />
          </Fragment>
        );
      })}
    </div>
  );
}

function PhaseSection({
  colors,
  label,
  description,
  stages,
}: {
  colors: { border: string; bg: string; badge: string; text: string; arrow: string };
  label: string;
  description: string;
  stages: StageInfo[];
}) {
  return (
    <div className={`rounded-2xl border ${colors.border} ${colors.bg} p-4 sm:p-5`}>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className={`rounded-lg ${colors.badge} px-3 py-1 font-mono text-[11px] font-black tracking-wider`}>
          {label}
        </span>
        <span className="text-xs font-semibold text-zinc-500">{description}</span>
      </div>
      <div className="flex flex-wrap items-start gap-2 sm:gap-3">
        {stages.map((stage, index) => (
          <Fragment key={stage.code}>
            {index > 0 && (
              <div className="mt-8 hidden self-center sm:block">
                <RightArrow color={colors.arrow} />
              </div>
            )}
            <StageCard isLast={index === stages.length - 1} stage={stage} />
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function StageCard({ stage, isLast }: { stage: StageInfo; isLast: boolean }) {
  const dotColors: Record<string, string> = {
    sky: "border-sky-300 bg-sky-100 text-sky-700",
    emerald: "border-emerald-300 bg-emerald-100 text-emerald-700",
    amber: "border-amber-300 bg-amber-100 text-amber-700",
    rose: "border-rose-300 bg-rose-100 text-rose-700",
    violet: "border-violet-300 bg-violet-100 text-violet-700",
  };
  return (
    <article className="relative flex-1 basis-[180px] rounded-xl border border-zinc-200 bg-white p-4 shadow-sm transition hover:shadow-md">
      <span
        className={`flex h-7 w-7 items-center justify-center rounded-full border font-mono text-[11px] font-black ${dotColors[stage.tone] ?? dotColors.sky}`}
      >
        {stage.code}
      </span>
      <h3 className="mt-3 text-sm font-black text-zinc-950">{stage.title}</h3>
      <p className="mt-1.5 text-[11px] font-semibold leading-5 text-zinc-500">{stage.text}</p>
      {!isLast && (
        <div className="mt-3 border-t border-dashed border-zinc-200 pt-2 text-center sm:hidden">
          <span className="font-mono text-xs font-black text-zinc-300">↓</span>
        </div>
      )}
    </article>
  );
}

function RightArrow({ color }: { color: string }) {
  return (
    <svg className={`h-6 w-6 ${color}`} fill="none" viewBox="0 0 24 24">
      <path d="M5 12h14M13 5l7 7-7 7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} />
    </svg>
  );
}

function VerticalArrow({ color }: { color: string }) {
  return (
    <svg className={`h-6 w-6 ${color}`} fill="none" viewBox="0 0 24 24">
      <path d="M12 5v14M5 11l7 7 7-7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} />
    </svg>
  );
}
