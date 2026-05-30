import { AetFlowCanvas } from "@/components/AetFlowCanvas";
import { PublicSiteFooter } from "@/components/PublicSiteFooter";
import { PublicSiteHeader } from "@/components/PublicSiteHeader";

const layers = [
  ["01", "Normalize", "Siete order books llegan a un esquema común BTC/USDT con top-5 depth y timestamp de recepción."],
  ["02", "Measure", "MLOFI, microprice skew, fragmentación y EWMA de volatilidad describen presión local y riesgo de selección adversa."],
  ["03", "Price", "Fees maker/taker, retiro amortizado, slippage, latencia e impacto convierten el spread visible en edge neto."],
  ["04", "Survive", "AET estima si la ventaja persistirá durante ambas piernas y reduce tamaño cuando la profundidad no acompaña."],
  ["05", "Learn", "Markouts de 500ms, 2s y 5s actualizan una calibración por ruta incluso cuando una señal fue rechazada."]
];

export default function IntelligencePage() {
  return (
    <main className="min-h-screen bg-[#f8fcff] text-zinc-900">
      <PublicSiteHeader />
      <section className="border-b border-sky-100 px-5 py-12">
        <div className="mx-auto max-w-7xl">
          <p className="font-mono text-[10px] font-black uppercase text-sky-700">Inteligencia explicable</p>
          <div className="mt-4 grid gap-8 lg:grid-cols-[0.82fr_1.18fr] lg:items-center">
            <div>
              <h1 className="text-4xl font-black leading-tight text-zinc-950 sm:text-6xl">ArbitrAI Edge Tensor</h1>
              <p className="mt-4 max-w-xl text-base font-semibold leading-7 text-zinc-600">
                El modelo no pregunta únicamente si un bid supera un ask. Pregunta si el edge sobrevivirá costos, latencia y presión del libro el tiempo suficiente para ejecutar ambas piernas.
              </p>
            </div>
            <div className="h-[360px] overflow-hidden rounded-3xl border border-sky-100 bg-white shadow-lg shadow-sky-100/70">
              <AetFlowCanvas detailed />
            </div>
          </div>
        </div>
      </section>

      <section className="px-5 py-12">
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-3">
            {layers.map(([number, title, copy]) => (
              <article className="grid gap-4 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm sm:grid-cols-[72px_170px_1fr] sm:items-center" key={number}>
                <span className="font-mono text-2xl font-black text-sky-600">{number}</span>
                <h2 className="text-lg font-black text-zinc-950">{title}</h2>
                <p className="text-sm font-semibold leading-6 text-zinc-500">{copy}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="border-y border-sky-100 bg-white px-5 py-12">
        <div className="mx-auto max-w-7xl">
          <p className="font-mono text-[10px] font-black uppercase text-sky-700">Waterfall económico</p>
          <h2 className="mt-2 text-3xl font-black text-zinc-950">Del spread bruto al edge ejecutable</h2>
          <div className="mt-6 grid gap-3 md:grid-cols-5">
            <Waterfall label="Spread bruto" value="+18.4 bps" tone="sky" />
            <Waterfall label="Fees" value="-10.0 bps" tone="rose" />
            <Waterfall label="Slippage" value="-2.3 bps" tone="amber" />
            <Waterfall label="Adverse selection" value="-1.8 bps" tone="amber" />
            <Waterfall label="Edge neto" value="+4.3 bps" tone="emerald" />
          </div>
        </div>
      </section>

      <section className="px-5 py-12">
        <div className="mx-auto max-w-7xl">
          <p className="font-mono text-[10px] font-black uppercase text-sky-700">Referencias primarias</p>
          <div className="mt-4 grid gap-3 lg:grid-cols-3">
            <Reference href="https://arxiv.org/abs/1011.6402" title="Price Impact of Order Book Events">Order-flow imbalance como señal de impacto de corto horizonte.</Reference>
            <Reference href="https://arxiv.org/abs/1907.06230" title="Multi-Level Order-Flow Imbalance">Profundidad adicional para mejorar ajuste fuera de muestra.</Reference>
            <Reference href="https://arxiv.org/abs/1812.00595" title="Limits to Arbitrage for Blockchain-Based Assets">Costos, capital y latencia explican por qué persisten divergencias visibles.</Reference>
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

