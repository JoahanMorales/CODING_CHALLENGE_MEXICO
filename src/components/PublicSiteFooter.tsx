export function PublicSiteFooter() {
  return (
    <footer className="border-t border-sky-100 bg-white px-5 py-5">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 text-xs font-semibold text-zinc-500">
        <span>ArbitrAI · CODING CHALLENGE MEXICO · Joahan Samuel Morales Piña</span>
        <div className="flex items-center gap-4">
          <a className="font-black text-sky-700 hover:text-sky-900" href="https://github.com/JoahanMorales" rel="noreferrer" target="_blank">GitHub</a>
          <a className="font-black text-sky-700 hover:text-sky-900" href="https://www.linkedin.com/in/joahan-morales/" rel="noreferrer" target="_blank">LinkedIn</a>
        </div>
      </div>
    </footer>
  );
}
