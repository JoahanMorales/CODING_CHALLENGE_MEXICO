const stages = [
  { code: "01", title: "Feeds públicos", text: "Siete venues envían order books por WebSocket. REST entra únicamente si un feed pierde frescura.", tone: "sky" },
  { code: "02", title: "Integridad", text: "Los libros reconstruidos vigilan sequence gaps. Kraken valida CRC32 antes de admitir precios al scanner.", tone: "sky" },
  { code: "03", title: "Quote normalization", text: "BTC/USD y BTC/USDT se convierten a USD comparable usando el basis USDT/USD sin perder el source price.", tone: "sky" },
  { code: "04", title: "Microestructura", text: "MLOFI top-5, microprice y volatilidad estiman presión inmediata y adverse selection.", tone: "emerald" },
  { code: "05", title: "Economía real", text: "Execution cost y rebalance cost se calculan por separado: fees, slippage, quote basis, latencia y retiro amortizado.", tone: "amber" },
  { code: "06", title: "Expected Value", text: "AET pondera fill probability de ambas piernas y penaliza el costo de unwind cuando una sola pierna sobrevive.", tone: "emerald" },
  { code: "07", title: "Preflight", text: "Antes de entrar a la queue valida frescura, integridad e inventario prefunded disponible para ambas piernas.", tone: "rose" },
  { code: "08", title: "State machine", text: "Cada señal conserva una traza: detected, validated, reserved, leg A, leg B y reconciled.", tone: "violet" },
  { code: "09", title: "Shadow Learning", text: "Markouts a 100 ms, 500 ms y 2 s recalibran survival probability por ruta, incluso si la señal se descarta.", tone: "sky" },
  { code: "10", title: "Circuit breaker", text: "El motor detiene nuevas ejecuciones tras tres pérdidas materiales o al romper el daily loss limit.", tone: "rose" }
];

export function AetPipelineDiagram() {
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      {stages.map((stage, index) => (
        <article className={`relative rounded-2xl border bg-white p-4 shadow-sm ${toneBorder(stage.tone)}`} key={stage.code}>
          <div className="flex items-start justify-between gap-3">
            <span className={`font-mono text-xs font-black ${toneText(stage.tone)}`}>{stage.code}</span>
            {index < stages.length - 1 && <span className="font-mono text-xs font-black text-zinc-300">-&gt;</span>}
          </div>
          <h3 className="mt-4 text-base font-black text-zinc-950">{stage.title}</h3>
          <p className="mt-2 text-xs font-semibold leading-5 text-zinc-500">{stage.text}</p>
        </article>
      ))}
    </div>
  );
}

function toneBorder(tone: string): string {
  if (tone === "emerald") return "border-emerald-100";
  if (tone === "amber") return "border-amber-100";
  if (tone === "rose") return "border-rose-100";
  if (tone === "violet") return "border-violet-100";
  return "border-sky-100";
}

function toneText(tone: string): string {
  if (tone === "emerald") return "text-emerald-700";
  if (tone === "amber") return "text-amber-700";
  if (tone === "rose") return "text-rose-700";
  if (tone === "violet") return "text-violet-700";
  return "text-sky-700";
}
