# ArbitrAI Agent Guide

## The Challenge (CODING_CHALLENGE_MEXICO — BTC Arbitrage)

Build, develop and deploy an automated trading system that detects BTC
arbitrage opportunities in real time and simulates their execution intelligently.

**Functional requirements**

1. **Real-time monitoring** of BTC order books across two or more exchanges via
   WebSocket or polling, tracking the best Ask/Bid per venue.
2. **Opportunity detection**: when one venue's Ask < another venue's Bid, compute
   net profitability and decide whether to execute.
3. **Simulated execution**: register and simulate the buy on the cheaper venue and
   the simultaneous sell on the dearer venue, respecting order-book liquidity.
4. **Real operating costs**: every opportunity must be evaluated net of trading
   fees, withdrawal fees, estimated slippage and network latency. A gross-profitable
   edge can be net-negative.
5. **Partial fills & wallet balances**: handle low-liquidity scenarios with partial
   orders; keep each wallet balance correct after every simulated trade.
6. **Logging & visualization**: keep a history of detected opportunities, executed
   trades, cumulative P&L, and present it clearly in the web UI.

**Judging rubric** (what reviewers score):

| Criterion | What they look for |
|---|---|
| Speed / efficiency | Detection latency, WebSocket vs polling, real-time data processing. |
| Net-profit accuracy | Correct fees per venue, slippage, execution risk; reject gross-positive-but-net-negative edges. |
| Robustness | Low liquidity, partial fills, sharp moves mid-execution, risk management / circuit breaker. |
| Strategy / intelligence | Prioritization, multi-pair comparison, advanced strategies (triangular, statistical arb). |
| Architecture / code quality | Structured, maintainable, scalable, readable, documented, good engineering practices. |
| Web UX | Deployed, publicly accessible web app showing live market state, opportunities, executions and cumulative P&L. |

**Delivery**: must be deployed and publicly accessible as a web app, with repo
access and a clear README (architecture, usage, technical decisions).

> Context: this was already submitted; a one-week extension was granted to pick
> finalists. Goal now is to harden and improve the existing system, not rewrite it.
> Keep changes consistent with the established (well-tuned) architecture, keep
> `npm run check` + `npm run build` green, and prefer surgical, defensible edits.

## Build / Lint / Test Commands

```bash
npm run dev          # Next.js dev server (port 3000)
npm run dev:ws       # WebSocket backend (port 8080)
npm run build        # Production build
npm run typecheck    # tsc --noEmit (strict mode)
npm run lint         # next lint (next/core-web-vitals)
npm run test         # vitest run (all tests in tests/)
npm run check        # typecheck + lint + test
npm run start        # Next.js production server
npm run start:ws     # WS backend production
npm run train        # offline ML/AET training harness -> public/model/edge-model.json
npm run record       # record real 7-exchange order-book tapes -> data/tape-*.jsonl
```

`npm run train [seconds]` drives the engine + simulator directly (compressed
wall-clock latency via `ARBITRAI_SIM_SLEEP_SCALE`). The synthetic generator draws
cross-exchange dislocations centred on each pair's break-even, with the SAME book
structure as the live demo, settles the injected pair as a labelled trial, and
validates discrimination with AUC over a round-disjoint held-out set. It only
persists an ML ensemble that ranks winners over losers (AUC >= 0.65) AND passes a
demo-safety guard (won't veto the demo's genuine winners). `npm run record
[seconds]` captures real order books from the 7 exchanges (REST, basis-adjusted)
to `data/tape-*.jsonl`; `npm run train -- --tape <file>` replays it to train on
real microstructure (which confirms retail cross-exchange arb is uniformly
unprofitable, so tape mode mainly recalibrates the AET on real outcomes). Both
persist to `public/model/edge-model.json`; the demo (client) and gateway
(backend) warm-start from it so they begin pre-calibrated instead of cold.

Note: `opportunity.netSpreadPct` is formatted in PERCENT units (`pct()` ×100);
anything reconstructing the feature for ML training must divide by 100 to match
the raw-decimal scale inference uses (see `tests/mlTrainingScale.test.ts`).

### Running a single test

```bash
npx vitest run tests/feeMath.test.ts
npx vitest run tests/riskManager.test.ts
# or using --reporter for verbose output
npx vitest run tests/arbitrageEngine.test.ts --reporter verbose
```

## Project structure

```
src/
  app/                 # Next.js App Router (page.tsx, layout.tsx, globals.css)
  components/          # React components (PascalCase.tsx)
  lib/
    config/            # Config constants (camelCase.ts)
    math/              # Math utilities (camelCase.ts)
    services/          # Business logic classes (PascalCase.ts)
    types.ts           # All TypeScript types/interfaces
  store/               # Zustand store (useArbitrageStore.ts)
  tests/               # All tests (camelCase.test.ts, vitest)
backend/
  server.ts            # WebSocket server
```

