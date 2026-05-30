const stages = [
  { code: "01", title: "Feeds públicos", text: "Siete exchanges envían libros BTC/USDT por WebSocket. REST cubre desconexiones temporales.", tone: "sky" },
  { code: "02", title: "Normalización", text: "Cada mensaje se convierte al mismo esquema: top 5 bid/ask, volumen visible, timestamp y latencia.", tone: "sky" },
  { code: "03", title: "Microestructura", text: "MLOFI, microprice y volatilidad estiman presión inmediata y selección adversa.", tone: "emerald" },
  { code: "04", title: "Economía real", text: "Se descuentan fees, retiro amortizado, slippage, impacto y costo esperado de latencia.", tone: "amber" },
  { code: "05", title: "Edge Tensor", text: "AET combina supervivencia, liquidez, confiabilidad histórica y beneficio ajustado por riesgo.", tone: "emerald" },
  { code: "06", title: "Gestor de riesgo", text: "Limita tamaño, evita impacto alto y pausa la ejecución ante pérdidas consecutivas o caída acumulada.", tone: "rose" },
  { code: "07", title: "Cola priorizada", text: "Las oportunidades aprobadas se ordenan por score antes de simular ambas piernas.", tone: "violet" },
  { code: "08", title: "Shadow Learning", text: "Resultados posteriores a 500 ms, 2 s y 5 s recalibran cada ruta, incluso cuando una señal se descarta.", tone: "sky" }
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
