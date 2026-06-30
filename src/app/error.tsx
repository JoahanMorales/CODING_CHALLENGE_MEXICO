"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("ArbitrAI route error:", error);
  }, [error]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f7fbff] px-5 py-12 text-zinc-900">
      <div className="w-full max-w-lg rounded-3xl border border-rose-200/70 bg-white/90 p-8 shadow-sm shadow-rose-100/70 backdrop-blur-sm">
        <p className="font-mono text-[10px] font-black uppercase tracking-[0.16em] text-rose-700">Error de interfaz</p>
        <h1 className="mt-3 text-2xl font-black tracking-tight text-zinc-950 sm:text-3xl">Un panel falló al renderizar.</h1>
        <p className="mt-3 text-sm font-semibold leading-6 text-zinc-600">
          El motor de arbitraje y el gateway siguen corriendo de forma independiente — esto es solo un fallo de la interfaz.
          Reintenta el render o vuelve al inicio.
        </p>
        {error.message && (
          <p className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 font-mono text-[11px] font-semibold text-zinc-500">
            {error.digest ? `[${error.digest}] ` : ""}{error.message}
          </p>
        )}
        <div className="mt-6 flex flex-wrap gap-3">
          <button
            className="inline-flex items-center gap-2 rounded-xl bg-sky-600 px-5 py-3 text-sm font-black text-white shadow-lg shadow-sky-300/50 transition hover:-translate-y-0.5 hover:bg-sky-700"
            onClick={reset}
            type="button"
          >
            Reintentar
          </button>
          <Link
            className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-5 py-3 text-sm font-black text-zinc-700 transition hover:-translate-y-0.5 hover:border-sky-200 hover:text-sky-700"
            href="/"
          >
            Volver al inicio
          </Link>
        </div>
      </div>
    </main>
  );
}
