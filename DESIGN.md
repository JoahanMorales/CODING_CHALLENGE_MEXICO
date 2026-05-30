# ArbitrAI Design System

This file documents the visual direction for ArbitrAI so future iterations keep the same premium trading-console language. It follows the spirit of `DESIGN.md` references such as `VoltAgent/awesome-design-md`: a plain markdown design system that humans and coding agents can read before changing the UI.

## 1. Product Atmosphere

ArbitrAI should feel like a modern institutional trading cockpit:

- fast, calm, and data-dense;
- white and pastel, not dark, neon, or cyberpunk;
- precise like Linear, financially serious like Bloomberg, but softer and easier to read;
- clear enough for judges to understand in 10 seconds;
- rich enough for traders to inspect signal quality.

The UI is not a marketing landing page. The first screen is the product.

## 2. Color Palette

| Token | Hex | Role |
|---|---|---|
| Canvas | `#f7fbff` | App background |
| Surface | `#ffffff` | Main panels |
| Soft Sky | `#f0f9ff` | Data context and realtime states |
| Soft Emerald | `#ecfdf5` | Positive P&L and healthy state |
| Soft Rose | `#fff1f2` | Losses and halted/risk state |
| Soft Amber | `#fffbeb` | Warnings, impact, stress tests |
| Soft Violet | `#f5f3ff` | Demo/config secondary surfaces |
| Text | `#18181b` | Primary copy |
| Muted | `#71717a` | Secondary labels |
| Border | `#e4e4e7` | Default separators |

Functional colors:

- Emerald = profitable, connected, healthy.
- Rose = loss, rejected, circuit breaker.
- Amber = warning, high impact, stress, demo caution.
- Sky = market data, latency, neutral live state.
- Violet = configuration/demo accent only.

## 3. Typography

| Use | Font | Treatment |
|---|---|---|
| Product name | Inter | 24px, black weight |
| Panel titles | Inter | 18-22px, black weight |
| Body labels | Inter | 12-14px, semibold |
| Numbers/prices | JetBrains Mono fallback | 10-16px, bold/black |
| Technical pills | JetBrains Mono fallback | uppercase, 10px |

Rules:

- Do not use negative letter spacing.
- Use monospace only for data, status codes, route tags, and numbers.
- Avoid oversized hero typography inside the app.

## 4. Layout Principles

- One-screen command center with three vertical work areas:
  - left: system and market data;
  - center: signal intelligence;
  - right: execution, P&L, wallets.
- Use internal scroll areas instead of page-level scrolling.
- Keep cards shallow and data-dense.
- Avoid nested decorative cards.
- Keep compact grids stable so live data does not shift layout.

## 5. Core Components

### Command Bar

Purpose: instant proof that the system is alive.

Must show:

- ArbitrAI identity;
- live/demo segmented control;
- gateway heartbeat;
- signals count;
- executed count;
- net P&L;
- latency.

### System Health

Purpose: remove ambiguity about backend health.

Must show:

- exchange status;
- venue reliability score;
- heartbeat;
- circuit breaker state;
- WebSocket source.

### Edge Radar

Purpose: make the app feel smarter than a generic crypto dashboard.

Must show:

- fragmentation;
- pressure;
- microprice skew;
- edge survival;
- best route.

### AET Signal Badges

Purpose: expose the proprietary quant layer without overwhelming the feed.

Must show:

- `AET` model score on opportunity rows;
- survival percentage on featured signal and compact rows;
- adverse-selection bps in the technical subtitle;
- quality state using `EXPLOIT`, `WATCH`, or `AVOID` where space allows.

Design rule: AET should look like a professional risk model, not like AI hype.

### Signal Desk

Purpose: explain the current best signal or why execution paused.

Must show:

- current state: scanning, edge active, executing session, trading paused;
- execution style;
- route;
- score;
- net spread;
- expected P&L;
- execution count.

### Opportunity Tape

Purpose: live feed without visual noise.

Rules:

- executable signals are highlighted;
- rejected signals remain compact;
- route line truncates cleanly;
- four numeric fields maximum per row.

### P&L Cockpit

Purpose: make performance obvious.

Must show:

- cumulative P&L chart;
- win rate;
- avg trade;
- best trade;
- fees;
- hit rate;
- Sharpe-like ratio.

### Missed Opportunity Desk

Purpose: prove the bot rejects intelligently.

Must show:

- latest rejected routes;
- rejection cause: fees, liquidity, adverse selection, breaker, threshold;
- score and survival estimate;
- compact layout so it does not push the opportunity tape down.

### Shadow Learning

Purpose: make learning visible even when live execution is conservative.

Must show:

- evaluated signal count;
- missed profit dollars;
- avoided loss dollars;
- false-positive count;
- model hit rate;
- latest markout label and horizon.

Design rule: avoided losses should read as model skill, not as negative P&L.

### Scenario Lab

Purpose: let judges stress the system without fake live prices.

Controls:

- `CRASH x3`: volatility/spread stress in demo, risk drill in live;
- `LIQUIDITY`: lower demo depth and increase impact rejections;
- `LATENCY`: multiply simulated execution latency;
- `REPLAY`: fetch the last five minutes from the backend recorder;
- `EXPORT CSV`: download the audit trail.

### Execution Bridge

Purpose: show the path from paper trading to sandbox exchange orders without implying real-money execution.

Must show:

- current execution mode: `PAPER` or `SANDBOX`;
- sandbox order mode: `DRY_RUN`, `TEST_ORDER`, or `LIVE_SANDBOX`;
- configured sandbox venues;
- max notional cap;
- latest sandbox report status.
- authenticated BTC/USDT balances per sandbox venue;
- sandbox kill switch state;
- latest reconciliation state, residual BTC, and hedge action.

Design rule: arming sandbox should feel deliberate and controlled, not like a game button.

Operational controls:

- `REFRESH FUNDS`: fetch authenticated balances from Binance Spot Testnet and OKX Demo.
- `RECONCILE`: label validation-only runs or compare both demo fills after `LIVE_SANDBOX`.
- `KILL SWITCH`: stop sandbox submission independently from the quantitative circuit breaker.

## 6. Interaction Rules

- `RESET RISK` should always be visible when risk state matters.
- Scenario controls should be visible but compact; they are secondary to live status and P&L.
- Demo seed controls should appear only in demo mode.
- Live mode should never imply real order placement.
- Tooltips or labels should clarify ambiguous controls.

## 7. Motion

Use motion only to show live updates:

- price flash: 420ms;
- new opportunity row: subtle 520ms translate;
- no bouncing;
- no layout shift.

## 8. Do and Do Not

Do:

- keep dense data readable;
- preserve white/pastel identity;
- make circuit breaker obvious;
- show why a signal exists;
- use charts only when they clarify.

Do not:

- add neon gradients;
- create a marketing hero;
- hide risk state;
- overload the top bar;
- render every raw exchange tick into React.

## 9. Future Visual Upgrades

- Add a small session replay timeline.
- Add compact risk attribution chips per trade.
- Add a market regime badge: calm, fragmented, stressed.
- Add screenshot assets to README once deployment is stable.
- Add a design preview page if time allows.
