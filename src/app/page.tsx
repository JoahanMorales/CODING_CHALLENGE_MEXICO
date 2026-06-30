import Link from "next/link";
import { AetFlowCanvas } from "@/components/AetFlowCanvas";
import { PublicHealthBadge } from "@/components/PublicHealthBadge";
import { PublicSiteFooter } from "@/components/PublicSiteFooter";
import { PublicSiteHeader } from "@/components/PublicSiteHeader";
import { EXCHANGE_IDS, EXCHANGE_LABELS } from "@/lib/config/exchanges";

export default function Home() {
  return (
    <main className="min-h-screen text-zinc-900">
      <PublicSiteHeader />

      <section className="px-5 py-12 sm:py-20">
        <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[0.94fr_1.06fr] lg:items-center">
          <div className="fade-up">
            <PublicHealthBadge />
            <h1 className="mt-6 text-6xl font-black leading-[0.95] tracking-tight sm:text-8xl">
              <span className="text-gradient">ArbitrAI</span>
            </h1>
            <p className="mt-5 max-w-xl text-lg font-semibold leading-8 text-zinc-600 sm:text-xl">
              Inteligencia cuantitativa para arbitraje BTC. Siete mercados en vivo, costos
              realistas y una terminal que explica <span className="text-zinc-900">por qué</span> cada
              oportunidad se ejecuta o se descarta.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                className="group inline-flex items-center gap-2 rounded-xl bg-sky-600 px-6 py-3.5 text-sm font-black text-white shadow-lg shadow-sky-300/50 transition hover:-translate-y-0.5 hover:bg-sky-700 hover:shadow-sky-300/70"
                href="/terminal"
              >
                <span className="live-dot inline-block h-2 w-2 rounded-full bg-emerald-300" />
                Abrir terminal en vivo
                <span className="transition group-hover:translate-x-0.5">→</span>
              </Link>
              <Link
                className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 bg-white/80 px-6 py-3.5 text-sm font-black text-zinc-700 backdrop-blur transition hover:-translate-y-0.5 hover:border-sky-200 hover:text-sky-700"
                href="/inteligencia"
              >
                Explorar el modelo AET
              </Link>
            </div>
            <div className="mt-10 grid max-w-xl grid-cols-2 gap-3 sm:grid-cols-4">
              <HeroMetric label="Mercados" value="7" tone="sky" />
              <HeroMetric label="Rutas stat-arb" value="21" tone="violet" />
              <HeroMetric label="Estrategias" value="3" tone="emerald" />
              <HeroMetric label="Latencia obj." value="<5ms" tone="amber" />
            </div>
          </div>

          <div className="fade-up relative min-h-[400px] overflow-hidden rounded-3xl border border-sky-100 bg-white/85 backdrop-blur elev-lift">
            <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between border-b border-sky-100 bg-gradient-to-r from-sky-50/90 via-white/80 to-violet-50/80 px-5 py-4">
              <span className="flex items-center gap-2 font-mono text-[10px] font-black uppercase tracking-wider text-sky-700">
                <span className="live-dot inline-block h-1.5 w-1.5 rounded-full bg-sky-500" />
                ArbitrAI Edge Tensor
              </span>
              <span className="font-mono text-[10px] font-black uppercase tracking-wider text-emerald-700">mapa de supervivencia</span>
            </div>
            <div className="absolute inset-x-0 bottom-0 z-10 grid grid-cols-3 gap-px border-t border-sky-100 bg-sky-100/70">
              <CanvasMetric label="MLOFI" value="top-5" />
              <CanvasMetric label="Supervivencia" value="72%" />
              <CanvasMetric label="Cola" value="exp. value" />
            </div>
            <div className="absolute inset-x-0 bottom-16 top-14">
              <AetFlowCanvas />
            </div>
          </div>
        </div>

        <div className="mx-auto mt-14 max-w-7xl">
          <p className="text-center font-mono text-[10px] font-black uppercase tracking-[0.2em] text-zinc-400">
            Order books normalizados en vivo
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2.5">
            {EXCHANGE_IDS.map((id) => (
              <span
                key={id}
                className="rounded-full border border-zinc-200 bg-white/70 px-4 py-1.5 font-mono text-xs font-black text-zinc-600 backdrop-blur transition hover:border-sky-200 hover:text-sky-700"
              >
                {EXCHANGE_LABELS[id]}
              </span>
            ))}
          </div>
        </div>
      </section>

      <section className="px-5 py-14">
        <div className="mx-auto max-w-7xl">
          <p className="font-mono text-[10px] font-black uppercase tracking-[0.2em] text-sky-700">Una lectura más honesta del mercado</p>
          <h2 className="mt-3 max-w-2xl text-3xl font-black tracking-tight text-zinc-950 sm:text-4xl">
            No detecta spreads. Detecta los que sobreviven a la realidad.
          </h2>
          <div className="mt-8 grid gap-5 lg:grid-cols-3">
            <FeatureBlock number="01" title="Primero sobrevive costos" tone="sky">
              Comisiones por venue, deslizamiento contra depth real, latencia e impacto de mercado se
              descuentan antes de considerar una señal ejecutable.
            </FeatureBlock>
            <FeatureBlock number="02" title="Aprende incluso al rechazar" tone="violet">
              Shadow Learning evalúa el resultado posterior de cada señal y calibra AET aun cuando una
              oportunidad fue descartada — y un modelo ML actúa como segunda opinión.
            </FeatureBlock>
            <FeatureBlock number="03" title="Prueba sin fingir dinero real" tone="emerald">
              El P&amp;L paper y la validación firmada TEST_ORDER aparecen separados para no confundir
              simulación con dinero real.
            </FeatureBlock>
          </div>
        </div>
      </section>

      <section className="px-5 pb-16">
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-4 md:grid-cols-3">
            <StrategyTeaser code="CROSS_EXCHANGE" name="Cross-exchange" tone="sky">
              Compra el mejor ask de un venue y vende el mejor bid de otro, solo si el spread neto sobrevive.
            </StrategyTeaser>
            <StrategyTeaser code="TRIANGULAR" name="Triangular" tone="emerald">
              Ciclo BTC → USDT → ETH → BTC dentro de un venue, con VWAP en cada una de las tres patas.
            </StrategyTeaser>
            <StrategyTeaser code="STAT_ARB" name="Stat arb" tone="violet">
              Mean reversion multi-venue con Z-score, half-life por MLE de OU y corrección FDR.
            </StrategyTeaser>
          </div>

          <div className="mt-10 overflow-hidden rounded-3xl border border-sky-100 bg-gradient-to-r from-sky-50 via-white to-violet-50 p-8 elev sm:p-10">
            <div className="flex flex-col items-start justify-between gap-5 sm:flex-row sm:items-center">
              <div>
                <h3 className="text-2xl font-black tracking-tight text-zinc-950 sm:text-3xl">Velo el motor decidir en tiempo real.</h3>
                <p className="mt-2 max-w-xl text-sm font-semibold leading-6 text-zinc-600">
                  Cada señal con su score, valor esperado, supervivencia AET y la razón exacta del veredicto.
                </p>
              </div>
              <Link
                className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-zinc-900 px-6 py-3.5 text-sm font-black text-white shadow-lg transition hover:-translate-y-0.5 hover:bg-zinc-800"
                href="/terminal"
              >
                Entrar a la terminal →
              </Link>
            </div>
          </div>
        </div>
      </section>

      <PublicSiteFooter />
    </main>
  );
}

