import type { Metadata } from "next";
import { AetFlowCanvas } from "@/components/AetFlowCanvas";
import { AetPipelineDiagram } from "@/components/AetPipelineDiagram";
import { IntelligenceCalibration } from "@/components/IntelligenceCalibration";
import { PublicSiteFooter } from "@/components/PublicSiteFooter";
import { PublicSiteHeader } from "@/components/PublicSiteHeader";

export const metadata: Metadata = { title: "Inteligencia" };

const strategies = [
  {
    name: "Cross-exchange",
    code: "CROSS_EXCHANGE",
    desc: "Compra en el mejor ask de un venue y vende simultáneamente en el mejor bid de otro. La señal solo sobrevive si el spread neto —después de comisiones, deslizamiento, latencia e impacto— sigue siendo positivo.",
    guard: "Filtros: frescura de quotes, sincronización < 1800 ms, survival AET > 50%, valor esperado > umbral dinámico por volatilidad.",
    tone: "sky"
  },
  {
    name: "Triangular",
    code: "TRIANGULAR",
    desc: "Evalúa el ciclo completo BTC/USDT → ETH/USDT → ETH/BTC dentro de un mismo venue usando VWAP en cada pata. El beneficio neto descuenta comisiones de las tres operaciones y deslizamiento contra depth real.",
    guard: "Ejecuta solo si el producto de las tres tasas cruzadas supera el costo de round trip.",
    tone: "emerald"
  },
  {
    name: "Stat Arb (Mean Reversion)",
    code: "STAT_ARB",
    desc: "Busca desviaciones entre dos venues usando Z-score sobre una ventana móvil de 60 segundos. Estima half-life de reversión con MLE de OU process y aplica corrección FDR (Benjamini-Hochberg, q=0.25) para controlar falsos positivos.",
    guard: "Filtros: |Z| > 1.6, calidad de reversión > 14 %, survival AET > 56 %, half-life finito.",
    tone: "violet"
  },
  {
    name: "Latency / Stale-quote",
    code: "LATENCY_ARB",
    desc: "Ataca justo el espacio asíncrono que cross-exchange rechaza: una cotización barata que quedó rancia en un venue mientras otro imprime un bid fresco más alto. Levanta el ask rancio y vende contra el bid fresco.",
    guard: "Solo con skew > 1800 ms y antigüedad < 6 s. Cobra una prima de riesgo de staleness que crece con la edad de la cotización y exige 1.5× el umbral de cross-exchange.",
    tone: "amber"
  }
];

