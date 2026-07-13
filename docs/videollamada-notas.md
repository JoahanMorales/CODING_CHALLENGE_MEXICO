# Notas para la videollamada técnica — ArbitrAI

Guion para la posible llamada con el comité. Objetivo: transmitir profundidad técnica, decisiones justificadas y honestidad. No leer palabra por palabra — son anclas.

---

## 1. Elevator pitch (30 s)

> ArbitrAI es un bot de arbitraje de BTC sobre **8 exchanges en vivo por WebSocket**. Detecta dislocaciones cross-venue, triangulares y estadísticas, las valida **net-of-fees** con un modelo de microestructura + un comité de ML, y simula la ejecución con costos realistas (fees por venue, slippage con ley de raíz cuadrada, latencia, market impact). Todo es **parametrizable en vivo** desde la consola, con rebalanceo automático de wallets y circuit breakers. El deploy es una web pública en tiempo real.

---

## 2. Cómo explicar la arquitectura

- **Frontend** Next.js 14 (Vercel) — landing, terminal en vivo, resultados auditables, inteligencia.
- **Gateway** Node + WebSocket (Railway, `backend/server.ts`) — se conecta a los 8 exchanges, normaliza libros, corre el motor y hace broadcast tipado a los clientes.
- **Kernel dual**: el mismo `ArbitrageEngine` corre en el navegador (modo Demo, `ArbitrAIKernel`) y en el gateway (modo Live). Un único protocolo `GatewayMessage`/`GatewayCommand` tipado los une → **el mismo código de detección en ambos lados**, sin divergencia.
- **Separación de servicios**: `ArbitrageEngine` (detección), `ExecutionSimulator` (fills + wallets), `RiskManager` (circuit breaker, escenarios), `SandboxExecutionService` (órdenes firmadas TEST_ORDER), `EdgeTensor`/`MlEdgeTensor`/`NeuralEdge` (modelos).

**Frase clave:** "El protocolo tipado y el kernel compartido son lo que me deja demostrar exactamente lo mismo en demo determinista y en producción con datos reales."

---

## 3. Decisiones técnicas clave (el "por qué")

| Decisión | Por qué |
|---|---|
| `Decimal.js` en todo el hot path | Los errores de floating point en precios/fees se acumulan; el P&L tiene que cuadrar al centavo. |
| Normalización USD/USDT con `source price` preservado | Comparar Coinbase (USD) vs Binance (USDT) sin el basis USDT/USD inventa spreads falsos. |
| Slippage con ley `√(participación)` | El impacto de mercado es cóncavo, no lineal (Donier-Bonart lo confirma en BTC). Un modelo lineal subestima el costo de consumir profundidad. |
| Comité de dos familias (árboles + red neuronal) | Los árboles parten fronteras alineadas a ejes; la red las curva. Discrepan de forma útil → el promedio calibra mejor. |
| Calibración Platt/isotónica con validación walk-forward | Kelly consume la salida como probabilidad; sin calibrar, sobre-apuesta. Brier 0.060 → 0.023. |
| Parámetros como `EngineParams` en un solo lugar (`types.ts`) | Una sola fuente de verdad compartida por el protocolo y el engine; imposible que UI y motor se desincronicen. |

---

## 4. La parametrización en vivo (EL diferenciador) — demostrar en pantalla

Abrir `/terminal` → sidebar derecho → **Parámetros de estrategia**. El sistema controla **10+ variables** (6 sliders numéricos + estilo de ejecución + universo de venues), con **3 presets** de un clic.

1. Clic en **Agresivo** → todas las perillas saltan a un perfil coherente (umbral bajo, tamaño alto, estilo Auto); luego **Conservador** → se invierten. *"Un preset carga un perfil completo; desde ahí afino cualquier variable."*
2. Mover **Umbral de ganancia neta** hacia abajo → aparecen más señales ejecutables; hacia arriba → solo pasan las gordas. *"El slider entra directo a `detectCrossExchange`; el número que ves es el que el motor usa para decidir."*
3. **Estrés de fees** a 2× → el "Umbral efectivo" (readout en vivo) se duplica → el bot se vuelve más conservador sin tocar código.
4. **Tolerancia de slippage / Profundidad mínima / Frescura de quote** → gates de calidad: rechazan rutas ilíquidas, con mucho impacto o con libros desincronizados.
5. **Estilo de ejecución** (Auto/Taker/Maker/Híbrido) → forzar Maker deshabilita la rama taker, etc.
6. Apagar un exchange → las **rutas dirigidas en escaneo** bajan (n·(n−1)); ese venue se sigue viendo pero ya no entra a ninguna ruta.

**Cableado (si preguntan):** ControlDeck → acción del store (update optimista) → `engine.setParams()` en el kernel del navegador **y/o** comando `SET_ENGINE_PARAMS` sobre el WebSocket → aplicado con clamps dentro del engine → el gateway hace broadcast de los params efectivos y **sincroniza a cada cliente nuevo al conectar**.

---

## 5. Robustez ante escenarios adversos — demostrar

