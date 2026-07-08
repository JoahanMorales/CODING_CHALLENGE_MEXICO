import { NeuralHeroMount } from "@/components/NeuralHeroMount";

// The landing's 3D decision network as a self-contained dark card, with the
// explanatory column-aligned legend, so it can be dropped on any page (landing +
// /inteligencia) and always reads as the real pipeline, not abstract eye-candy.
// Colours match the NeuralHero layer colours so each label maps to its glowing column.
const PIPELINE: Array<{ name: string; sub: string; color: string; altColor?: string }> = [
  { name: "Mercados", sub: "7 exchanges en vivo", color: "#38bdf8" },
  { name: "Microestructura", sub: "libros L2 · spread · OFI", color: "#22d3ee" },
  { name: "Estrategias", sub: "cross-venue · triangular", color: "#818cf8" },
  { name: "Comité ML", sub: "árbol + red neuronal", color: "#34d399" },
  { name: "Riesgo", sub: "fees · latencia · tamaño", color: "#fbbf24" },
  { name: "Decisión", sub: "ejecutar / descartar", color: "#34d399", altColor: "#fb7185" }
];

export function DecisionNetworkCard({ className = "" }: { className?: string }) {
  return (
    <div className={`relative overflow-hidden rounded-3xl border border-white/10 bg-[#070b16] shadow-2xl shadow-sky-950/30 ${className}`}>
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 90% at 12% 18%, rgba(56,189,248,0.18), transparent 55%), radial-gradient(120% 90% at 88% 82%, rgba(52,211,153,0.15), transparent 55%)"
        }}
      />
      <NeuralHeroMount />
      {/* Top overline: names what the network IS. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between gap-2 px-4 pt-3.5">
        <span className="flex items-center gap-1.5 font-mono text-[10px] font-black uppercase tracking-[0.18em] text-white/70">
          <span className="live-dot inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
          Pipeline de decisión
        </span>
        <span className="hidden font-mono text-[9px] font-bold uppercase tracking-wider text-white/40 sm:inline">
          {"7 mercados → 1 verdicto · <5 ms"}
        </span>
      </div>
      {/* Bottom legend: one colour-coded label per glowing layer. Reflows 3-up on mobile. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#070b16] via-[#070b16]/92 to-transparent px-3 pb-3 pt-16">
        <div className="grid grid-cols-3 gap-x-2 gap-y-2.5 sm:grid-cols-6">
          {PIPELINE.map((stage) => (
            <div className="flex flex-col items-center text-center" key={stage.name}>
              <span
                className="flex items-center gap-1 font-mono text-[10px] font-black uppercase leading-none tracking-wide"
                style={{ color: stage.color }}
              >
                <span className="flex items-center gap-0.5">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: stage.color, boxShadow: `0 0 6px ${stage.color}` }} />
                  {stage.altColor && (
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: stage.altColor, boxShadow: `0 0 6px ${stage.altColor}` }} />
                  )}
                </span>
                {stage.name}
              </span>
              <span className="mt-1 text-[9px] font-semibold leading-tight text-white/50">{stage.sub}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