const innovations = [
  ["VWAP pricing con depth completa", "Precios de ejecución realistas contra múltiples niveles del LOB en vez de top-of-book. Cont/Stoikov (price impact)."],
  ["FDR multiple testing correction", "Control de falsos positivos en stat arb usando Benjamini-Hochberg con q=0.25. Benjamini & Hochberg (1995)."],
  ["MLE para OU process", "Estimación closed-form AR(1) de half-life de mean reversion, estable desde 5 muestras. Bergstrom (Leeds Econ WP)."],
  ["Adaptive freshness por venue", "Hard limit adaptativo: max(2000, ewmaInterval × 3 + 500) por exchange. Binance (100 ms) → 800 ms, Gate (500 ms) → 2000 ms."],
  ["Dynamic size scaling", "Tamaño dinámico = min(0.1, 18 % del depth total a 5 niveles) en vez de tamaño fijo. Respeta liquidez disponible."],
  ["Drift risk dual calibration", "Detección usa z = 1.28 (80 % confianza) para pasar más señales; position sizing usa z = 1.96 (95 %) para riesgo controlado."],
  ["Triangular arbitrage con VWAP", "Simulación VWAP en cada una de las 3 patas del ciclo en vez de top-of-book. Capta profundidad real."],
  ["Latency kill switch", "RecordLatency trackea últimos 20 mensajes; shouldHalt frena si avg > 3000 ms; getLatencyMultiplier escala 1.5 / 2.5 / 3.2."],
  ["XGBoost-style ML EdgeTensor", "Gradient-boosted ensemble de decision stumps (max 32 trees), 19 features del order book, entrenamiento online desde outcomes reales y shadow. Una vez entrenado es la segunda opinión del ensemble: puede vetar una señal que AET admitió. Chen & Guestrin (XGBoost, 2016)."],
  ["Hybrid maker/taker execution", "Compra como maker (mejor precio, comisión menor) y vende como taker (fill garantizado). Fees menores que taker puro con mejor fill que maker puro."],
  ["Adaptive volatility threshold", "CROSS_EXCHANGE_THRESHOLD_PCT se ajusta según volatilidad: base × clamp(1.0, 2, 1 + (volBps − 1.5) / 5). Floor en 1.0 para no relajar el umbral en baja volatilidad."],
  ["Square-root law de market impact", "El slippage escala con √(participación), no lineal — ley casi universal confirmada en Bitcoin (Donier & Bonart 2015, exponente ≈0.5). Un modelo lineal subestima el costo de consumir profundidad."],
  ["Gate de cointegración (ADF)", "Stat arb solo opera spreads que rechazan raíz unitaria: t-stat de Dickey-Fuller sobre el AR(1) con deriva (t < −2.0 ⇒ estacionario/cointegrado). Engle & Granger (1987), Dickey & Fuller (1979)."],
  ["Sizing de Kelly fraccional", "Tamaño = f* = p − (1−p)/b (Kelly 1956, Thorp 2006), con p = supervivencia del ensemble y b = odds edge/downside, escalando la base de profundidad y acotado a [0.3, 1]."],
  ["Maker pricing Avellaneda-Stoikov", "La pata maker ya no usa una agresividad fija: deriva qué tan adentro del spread postar del half-spread óptimo δ = 0.5[γσ²(T−t) + (2/γ)ln(1+γ/κ)] — más pasiva en alta volatilidad, más ajustada en libros profundos — con skew por order-flow imbalance. Avellaneda & Stoikov (2008)."],
  ["Features de order-flow imbalance", "El ensemble ML ahora consume OFI a la punta y multi-level OFI ponderado a 5 niveles (Cont-Kukanov-Stoikov 2014; Xu-Gould-Howison 2018, R²≈65 %), microprice en ambos libros y su alineación — antes eran features inertes en 0."],
  ["Búsqueda de semillas para el modelo ML", "El modelo warm-start ya no sale de un único entrenamiento: npm run train:search corre el harness sobre N seeds independientes (mercados sintéticos distintos), puntúa cada uno por AUC held-out + demo-safety, y solo promueve un modelo nuevo si supera al actual — nunca lo empeora. Última búsqueda (18 seeds): demo-safety subió de 82.6% a 96.6%."],
  ["Aislamiento de fallos en la cola de ejecución", "drainQueue() envuelve cada trade en su propio try/catch y el loop completo en try/finally: si una pierna lanza una excepción, esa señal se rechaza pero la cola sigue viva — antes, cualquier throw dejaba el motor de ejecución congelado para siempre. Un React error boundary (error.tsx) evita además la pantalla blanca si un panel de la terminal falla al renderizar."]
];

