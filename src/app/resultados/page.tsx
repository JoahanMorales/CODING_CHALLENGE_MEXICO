import { PublicSiteFooter } from "@/components/PublicSiteFooter";
import { PublicSiteHeader } from "@/components/PublicSiteHeader";
import { ResultsDashboard } from "@/components/ResultsDashboard";

export default function ResultsPage() {
  return (
    <main className="min-h-screen text-zinc-900">
      <PublicSiteHeader />
      <section className="px-5 py-12">
        <div className="mx-auto max-w-7xl">
          <p className="font-mono text-[10px] font-black uppercase text-sky-700">Resultados auditables</p>
          <h1 className="mt-3 text-4xl font-black text-zinc-950 sm:text-6xl">Evidencia, no promesas.</h1>
          <p className="mt-4 max-w-2xl text-base font-semibold leading-7 text-zinc-600">
            ArbitrAI separa el rendimiento paper, la validación firmada TEST_ORDER y la salud del gateway en vivo para que cada cifra conserve su significado.
          </p>
          <div className="mt-8">
            <ResultsDashboard />
          </div>
        </div>
      </section>
      <PublicSiteFooter />
    </main>
  );
}
