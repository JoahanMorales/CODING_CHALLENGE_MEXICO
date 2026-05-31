import { AetFlowCanvas } from "@/components/AetFlowCanvas";
import { AetPipelineDiagram } from "@/components/AetPipelineDiagram";
import { PublicSiteFooter } from "@/components/PublicSiteFooter";
import { PublicSiteHeader } from "@/components/PublicSiteHeader";

const formulas = [
  ["MLOFI", "Σ peso(nivel) × Δ profundidad", "Mide cómo cambia la presión compradora y vendedora en los primeros cinco niveles del libro."],
  ["Microprice", "(ask × volumen bid + bid × volumen ask) / volumen total", "Ajusta el precio medio con el desequilibrio visible en la punta del libro."],
  ["Execution Net P&L", "gross edge - fees - slippage - quote basis - execution risk", "Separa el resultado operativo inmediato del costo periódico de rebalancear inventario entre venues."],
  ["Rebalance-adjusted P&L", "execution net - withdrawal amortization", "Permite comparar rutas prefunded sin ocultar el costo económico de recuperar la asignación inicial."],
  ["Expected Value", "P(fill A ∩ fill B) × P&L ajustado - P(leg risk) × unwind cost", "Prioriza señales por valor esperado y no por un spread que podría desaparecer antes de completar ambas piernas."],
  ["Supervivencia AET", "sigmoid(edge - adverse selection - latency - impact + calibration bias)", "Estima si la oportunidad seguirá existiendo al completar ambas piernas y se recalibra con markouts observados."]
];

export default function IntelligencePage() {
  return (
    <main className="min-h-screen bg-[#f8fcff] text-zinc-900">
      <PublicSiteHeader />
      <section className="border-b border-sky-100 px-5 py-12">
        <div className="mx-auto max-w-7xl">
          <p className="font-mono text-[10px] font-black uppercase text-sky-700">Modelo cuantitativo explicable</p>
          <div className="mt-4 grid gap-8 lg:grid-cols-[0.82fr_1.18fr] lg:items-center">
            <div>
              <h1 className="text-4xl font-black leading-tight text-zinc-950 sm:text-6xl">ArbitrAI Edge Tensor</h1>
              <p className="mt-4 max-w-xl text-base font-semibold leading-7 text-zinc-600">
                Un spread visible no basta. AET calcula si la diferencia de precio conserva valor después de comisiones, deslizamiento, latencia, profundidad disponible y riesgo de que el libro se mueva en contra.
              </p>
              <p className="mt-3 max-w-xl text-sm font-semibold leading-6 text-zinc-500">
                El resultado es una decisión trazable: ejecutar, reducir tamaño, observar o descartar.
              </p>
            </div>
            <div className="h-[340px] overflow-hidden rounded-3xl border border-sky-100 bg-white shadow-lg shadow-sky-100/70 sm:h-[420px]">
              <AetFlowCanvas detailed />
            </div>
          </div>
        </div>
      </section>

      <section className="px-5 py-12">
        <div className="mx-auto max-w-7xl">
          <p className="font-mono text-[10px] font-black uppercase text-sky-700">Pipeline completo</p>
          <h2 className="mt-2 max-w-3xl text-3xl font-black text-zinc-950">De siete libros de órdenes a una ejecución priorizada</h2>
          <p className="mt-3 max-w-3xl text-sm font-semibold leading-6 text-zinc-500">
            Cada bloque tiene una responsabilidad acotada. El motor procesa los eventos coalesced del scanner; la interfaz recibe una versión resumida para mantenerse fluida.
          </p>
          <div className="mt-6">
            <AetPipelineDiagram />
          </div>
        </div>
      </section>

      <section className="border-y border-sky-100 bg-white px-5 py-12">
        <div className="mx-auto max-w-7xl">
          <p className="font-mono text-[10px] font-black uppercase text-sky-700">Núcleo matemático</p>
          <h2 className="mt-2 text-3xl font-black text-zinc-950">Variables observables, decisiones auditables</h2>
          <div className="mt-6 grid gap-3 lg:grid-cols-2">
            {formulas.map(([name, formula, explanation]) => (
              <article className="rounded-2xl border border-zinc-200 bg-[#fbfdff] p-5" key={name}>
                <h3 className="text-lg font-black text-zinc-950">{name}</h3>
                <code className="mt-3 block overflow-x-auto rounded-lg border border-sky-100 bg-sky-50 px-3 py-2 font-mono text-xs font-black text-sky-800">{formula}</code>
                <p className="mt-3 text-sm font-semibold leading-6 text-zinc-500">{explanation}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="px-5 py-12">
        <div className="mx-auto max-w-7xl">
          <p className="font-mono text-[10px] font-black uppercase text-sky-700">Waterfall económico</p>
          <h2 className="mt-2 text-3xl font-black text-zinc-950">Del spread bruto al beneficio ejecutable</h2>
          <p className="mt-3 max-w-2xl text-sm font-semibold leading-6 text-zinc-500">Ejemplo ilustrativo medido en puntos base: un punto base equivale a 0.01%.</p>
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Waterfall label="Spread bruto" value="+18.4 bps" tone="sky" />
            <Waterfall label="Comisiones" value="-10.0 bps" tone="rose" />
            <Waterfall label="Deslizamiento" value="-2.3 bps" tone="amber" />
            <Waterfall label="Selección adversa" value="-1.8 bps" tone="amber" />
            <Waterfall label="Edge neto" value="+4.3 bps" tone="emerald" />
          </div>
        </div>
      </section>

      <section className="border-t border-sky-100 bg-white px-5 py-12">
        <div className="mx-auto max-w-7xl">
          <p className="font-mono text-[10px] font-black uppercase text-sky-700">Referencias primarias</p>
          <div className="mt-4 grid gap-3 lg:grid-cols-3">
            <Reference href="https://arxiv.org/abs/1011.6402" title="Price Impact of Order Book Events">Fundamento para usar desequilibrio del flujo de órdenes como señal de impacto a corto horizonte.</Reference>
            <Reference href="https://arxiv.org/abs/1907.06230" title="Multi-Level Order-Flow Imbalance">Motivación para incorporar varios niveles de profundidad y no depender únicamente del mejor bid y ask.</Reference>
            <Reference href="https://arxiv.org/abs/1812.00595" title="Limits to Arbitrage for Blockchain-Based Assets">Marco para considerar costos, capital, latencia y fricciones operativas antes de ejecutar.</Reference>
          </div>
        </div>
      </section>
      <PublicSiteFooter />
    </main>
  );
}

function Waterfall({ label, tone, value }: { label: string; tone: "amber" | "emerald" | "rose" | "sky"; value: string }) {
  const colors = {
    amber: "border-amber-200 bg-amber-50 text-amber-700",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-700",
    rose: "border-rose-200 bg-rose-50 text-rose-700",
    sky: "border-sky-200 bg-sky-50 text-sky-700"
  };
  return (
    <div className={`rounded-xl border px-4 py-5 ${colors[tone]}`}>
      <span className="block text-xs font-black">{label}</span>
      <strong className="mt-3 block font-mono text-xl font-black">{value}</strong>
    </div>
  );
}

function Reference({ children, href, title }: { children: React.ReactNode; href: string; title: string }) {
  return (
    <a className="rounded-2xl border border-zinc-200 bg-white p-5 transition hover:border-sky-300 hover:shadow-md" href={href} rel="noreferrer" target="_blank">
      <strong className="block text-base font-black text-zinc-950">{title}</strong>
      <span className="mt-2 block text-sm font-semibold leading-6 text-zinc-500">{children}</span>
    </a>
  );
}