const formulas = [
  ["MLOFI", "Σ peso(nivel) × Δ profundidad", "Mide cómo cambia la presión compradora y vendedora en los primeros cinco niveles del libro."],
  ["Microprice", "(ask × volumen bid + bid × volumen ask) / volumen total", "Ajusta el precio medio con el desequilibrio visible en la punta del libro."],
  ["Execution Net P&L", "gross edge - fees - slippage - quote basis - execution risk", "Separa el resultado operativo inmediato del costo periódico de rebalancear inventario entre venues."],
  ["Rebalance-adjusted P&L", "execution net - withdrawal amortization", "Permite comparar rutas prefunded sin ocultar el costo económico de recuperar la asignación inicial."],
  ["Expected Value", "P(fill A ∩ fill B) × P&L ajustado - P(leg risk) × unwind cost", "Prioriza señales por valor esperado y no por un spread que podría desaparecer antes de completar ambas piernas."],
  ["Supervivencia AET", "sigmoid(edge - adverse selection - latency - impact + calibration bias)", "Estima si la oportunidad seguirá existiendo al completar ambas piernas y se recalibra con markouts observados."],
  ["Market impact (√-law)", "slippage = base + c · √(tamaño / profundidad)", "Ley raíz-cuadrada validada en Bitcoin: consumir profundidad cuesta de forma cóncava, no lineal. Donier & Bonart (2015)."],
  ["Cointegración (ADF)", "Δy = α + ρ · y₋₁ + ε ⟶ t = ρ̂ / SE(ρ̂)", "Test de Dickey-Fuller sobre el spread: solo se opera si rechaza raíz unitaria (t < −2), confirmando reversión a la media."],
  ["Kelly fraccional", "f* = p − (1 − p) / b", "Tamaño óptimo de posición proporcional al edge e inverso al riesgo; p = supervivencia, b = odds. Acotado a [0.3, 1] sobre la base de profundidad."],
  ["Avellaneda-Stoikov", "δ = ½[γσ²(T−t) + (2/γ)·ln(1 + γ/κ)]", "Half-spread óptimo de market making: define qué tan adentro del spread postar la pata maker; crece con volatilidad σ, se ajusta con la profundidad κ y la aversión al inventario γ."]
];

