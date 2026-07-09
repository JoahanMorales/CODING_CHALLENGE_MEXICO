# ¿Existe un edge rentable? — Análisis honesto, trazado al bps

> La pregunta que decide el proyecto: *¿se puede ganar dinero con arbitraje cripto
> BTC a fees retail?* La respuesta, con 3.6M de dislocaciones reales, es **no** —
> y probarlo con rigor, cuantificar *exactamente* cuánto falta, y construir un
> sistema que **sabe cuándo NO operar** es una historia más fuerte y más creíble
> que un "+$X" inventado que se cae al primer fill real.

Toda cifra aquí es reproducible desde `public/data/*.json` y los scripts en `scripts/`.

## 1. Taker (arbitraje cross-exchange directo) — muerto por aritmética
`npm run study:fee` sobre el tape de 90k rondas: **3,610,216 dislocaciones cross reales.**

| Métrica | Valor |
| --- | ---: |
| Spread bruto mediano | 1.3 bps |
| Spread bruto p95 | 9.0 bps |
| **Spread bruto máximo** | **29.1 bps** |
| **Fee taker round-trip más barato** (binance+okx) | **20 bps** |
| % rentable a fee retail (≥20 bps) | **~0%** (netea ~$18 total) |

Aun la dislocación **más gorda de 3.6M** (29 bps) apenas supera el fee más barato (20 bps).
No es afinable: es la resta. El mercado ya descontó el arbitraje dentro del propio spread.
Break-even: se necesitaría un fee round-trip **≤ 1.3 bps** para que la mitad fueran rentables.

## 2. Maker (proveer liquidez) — el fee supera al edge ~30×
`npm run study:maker`: descomposición honesta (medio spread capturable vs movimiento del mid).

- Venues líquidas: medio spread ~0.007 bps vs mid move ~1.2 bps → **riesgo ~186× el spread.**
- Mejor caso (Bitfinex, spread ancho): edge maker bruto **~0.28 bps/fill**.
- **Fee maker más barato: 8 bps** (OKX); el resto 10–40 bps.
- Neto en la mejor venue ≈ 0.28 − 10 = **−9.7 bps.** El fee es ~35× el edge.

Ni siquiera donde el spread supera al riesgo (Bitfinex) sobrevive al fee maker.

## 3. Reversión de spread — señal real pero mecánica y no operable
`study:reversion` + barrido de horizontes: AUC ~0.65 (leakage-clean), pero **el edge
capturable es ~1.3 bps** contra **40 bps** de fee round-trip, en **todos** los horizontes
(4/8/16/32 rondas). *Predictibilidad ≠ rentabilidad.*

## 4. Portafolio multi-estrategia — la matemática no negocia
`study:portfolio`: el valor esperado de una suma es la suma de los valores esperados.
Combinar apuestas de EV negativo **nunca** produce EV positivo. Diversificar baja la
*varianza*, no cambia el *signo*.

## 5. El único resultado positivo — honesto y con sus supuestos
El **punto de operación** (`train --tape --split temporal`, walk-forward out-of-sample)
liquida dislocaciones reales bajo ejecución **maker-asistida**:
**+$94,269 contrafactuales** (6,422 trades, 71.4% ganador; gate DETECTED: 3,762 trades,
100%, +$93,640).

**Qué es y qué no es:** es liquidación *contrafactual* bajo el modelo de costos del
simulador (fees maker/híbridos, no taker puro) sobre las señales que el modelo
seleccionaría — **no es dinero en vivo**, y hereda esos supuestos. Por eso la ejecución
se mantiene **gateada**: el edge es razor-thin y depende de fills maker que en vivo
sufren selección adversa. Presentarlo con esos supuestos es honesto; presentarlo como
"le ganamos al mercado" no lo sería.

## 6. Qué se necesitaría para dinero real (fuera de este data/setup)
1. **Tier con rebate maker** (que te *paguen*, fee negativo) — único escenario positivo de
   la curva de fees. Existe para MMs de alto volumen; los 7 venues configurados cobran fee.
2. **Infraestructura de latencia** (colocation) para ganar la carrera de quotes rancias —
   eso es infra física, no un modelo.
3. **Un mercado menos eficiente** (small-caps, funding/basis de perps) — requiere otros datos.

## El pitch que gana
No fingimos un edge. **Probamos** — con 3.6M dislocaciones reales — que el mercado es
eficiente a fees retail, en taker *y* en maker, cuantificamos exactamente el hueco, y
construimos un sistema cuya inteligencia es **rechazar con precisión** lo que no es
ejecutable. Bajo ejecución maker-asistida selectiva incluso netea +$94k contrafactuales,
y aun así lo gateamos por disciplina. Esa combinación de **rigor + honestidad + disciplina**
es el producto — y le gana a un número inventado ante cualquier juez que sepa leer un backtest.
