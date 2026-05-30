import { readFileSync } from "node:fs";
import { SandboxExecutionService } from "../src/lib/services/SandboxExecutionService";

loadLocalEnv();

if (process.env.SANDBOX_ORDER_MODE !== "LIVE_SANDBOX") {
  throw new Error("Set SANDBOX_ORDER_MODE=LIVE_SANDBOX before running the controlled demo probe.");
}

const binance = await fetch("https://testnet.binance.vision/api/v3/ticker/bookTicker?symbol=BTCUSDT").then(jsonRecord);
const okx = await fetch("https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT").then(jsonRecord);
const okxTicker = Array.isArray(okx.data) && isRecord(okx.data[0]) ? okx.data[0] : {};
const buyPrice = (Number(binance.askPrice) * 1.005).toFixed(2);
const sellPrice = (Number(okxTicker.bidPx) * 0.995).toFixed(2);
const now = Date.now();
const service = new SandboxExecutionService(process.env);
service.setMode("SANDBOX");
await service.refreshBalances();
const before = service.status().venues.map(({ exchange, balances }) => ({ exchange, balances }));
const report = await service.execute({
  id: `sandbox_probe_${now}`,
  type: "CROSS_EXCHANGE",
  executionStyle: "INSTANT_TAKER",
  status: "DETECTED",
  route: "Binance -> Okx",
  createdAt: now,
  expiresAt: now + 10_000,
  buyExchange: "binance",
  sellExchange: "okx",
  grossSpreadPct: "0",
  netSpreadPct: "0",
  tradeSizeBtc: "0.01",
  expectedProfitUsd: "0",
  grossProfitUsd: "0",
  totalFeesUsd: "0",
  slippageUsd: "0",
  networkCostUsd: "0",
  score: 100,
  confidence: 100,
  highImpact: false,
  impactRatio: 0,
  reason: "controlled sandbox reconciliation probe",
  detectionLatencyMs: 0,
  executionPlan: {
    buyLevels: [],
    sellLevels: [],
    buyLiquidityRole: "taker",
    sellLiquidityRole: "taker",
    referenceBuyPrice: buyPrice,
    referenceSellPrice: sellPrice
  }
});
await service.refreshBalances();
const runtime = service.status();

console.log(
  JSON.stringify(
    {
      before,
      report,
      runtime: {
        mode: runtime.mode,
        orderMode: runtime.orderMode,
        killSwitchActive: runtime.killSwitchActive,
        killSwitchReason: runtime.killSwitchReason,
        reconciliation: runtime.lastReconciliation,
        venues: runtime.venues.map(({ exchange, lastError, balances }) => ({ exchange, error: lastError, balances }))
      }
    },
    null,
    2
  )
);

function loadLocalEnv(): void {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([^#][^=]*)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  }
}

async function jsonRecord(response: Response): Promise<Record<string, unknown>> {
  const payload = (await response.json()) as unknown;
  if (!response.ok || !isRecord(payload)) throw new Error(`Market ticker request failed with ${response.status}.`);
  return payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
