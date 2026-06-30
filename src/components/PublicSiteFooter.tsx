export function PublicSiteFooter() {
  return (
    <footer className="mt-4 border-t border-white/60 bg-white/55 px-5 py-6 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
        <div className="flex flex-col gap-1 text-xs font-semibold text-zinc-500">
          <span className="font-mono text-[10px] font-black uppercase tracking-[0.2em] text-sky-700">CODING CHALLENGE MEXICO</span>
          <span>ArbitrAI · Joahan Samuel Morales Piña</span>
        </div>
        <div className="flex items-center gap-3">
          <a className="rounded-lg border border-zinc-200 bg-white/70 px-3 py-1.5 text-xs font-black text-zinc-600 transition hover:border-sky-200 hover:text-sky-700" href="https://github.com/JoahanMorales" rel="noreferrer" target="_blank">GitHub</a>
          <a className="rounded-lg border border-zinc-200 bg-white/70 px-3 py-1.5 text-xs font-black text-zinc-600 transition hover:border-sky-200 hover:text-sky-700" href="https://www.linkedin.com/in/joahan-morales/" rel="noreferrer" target="_blank">LinkedIn</a>
        </div>
      </div>
    </footer>
  );
}
