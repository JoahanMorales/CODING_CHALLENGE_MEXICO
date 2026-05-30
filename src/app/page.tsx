import Link from "next/link";
import { AetFlowCanvas } from "@/components/AetFlowCanvas";
import { PublicHealthBadge } from "@/components/PublicHealthBadge";
import { PublicSiteFooter } from "@/components/PublicSiteFooter";
import { PublicSiteHeader } from "@/components/PublicSiteHeader";

export default function Home() {
  return (
    <main className="min-h-screen bg-[#f8fcff] text-zinc-900">
      <PublicSiteHeader />
      <section className="border-b border-sky-100 px-5 py-12 sm:py-16">
        <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[0.92fr_1.08fr] lg:items-center">
          <div>
            <PublicHealthBadge />
            <h1 className="mt-6 max-w-3xl text-5xl font-black leading-[1.02] text-zinc-950 sm:text-7xl">
              ArbitrAI
            </h1>
            <p className="mt-4 max-w-xl text-lg font-semibold leading-8 text-zinc-600">
              Inteligencia cuantitativa para arbitraje BTC. Siete mercados, costos realistas y una terminal que explica por qué cada oportunidad se ejecuta o se descarta.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link className="rounded-xl border border-sky-600 bg-sky-600 px-5 py-3 text-sm font-black text-white shadow-lg shadow-sky-200 transition hover:bg-sky-700" href="/terminal">
                Abrir terminal en vivo
              </Link>
              <Link className="rounded-xl border border-zinc-200 bg-white px-5 py-3 text-sm font-black text-zinc-700 transition hover:border-sky-200 hover:text-sky-700" href="/inteligencia">
                Explorar el modelo AET
              </Link>
            </div>
            <div className="mt-10 grid max-w-xl grid-cols-3 gap-3">
              <HeroMetric label="Mercados" value="7" />
              <HeroMetric label="Rutas estadísticas" value="21" />
              <HeroMetric label="Objetivo" value="<5ms" />
            </div>
          </div>

          <div className="relative min-h-[380px] overflow-hidden rounded-3xl border border-sky-100 bg-white shadow-xl shadow-sky-100/70">
            <div className="absolute inset-x-0 top-0 flex items-center justify-between border-b border-sky-100 bg-sky-50/70 px-5 py-4">
              <span className="font-mono text-[10px] font-black uppercase text-sky-700">ArbitrAI Edge Tensor</span>
              <span className="font-mono text-[10px] font-black uppercase text-emerald-700">mapa de supervivencia</span>
            </div>
            <div className="absolute inset-x-0 bottom-0 grid grid-cols-3 gap-px border-t border-sky-100 bg-sky-100">
              <CanvasMetric label="MLOFI" value="top-5" />
              <CanvasMetric label="Supervivencia" value="72%" />
              <CanvasMetric label="Cola" value="score" />
            </div>
            <div className="absolute inset-x-0 bottom-16 top-14">
              <AetFlowCanvas />
            </div>
          </div>
        </div>
      </section>

      <section className="px-5 py-12">
        <div className="mx-auto max-w-7xl">
          <p className="font-mono text-[10px] font-black uppercase text-sky-700">Una lectura más honesta del mercado</p>
          <div className="mt-3 grid gap-5 lg:grid-cols-3">
            <FeatureBlock number="01" title="Primero sobrevive costos">
              Comisiones, deslizamiento, latencia e impacto se descuentan antes de considerar una señal ejecutable.
            </FeatureBlock>
            <FeatureBlock number="02" title="Aprende incluso al rechazar">
              Shadow Learning evalúa el resultado posterior de cada señal y calibra AET incluso cuando una oportunidad fue descartada.
            </FeatureBlock>
            <FeatureBlock number="03" title="Prueba sin fingir dinero real">
              El P&L paper y la validación firmada TEST_ORDER aparecen separados para no confundir simulación con dinero real.
            </FeatureBlock>
          </div>
        </div>
      </section>
      <PublicSiteFooter />
    </main>
  );
}

function HeroMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-sky-100 bg-white px-3 py-3">
      <span className="block font-mono text-[9px] font-black uppercase text-zinc-500">{label}</span>
      <strong className="mt-1 block font-mono text-xl font-black text-sky-700">{value}</strong>
    </div>
  );
}

function CanvasMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white px-4 py-3 text-center">
      <span className="block font-mono text-[9px] font-black uppercase text-zinc-500">{label}</span>
      <strong className="mt-1 block font-mono text-xs font-black text-sky-700">{value}</strong>
    </div>
  );
}

function FeatureBlock({ children, number, title }: { children: React.ReactNode; number: string; title: string }) {
  return (
    <article className="border-l-2 border-sky-200 px-5 py-3">
      <span className="font-mono text-xs font-black text-sky-600">{number}</span>
      <h2 className="mt-3 text-xl font-black text-zinc-950">{title}</h2>
      <p className="mt-2 text-sm font-semibold leading-6 text-zinc-500">{children}</p>
    </article>
  );
}
