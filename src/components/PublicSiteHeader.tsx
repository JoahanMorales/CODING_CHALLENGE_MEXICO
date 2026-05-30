import Link from "next/link";

const links = [
  { href: "/", label: "Inicio" },
  { href: "/terminal", label: "Terminal" },
  { href: "/inteligencia", label: "Inteligencia" },
  { href: "/resultados", label: "Resultados" }
];

export function PublicSiteHeader({ compact = false }: { compact?: boolean }) {
  return (
    <header className={`border-b border-sky-100/80 bg-white/90 backdrop-blur ${compact ? "px-4 py-2" : "px-5 py-4"}`}>
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
        <Link className="flex items-center gap-3" href="/">
          <span className="grid h-10 w-10 place-items-center rounded-xl border border-sky-200 bg-sky-50 font-mono text-xs font-black text-sky-700">
            AI
          </span>
          <span>
            <strong className="block text-xl font-black text-zinc-950">ArbitrAI</strong>
            {!compact && <span className="block text-[11px] font-semibold text-zinc-500">BTC arbitrage intelligence</span>}
          </span>
        </Link>
        <nav className="flex flex-wrap items-center gap-1 rounded-xl border border-zinc-200 bg-zinc-50/80 p-1">
          {links.map((link) => (
            <Link className="rounded-lg px-3 py-2 text-xs font-black text-zinc-600 transition hover:bg-white hover:text-sky-700" href={link.href} key={link.href}>
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}

