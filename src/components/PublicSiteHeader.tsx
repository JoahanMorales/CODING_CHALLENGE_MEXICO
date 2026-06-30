"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";

const links = [
  { href: "/", label: "Inicio" },
  { href: "/terminal", label: "Terminal" },
  { href: "/inteligencia", label: "Inteligencia" },
  { href: "/resultados", label: "Resultados" }
];

export function PublicSiteHeader({ compact = false }: { compact?: boolean }) {
  const pathname = usePathname();
  return (
    <header className={`sticky top-0 z-[80] isolate border-b border-white/60 bg-white/70 backdrop-blur-xl backdrop-saturate-150 ${compact ? "px-4 py-2" : "px-5 py-3.5"}`}>
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
        <BrandMark compact={compact} />
        <nav aria-label="Navegacion principal" className="flex max-w-full items-center gap-1 overflow-x-auto rounded-xl border border-zinc-200/80 bg-white/60 p-1 shadow-sm">
          {links.map((link) => {
            const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
            return (
              <Link
                aria-current={active ? "page" : undefined}
                className={`whitespace-nowrap rounded-lg px-3.5 py-2 text-xs font-black transition ${
                  active ? "bg-sky-600 text-white shadow-sm shadow-sky-300/50" : "text-zinc-500 hover:bg-sky-50 hover:text-sky-700"
                }`}
                href={link.href}
                key={link.href}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