## Code style

### Imports (order: React → third-party → internal → types)

```ts
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Area, AreaChart } from "recharts";
import { EXCHANGE_IDS, EXCHANGE_LABELS } from "@/lib/config/exchanges";
import { calculateNetProfit } from "./feeMath";
import type { ExchangeConnectionStatus, Opportunity } from "@/lib/types";
```

### Components: named function exports, NO default exports (except Next.js pages)

```ts
"use client";

export function Dashboard() { ... }
function CommandBar({ connected, mode }: { connected: boolean; mode: "LIVE" | "DEMO" }) { ... }
```

- `export function ComponentName()` — never `React.FC`, never `export default`
- Props typed inline as anonymous object — no exported prop types
- "use client" directive on interactive components
- Sub-components as non-exported functions in same file
- No barrel exports (no index.ts files) — import by direct path

### Types / Interfaces: PascalCase, no I/T prefix

```ts
type ExchangeId = "binance" | "kraken" | "coinbase" | "okx" | "bybit" | "bitfinex" | "gate";
type Mode = "LIVE" | "DEMO";
interface Opportunity { id: string; exchangeId: ExchangeId; expectedProfitUsd: Decimal; ... }
type GatewayMessage = { type: "SNAPSHOT"; ... } | { type: "BOOK"; ... };
```

### Naming conventions

| Category | Convention | Example |
|---|---|---|
| Files (components) | PascalCase.tsx | `Dashboard.tsx` |
| Files (services) | PascalCase.ts | `RiskManager.ts` |
| Files (utilities) | camelCase.ts | `feeMath.ts` |
| Types/Interfaces | PascalCase | `Opportunity`, `RiskState` |
| Functions/variables | camelCase | `btcBookKey`, `topBid` |
| Constants | UPPER_SNAKE_CASE | `EXCHANGE_IDS`, `CROSS_EXCHANGE_THRESHOLD_PCT` |
| CSS classes | Tailwind utility classes | no CSS modules or CSS-in-JS |

### State management (Zustand)

```ts
export const useArbitrageStore = create<ArbitrageState>((set, get) => ({
  mode: "DEMO",
  init: () => { if (get().initialized) return; set({ initialized: true }); ... },
  setMode: (mode) => { ... },
}));
```

- Single store, combined state + methods interface
- Module-level mutable variables for WebSocket/kernel instances
- Helper functions as module-level named functions

### Error handling

```ts
// Guard clauses / early returns for validation
if (get().initialized) return;
if (gateway !== socket) return;

// try/catch with async/await (no .catch() chaining)
try {
  const data = JSON.parse(raw) as GatewayMessage;
  applyGatewayMessage(set, data);
} catch {
  set({ connectionError: "Invalid message." });
}

// Error utility for unknown errors
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

// Fire-and-forget async calls
void localKernel?.refreshSandboxBalances();
```

### Tests (Vitest)

```ts
import { describe, expect, it } from "vitest";
import { d } from "../src/lib/math/decimal";
import { calculateNetProfit } from "../src/lib/services/feeMath";

describe("fee math", () => {
  it("separates execution costs from amortized rebalancing cost", () => {
    const result = calculateNetProfit({ ... });
    expect(result.grossProfitUsd.toFixed(2)).toBe("25.00");
  });
});
```

- All tests in top-level `tests/` directory
- Import `{ describe, expect, it }` from `"vitest"` (no globals)
- No test setup files

### Styling

- Tailwind CSS only (no CSS modules, no CSS-in-JS)
- Custom animations in globals.css: `price-up`, `price-down`, `card-in`
- `prefers-reduced-motion` respected
- Fonts: Inter (sans), JetBrains Mono (mono) from tailwind.config.ts
- Color palette: sky, emerald, amber, zinc/gray

### Comments

- No JSDoc/docblocks
- `//` comments only for non-obvious logic (cycle math, edge cases)
- Comments in English for code, Spanish for user-facing strings
- No TODO/FIXME/HACK markers

### Key configurations

- `tsconfig.json`: strict, ES2022, bundler moduleResolution, `@/*` → `./src/*`
- `next.config.mjs`: reactStrictMode: true
- `tailwind.config.ts`: custom fonts, content covers `src/**` and `backend/**`
- `.env.example` documents all env vars
- gitignored: `.env`, `.next/`, `coverage/`, `data/`, `node_modules/`

### Env vars (see .env.example)

```
NEXT_PUBLIC_WS_URL=ws://localhost:8080
WS_PORT=8080
SANDBOX_ORDER_MODE=TEST_ORDER
SANDBOX_MAX_NOTIONAL_USD=25
```