Botón **Laboratorio de estrés** (solo en Demo, nunca alteramos precios live):
- **Crash de volatilidad ×3**, **drenaje de liquidez**, **latencia elevada**.
- Mostrar: el motor sube el umbral por volatilidad, el latency kill switch frena si el avg > 3000 ms, el circuit breaker corta tras 3 pérdidas materiales.
- **Aislamiento de fallos**: `drainQueue()` envuelve cada trade en su propio `try/catch`; una pierna que revienta rechaza esa señal sin congelar la cola. Error boundary de React evita pantalla blanca.
- Fills parciales + `preflight` real de ambas piernas antes de admitir a la cola.

---

## 6. Wallets y rebalanceo automático — demostrar

Sidebar → **Rebalanceo automático**. Cuando un venue drifta bajo su banda operativa (±18% del target), el motor jala el excedente del venue más holgado del mismo activo, paga el **fee de retiro real** (BTC on-chain / red USDT) y lo registra en un log auditable. Idempotente y acotado; nunca vacía un donante bajo su propio target.

---

## 7. El modelo ML / comité (si profundizan)

- **AET (ArbitrAI Edge Tensor)**: modelo de supervivencia de microestructura, calibrado por ruta.
- **MlEdgeTensor**: ensemble estilo XGBoost (stumps boosteados, 19 features del libro + 5 temporales), entrenamiento online desde outcomes reales y shadow. Actúa como **segunda opinión**: puede vetar una señal que AET admitió, nunca resucita una que rechazó.
- **NeuralEdge**: MLP `24→32→16→1` en TypeScript puro (backprop + Adam a mano), corre igual en browser y gateway. Ruta GPU (PyTorch/CUDA en Jetson) lista.
- **Shadow Learning**: aprende también de las señales que descartó (contrafactual).

---

## 8. La postura honesta (defenderla como FORTALEZA)

Si preguntan "¿genera dinero real?":

> Con fees retail de taker (≥20 bps ida y vuelta) el arbitraje cross-venue de BTC es **estructuralmente no rentable** — lo cuantificamos: 2.5M dislocaciones reales, edge bruto mediano ~1.4 bps, muy por debajo del break-even. El mercado es eficiente. Donde SÍ aparece edge net-positivo es en las **ventanas de volatilidad de ~1 segundo** cuando los venues rápidos repricean antes que los lentos — y esas las capturamos con verificación de frescura (ambos libros <1.5 s). Están documentadas en `/resultados` con +20.53 bps neto reales.

**El punto fuerte:** *"Preferí construir un sistema que sabe medir su propio edge y decir la verdad, en vez de uno que siempre dice 'ejecutar' y esconde que pierde con fees. La parametrización, la calibración y los estudios de eficiencia son la prueba de que el bot entiende el problema, no solo que hace ruido."*

Estudios en `/resultados`: umbral de fees, complemento maker-side, reversión en tape real, punto de operación con IC de Wilson.

---

## 9. Preguntas probables + respuestas

- **"¿Los datos son reales?"** → Sí: 8 feeds WebSocket reales, libros normalizados, evidencia en `/resultados` sobre tapes grabados reales. La ejecución es **paper/simulada** (el deploy público no manda órdenes con dinero real, por diseño de seguridad); `TEST_ORDER` prueba firma y payload contra testnets.
- **"¿Por qué no órdenes reales?"** → Operar capital real exige rollout gradual, custody controls, hedge policy y monitoreo — fuera del alcance de un hackathon, y sería irresponsable simularlo como si fuera real.
- **"¿Cómo escalarías?"** → El gateway ya es stateless por cliente; sharding por símbolo/venue, persistencia del journal en volumen, y el modelo se recalibra con schema versionado para no mezclar observaciones incompatibles.
- **"¿Latencia real?"** → El feed es event-driven; medimos y mostramos heartbeat y latencia por venue. El costo de latencia entra al modelo de ejecución (no solo cosmético).
- **"¿Overfitting del ML?"** → Validación walk-forward (`--split temporal`), evaluación en tape ajeno (`--evalTape`), IC de Wilson, y solo se promueve un modelo si supera al actual out-of-sample. Documentamos incluso un caso donde un op-point NO generalizó (bandera de credibilidad, no lo escondemos).

---

## 10. Demo en vivo — orden sugerido (3–4 min)

1. **Landing** (10 s): pipeline de decisión, 8 mercados.
2. **/terminal** (90 s): señales streaming, waterfall de costos, P&L. Mover **2 sliders** del ControlDeck y mostrar el efecto inmediato.
3. **Laboratorio de estrés** (40 s): disparar crash → mostrar reacción del motor + circuit breaker.
4. **Rebalanceo** (20 s): señalar el log de transferencias automáticas.
5. **/resultados** (40 s): capturas reales +20.53 bps + estudios de eficiencia → cerrar con la postura honesta.

**Cierre:** *"Construí algo que entiende el mercado lo suficiente para ser honesto sobre él, y que cualquiera puede reparametrizar en vivo para ver cómo cambia la decisión. Eso es lo que quería demostrar."*
