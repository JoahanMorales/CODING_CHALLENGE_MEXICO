# BTC Arbitrage Terminal

Solucion para **CODING_CHALLENGE_MEXICO: El Desafio Arbitraje de Bitcoin**.

La app monitorea top-of-book de BTC en multiples exchanges mediante WebSockets publicos, calcula arbitraje neto con fees, retiro amortizado, slippage y buffer de latencia, y simula ejecuciones con wallets prefondadas por exchange.

## Stack

- App web estatica sin dependencias externas.
- WebSockets del navegador para Binance, Kraken y Coinbase.
- Servidor local opcional en Node.js para servir archivos estaticos.
- Motor de arbitraje y simulador de wallets en `src/app.js`.

## Ejecutar localmente

```bash
npm start
```

Abre:

```text
http://localhost:4173
```

Validacion sintactica:

```bash
npm run check
```

## Arquitectura

```text
Browser UI
  -> Market connectors
     -> Binance partial depth BTCUSDT
     -> Kraken ticker BTC/USD
     -> Coinbase ticker BTC-USD
  -> Arbitrage engine
     -> evalua cada ruta buy_exchange -> sell_exchange
     -> calcula volumen ejecutable por liquidez y wallets
     -> descuenta trading fees, withdrawal fee amortizado, slippage y latencia
  -> Execution simulator
     -> compra spot en exchange barato
     -> venta spot en exchange caro
     -> actualiza balances BTC/USD por wallet
     -> registra trades, P&L y circuit breaker
```

## Logica de arbitraje

Una oportunidad existe cuando:

```text
ask(exchange_compra) < bid(exchange_venta)
```

La ejecucion simulada solo ocurre si:

- El volumen posible es mayor o igual a `0.001 BTC`.
- Hay liquidez disponible en ambos top-of-books.
- La wallet compradora tiene quote balance suficiente.
- La wallet vendedora tiene BTC suficiente.
- El P&L neto supera el minimo en USD y bps.
- Los feeds no estan stale y el circuit breaker esta desactivado.

Formula resumida:

```text
gross = (sellBid - buyAsk) * qty
costs = buyFee + sellFee + slippage + latencyBuffer + amortizedWithdrawalFee
net = gross - costs
netBps = net / (buyAsk * qty) * 10_000
```

## Gestion de riesgo

- Cooldown por ruta para evitar sobre-ejecucion sobre el mismo spread.
- Circuit breaker tras 3 perdidas consecutivas.
- Filtro de datos stale.
- Orden parcial cuando la liquidez o los balances no cubren el tamano maximo.
- Modo demo automatico si los WebSockets externos no entregan datos en unos segundos.
- Perfil inicial de fees al `0.1%`, alineado al ejemplo del challenge; los valores por exchange viven en `exchangeConfigs`.

## APIs usadas

- Binance Spot WebSocket partial book depth: `btcusdt@depth5@100ms`
  <https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-streams.md>
- Kraken WebSocket v2 ticker con `event_trigger: "bbo"`
  <https://docs.kraken.com/api/docs/websocket-v2/ticker/>
- Coinbase Advanced Trade WebSocket ticker sin autenticacion
  <https://docs.cdp.coinbase.com/coinbase-business/advanced-trade-apis/websocket/websocket-channels>

## Despliegue

Puede desplegarse como sitio estatico en Vercel, Netlify o Cloudflare Pages. No requiere secretos ni API keys. En Vercel basta importar el repositorio y usar la configuracion por defecto; `index.html` se sirve desde la raiz.

## Nota tecnica

Los balances son simulados y no se envia ninguna orden real. Para produccion real haria falta autenticacion por exchange, control de nonce/firma, reconciliacion de fills, persistencia, auditoria, gestion de transferencias entre exchanges y limites de riesgo por cuenta.

# CODING_CHALLENGE_MEXICO