const metricTone: Record<string, string> = {
  sky: "text-sky-700",
  violet: "text-violet-700",
  emerald: "text-emerald-700",
  amber: "text-amber-700"
};

function HeroMetric({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="rounded-2xl border border-zinc-200/80 bg-white/80 px-4 py-3.5 backdrop-blur elev-lift">
      <span className="block font-mono text-[9px] font-black uppercase tracking-wider text-zinc-400">{label}</span>
      <strong className={`mt-1 block font-mono text-2xl font-black ${metricTone[tone]}`}>{value}</strong>
    </div>
  );
}

function CanvasMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white/85 px-4 py-3 text-center backdrop-blur">
      <span className="block font-mono text-[9px] font-black uppercase tracking-wider text-zinc-400">{label}</span>
      <strong className="mt-1 block font-mono text-xs font-black text-sky-700">{value}</strong>
    </div>
  );
}

const blockTone: Record<string, string> = {
  sky: "border-sky-200 text-sky-600",
  violet: "border-violet-200 text-violet-600",
  emerald: "border-emerald-200 text-emerald-600"
};

function FeatureBlock({ children, number, title, tone }: { children: React.ReactNode; number: string; title: string; tone: string }) {
  return (
    <article className="group rounded-2xl border border-zinc-200/70 bg-white/75 p-6 backdrop-blur elev-lift">
      <span className={`inline-flex h-9 w-9 items-center justify-center rounded-xl border bg-white font-mono text-xs font-black ${blockTone[tone]}`}>{number}</span>
      <h3 className="mt-4 text-xl font-black tracking-tight text-zinc-950">{title}</h3>
      <p className="mt-2 text-sm font-semibold leading-6 text-zinc-500">{children}</p>
    </article>
  );
}

const teaserTone: Record<string, string> = {
  sky: "bg-sky-50 text-sky-700 border-sky-200",
  emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
  violet: "bg-violet-50 text-violet-700 border-violet-200"
};

function StrategyTeaser({ children, code, name, tone }: { children: React.ReactNode; code: string; name: string; tone: string }) {
  return (
    <article className="rounded-2xl border border-zinc-200/70 bg-white/75 p-5 backdrop-blur elev-lift">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-black tracking-tight text-zinc-950">{name}</h3>
        <span className={`rounded-full border px-2.5 py-1 font-mono text-[9px] font-black uppercase tracking-wider ${teaserTone[tone]}`}>{code}</span>
      </div>
      <p className="mt-2 text-sm font-semibold leading-6 text-zinc-500">{children}</p>
    </article>
  );
}