export default function IntelligencePage() {
  return (
    <main className="min-h-screen text-zinc-900">
      <PublicSiteHeader />
      <section className="border-b border-sky-100 px-5 py-12">
        <div className="mx-auto max-w-7xl">
          <p className="font-mono text-[10px] font-black uppercase text-sky-700">Modelo cuantitativo explicable</p>
          <div className="mt-4 grid gap-8 lg:grid-cols-[0.82fr_1.18fr] lg:items-center">
            <div>
              <h1 className="text-4xl font-black leading-tight text-zinc-950 sm:text-6xl">ArbitrAI Edge Tensor</h1>
              <p className="mt-4 max-w-xl text-base font-semibold leading-7 text-zinc-600">
                Un spread visible no basta. AET calcula si la diferencia de precio conserva valor después de comisiones, deslizamiento, latencia, profundidad disponible y riesgo de que el libro se mueva en contra.
              </p>
              <p className="mt-3 max-w-xl text-sm font-semibold leading-6 text-zinc-500">
                El resultado es una decisión trazable: ejecutar, reducir tamaño, observar o descartar.
              </p>
            </div>
            <div className="h-[340px] overflow-hidden rounded-3xl border border-sky-100 bg-white/85 backdrop-blur elev-lift sm:h-[420px]">
              <AetFlowCanvas detailed />
            </div>
          </div>
        </div>
      </section>

      <section className="px-5 py-12">
        <div className="mx-auto max-w-7xl">
          <p className="font-mono text-[10px] font-black uppercase text-sky-700">Pipeline completo</p>
          <h2 className="mt-2 max-w-3xl text-3xl font-black text-zinc-950">De siete libros de órdenes a una ejecución priorizada</h2>
          <p className="mt-3 max-w-3xl text-sm font-semibold leading-6 text-zinc-500">
            Cada bloque tiene una responsabilidad acotada. El motor procesa los eventos coalesced del scanner; la interfaz recibe una versión resumida para mantenerse fluida.
          </p>
          <div className="mt-6">
            <AetPipelineDiagram />
          </div>
        </div>
      </section>

      <section className="border-y border-sky-100 bg-white px-5 py-12">
        <div className="mx-auto max-w-7xl">
          <p className="font-mono text-[10px] font-black uppercase text-sky-700">Núcleo matemático</p>
          <h2 className="mt-2 text-3xl font-black text-zinc-950">Variables observables, decisiones auditables</h2>
          <div className="mt-6 grid gap-3 lg:grid-cols-2">
            {formulas.map(([name, formula, explanation]) => (
              <article className="rounded-2xl border border-zinc-200/70 bg-white/80 p-5 backdrop-blur-sm elev-lift" key={name}>
                <h3 className="text-lg font-black text-zinc-950">{name}</h3>
                <code className="mt-3 block overflow-x-auto rounded-lg border border-sky-100 bg-sky-50 px-3 py-2 font-mono text-xs font-black text-sky-800">{formula}</code>
                <p className="mt-3 text-sm font-semibold leading-6 text-zinc-500">{explanation}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="px-5 py-12">
        <div className="mx-auto max-w-7xl">
          <p className="font-mono text-[10px] font-black uppercase text-sky-700">Aprendizaje y calibración</p>
          <h2 className="mt-2 max-w-3xl text-3xl font-black text-zinc-950">El modelo se autocalibra con cada markout</h2>
          <p className="mt-3 max-w-3xl text-sm font-semibold leading-6 text-zinc-500">
            Datos en vivo del kernel en modo demo: supervivencia predicha vs. resultado realizado, medida con el Brier score.
          </p>
          <div className="mt-6">
            <IntelligenceCalibration />
          </div>
        </div>
      </section>

      <section className="px-5 py-12">
        <div className="mx-auto max-w-7xl">
          <p className="font-mono text-[10px] font-black uppercase text-sky-700">Waterfall económico</p>
          <h2 className="mt-2 text-3xl font-black text-zinc-950">Del spread bruto al beneficio ejecutable</h2>
          <p className="mt-3 max-w-2xl text-sm font-semibold leading-6 text-zinc-500">Ejemplo ilustrativo medido en puntos base: un punto base equivale a 0.01%.</p>
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Waterfall label="Spread bruto" value="+18.4 bps" tone="sky" />
            <Waterfall label="Comisiones" value="-10.0 bps" tone="rose" />
            <Waterfall label="Deslizamiento" value="-2.3 bps" tone="amber" />
            <Waterfall label="Selección adversa" value="-1.8 bps" tone="amber" />
            <Waterfall label="Edge neto" value="+4.3 bps" tone="emerald" />
          </div>
        </div>
      </section>

      <section className="border-t border-sky-100 bg-white px-5 py-12">
        <div className="mx-auto max-w-7xl">
          <p className="font-mono text-[10px] font-black uppercase text-sky-700">Estrategias de arbitraje</p>
          <h2 className="mt-2 text-3xl font-black text-zinc-950">Cuatro motores, un mismo pipeline de costos</h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {strategies.map((s) => (
              <article className={`rounded-2xl border bg-white/80 p-5 backdrop-blur-sm elev-lift ${strategyBorder(s.tone)}`} key={s.code}>
                <span className={`font-mono text-xs font-black ${strategyText(s.tone)}`}>{s.code}</span>
                <h3 className="mt-3 text-lg font-black text-zinc-950">{s.name}</h3>
                <p className="mt-2 text-sm font-semibold leading-6 text-zinc-500">{s.desc}</p>
                <p className="mt-3 text-xs font-bold leading-5 text-zinc-400">{s.guard}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="border-y border-sky-100 px-5 py-12">
        <div className="mx-auto max-w-7xl">
          <p className="font-mono text-[10px] font-black uppercase text-sky-700">Innovaciones implementadas</p>
          <h2 className="mt-2 text-3xl font-black text-zinc-950">Dieciocho mejoras sobre el modelo base</h2>
          <p className="mt-3 max-w-2xl text-sm font-semibold leading-6 text-zinc-500">
            Cada innovación está activa en el motor de producción y tiene cobertura de pruebas.
          </p>
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {innovations.map(([title, desc], i) => (
              <article className="rounded-2xl border border-zinc-200/70 bg-white/80 p-4 backdrop-blur-sm elev-lift" key={i}>
                <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-sky-200 bg-sky-50 font-mono text-xs font-black text-sky-700">
                  {i + 1}
                </span>
                <h3 className="mt-3 text-sm font-black text-zinc-950">{title}</h3>
                <p className="mt-1.5 text-xs font-semibold leading-5 text-zinc-500">{desc}</p>
              </article>
            ))}
          </div>
          <div className="mt-6 text-center">
            <a
              className="inline-flex items-center gap-2 rounded-xl border border-sky-200 bg-sky-50 px-5 py-3 font-mono text-xs font-black text-sky-700 transition hover:bg-sky-100"
              href="https://github.com/JoahanMorales"
              rel="noreferrer"
              target="_blank"
            >
              VER README COMPLETO EN GITHUB →<span className="sr-only">Abrir README</span>
            </a>
          </div>
        </div>
      </section>

      <section className="border-t border-sky-100 bg-white px-5 py-12">
        <div className="mx-auto max-w-7xl">
          <p className="font-mono text-[10px] font-black uppercase text-sky-700">Referencias primarias</p>
          <div className="mt-4 grid gap-3 lg:grid-cols-3">
            <Reference href="https://arxiv.org/abs/1011.6402" title="Price Impact of Order Book Events">Fundamento para usar desequilibrio del flujo de órdenes como señal de impacto a corto horizonte.</Reference>
            <Reference href="https://arxiv.org/abs/1907.06230" title="Multi-Level Order-Flow Imbalance">Motivación para incorporar varios niveles de profundidad y no depender únicamente del mejor bid y ask.</Reference>
            <Reference href="https://arxiv.org/abs/1812.00595" title="Limits to Arbitrage for Blockchain-Based Assets">Marco para considerar costos, capital, latencia y fricciones operativas antes de ejecutar.</Reference>
            <Reference href="https://arxiv.org/abs/1412.4503" title="Market Impact on Bitcoin (Donier & Bonart, 2015)">Confirma empíricamente la ley raíz-cuadrada de impacto de mercado en BTC (exponente ≈ 0.5).</Reference>
            <Reference href="https://www.jstor.org/stable/1913236" title="Co-integration and Error Correction (Engle & Granger, 1987)">Base del gate de estacionariedad (ADF) que filtra spreads no cointegrados en stat arb.</Reference>
            <Reference href="https://ieeexplore.ieee.org/document/6771227" title="A New Interpretation of Information Rate (Kelly, 1956)">Criterio de Kelly para el tamaño óptimo de posición proporcional al edge.</Reference>
            <Reference href="https://arxiv.org/abs/0810.4892" title="High-frequency trading in a limit order book (Avellaneda & Stoikov, 2008)">Half-spread óptimo de market making que fija la agresividad de la pata maker según volatilidad, profundidad e inventario.</Reference>
          </div>
        </div>
      </section>
      <PublicSiteFooter />
    </main>
  );
}

function Waterfall({ label, tone, value }: { label: string; tone: "amber" | "emerald" | "rose" | "sky"; value: string }) {
  const colors = {
    amber: "border-amber-200 bg-amber-50 text-amber-700",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-700",
    rose: "border-rose-200 bg-rose-50 text-rose-700",
    sky: "border-sky-200 bg-sky-50 text-sky-700"
  };
  return (
    <div className={`rounded-xl border px-4 py-5 ${colors[tone]}`}>
      <span className="block text-xs font-black">{label}</span>
      <strong className="mt-3 block font-mono text-xl font-black">{value}</strong>
    </div>
  );
}

function strategyBorder(tone: string): string {
  if (tone === "emerald") return "border-emerald-100";
  if (tone === "violet") return "border-violet-100";
  if (tone === "amber") return "border-amber-100";
  return "border-sky-100";
}

function strategyText(tone: string): string {
  if (tone === "emerald") return "text-emerald-700";
  if (tone === "violet") return "text-violet-700";
  if (tone === "amber") return "text-amber-700";
  return "text-sky-700";
}

function Reference({ children, href, title }: { children: React.ReactNode; href: string; title: string }) {
  return (
    <a className="rounded-2xl border border-zinc-200/70 bg-white/80 p-5 backdrop-blur-sm elev-lift hover:border-sky-300" href={href} rel="noreferrer" target="_blank">
      <strong className="block text-base font-black text-zinc-950">{title}</strong>
      <span className="mt-2 block text-sm font-semibold leading-6 text-zinc-500">{children}</span>
    </a>
  );
}
