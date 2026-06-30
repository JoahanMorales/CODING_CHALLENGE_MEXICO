import { PublicSiteFooter } from "@/components/PublicSiteFooter";
import { PublicSiteHeader } from "@/components/PublicSiteHeader";
import { StrategyTournament } from "@/components/StrategyTournament";

export default function TournamentPage() {
  return (
    <main className="min-h-screen text-zinc-900">
      <PublicSiteHeader />
      <section className="px-4 py-10 sm:px-5 sm:py-12">
        <div className="mx-auto max-w-4xl">
          <p className="font-mono text-[10px] font-black uppercase tracking-wider text-sky-700">Cuatro motores, una pista</p>
          <h1 className="mt-3 text-3xl font-black tracking-tight text-zinc-950 sm:text-5xl">Torneo de estrategias.</h1>
          <p className="mt-4 max-w-2xl text-sm font-semibold leading-7 text-zinc-600 sm:text-base">
            Las cuatro estrategias de ArbitrAI corren en paralelo sobre el mismo mercado y compiten con su P&L real de
            paper trading. El podio se reordena en vivo: mira cuál encuentra el edge primero.
          </p>
          <div className="mt-8">
            <StrategyTournament />
          </div>
        </div>
      </section>
      <PublicSiteFooter />
    </main>
  );
}
