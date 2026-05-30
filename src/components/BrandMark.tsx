import Image from "next/image";
import Link from "next/link";

export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <Link className="flex min-w-0 items-center gap-3" href="/">
      <Image alt="Logotipo de ArbitrAI" className="h-10 w-10" height={48} priority src="/arbitrai-mark.svg" width={48} />
      <span className="min-w-0">
        <strong className="block truncate text-xl font-black text-zinc-950">ArbitrAI</strong>
        {!compact && <span className="block truncate text-[11px] font-semibold text-zinc-500">Inteligencia para arbitraje BTC</span>}
      </span>
    </Link>
  );
}
