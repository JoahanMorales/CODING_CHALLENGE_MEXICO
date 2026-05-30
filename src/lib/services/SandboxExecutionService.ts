import { d, Decimal } from "../math/decimal";
import type {
  ExecutionRuntimeMode,
  ExecutionRuntimeState,
  Opportunity,
  SandboxExecutionReport,
  SandboxOrderMode,
  SandboxVenueStatus
} from "../types";

interface SandboxConfig {
  binanceApiKey: string;
  binanceApiSecret: string;
  okxApiKey: string;
  okxApiSecret: string;
  okxPassphrase: string;
  orderMode: SandboxOrderMode;
  maxNotionalUsd: Decimal;
}

interface SandboxLeg {
  exchange: "binance" | "okx";
  side: "BUY" | "SELL";
  symbol: "BTCUSDT" | "BTC-USDT";
  price: string;
  quantity: string;
}

export class SandboxExecutionService {
  private readonly config: SandboxConfig;
  private mode: ExecutionRuntimeMode = "PAPER";
  private readonly venues: SandboxVenueStatus[];
  private lastReport: SandboxExecutionReport | undefined;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.config = {
      binanceApiKey: env.BINANCE_TESTNET_API_KEY ?? "",
      binanceApiSecret: env.BINANCE_TESTNET_API_SECRET ?? "",
      okxApiKey: env.OKX_DEMO_API_KEY ?? "",
      okxApiSecret: env.OKX_DEMO_API_SECRET ?? "",
      okxPassphrase: env.OKX_DEMO_API_PASSPHRASE ?? "",
      orderMode: parseOrderMode(env.SANDBOX_ORDER_MODE),
      maxNotionalUsd: d(env.SANDBOX_MAX_NOTIONAL_USD ?? "25")
    };
    this.venues = [
      {
        exchange: "binance",
        configured: Boolean(this.config.binanceApiKey && this.config.binanceApiSecret),
        environment: "spot-testnet",
        lastError: ""
      },
      {
        exchange: "okx",
        configured: Boolean(this.config.okxApiKey && this.config.okxApiSecret && this.config.okxPassphrase),
        environment: "demo-trading",
        lastError: ""
      }
    ];
  }

  setMode(mode: ExecutionRuntimeMode): ExecutionRuntimeState {
    this.mode = mode === "SANDBOX" && this.hasConfiguredVenue() ? "SANDBOX" : "PAPER";
    return this.status();
  }

  status(): ExecutionRuntimeState {
    return {
      mode: this.mode,
      sandboxEnabled: this.mode === "SANDBOX" && this.hasConfiguredVenue(),
      orderMode: this.config.orderMode,
      maxNotionalUsd: this.config.maxNotionalUsd.toFixed(2),
      venues: this.venues.map((venue) => ({ ...venue })),
      lastReport: this.lastReport
    };
  }

  async execute(opportunity: Opportunity): Promise<SandboxExecutionReport | null> {
    if (this.mode !== "SANDBOX") return null;
    const legs = this.planLegs(opportunity);
    if (!legs.length) {
      this.lastReport = this.report(opportunity, "SKIPPED", "Sandbox execution supports Binance <-> OKX cross-exchange legs first.", []);
      return this.lastReport;
    }

    if (this.config.orderMode === "DRY_RUN") {
      this.lastReport = this.report(opportunity, "DRY_RUN", "Sandbox DRY_RUN: order payloads planned but not submitted.", legs);
      return this.lastReport;
    }

    const submitted: SandboxExecutionReport["legs"] = [];
    for (const leg of legs) {
      const startedAt = performanceNow();
      try {
        const orderId = leg.exchange === "binance" ? await this.submitBinance(leg) : await this.submitOkx(leg);
        this.markVenue(leg.exchange, "", orderId, performanceNow() - startedAt);
        submitted.push({ ...leg, orderId, status: "SUBMITTED" });
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown sandbox error";
        this.markVenue(leg.exchange, message, undefined, performanceNow() - startedAt);
        submitted.push({ ...leg, status: "FAILED" });
      }
    }

    const failed = submitted.some((leg) => leg.status === "FAILED");
    this.lastReport = this.report(
      opportunity,
      failed ? "FAILED" : "SUBMITTED",
      failed ? "At least one sandbox venue rejected the order." : "Sandbox order legs submitted.",
      submitted
    );
    return this.lastReport;
  }

  private planLegs(opportunity: Opportunity): SandboxLeg[] {
    if (opportunity.type !== "CROSS_EXCHANGE" || !opportunity.buyExchange || !opportunity.sellExchange) return [];
    const buy = normalizeSandboxExchange(opportunity.buyExchange);
    const sell = normalizeSandboxExchange(opportunity.sellExchange);
    if (!buy || !sell || buy === sell) return [];

    const requestedQty = d(opportunity.tradeSizeBtc);
    const buyPrice = d(opportunity.executionPlan?.referenceBuyPrice ?? "0");
    const sellPrice = d(opportunity.executionPlan?.referenceSellPrice ?? "0");
    if (buyPrice.lessThanOrEqualTo(0) || sellPrice.lessThanOrEqualTo(0)) return [];
    const maxQty = this.config.maxNotionalUsd.div(Decimal.max(buyPrice, sellPrice));
    const quantity = Decimal.max("0.00001", Decimal.min(requestedQty, maxQty));

    return [
      {
        exchange: buy,
        side: "BUY",
        symbol: buy === "binance" ? "BTCUSDT" : "BTC-USDT",
        price: buyPrice.toFixed(2),
        quantity: quantity.toFixed(6)
      },
      {
        exchange: sell,
        side: "SELL",
        symbol: sell === "binance" ? "BTCUSDT" : "BTC-USDT",
        price: sellPrice.toFixed(2),
        quantity: quantity.toFixed(6)
      }
    ];
  }

  private async submitBinance(leg: SandboxLeg): Promise<string> {
    if (!this.config.binanceApiKey || !this.config.binanceApiSecret) throw new Error("Binance testnet API key missing");
    const path = this.config.orderMode === "TEST_ORDER" ? "/api/v3/order/test" : "/api/v3/order";
    const params = new URLSearchParams({
      symbol: "BTCUSDT",
      side: leg.side,
      type: "LIMIT",
      timeInForce: "IOC",
      quantity: leg.quantity,
      price: leg.price,
      newClientOrderId: clientOrderId("arbai"),
      recvWindow: "5000",
      timestamp: String(Date.now())
    });
    const signature = await hmacSha256Hex(this.config.binanceApiSecret, params.toString());
    params.set("signature", signature);
    const response = await fetch(`https://testnet.binance.vision${path}?${params.toString()}`, {
      method: "POST",
      headers: { "X-MBX-APIKEY": this.config.binanceApiKey }
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw new Error(String(payload.msg ?? `Binance ${response.status}`));
    return String(payload.orderId ?? payload.clientOrderId ?? "binance-test-ok");
  }

  private async submitOkx(leg: SandboxLeg): Promise<string> {
    if (!this.config.okxApiKey || !this.config.okxApiSecret || !this.config.okxPassphrase) {
      throw new Error("OKX demo API key missing");
    }
    const path = "/api/v5/trade/order";
    const timestamp = new Date().toISOString();
    const body = JSON.stringify({
      instId: "BTC-USDT",
      tdMode: "cash",
      clOrdId: clientOrderId("arbaiokx").slice(0, 32),
      side: leg.side.toLowerCase(),
      ordType: "limit",
      px: leg.price,
      sz: leg.quantity
    });
    const signature = await hmacSha256Base64(this.config.okxApiSecret, `${timestamp}POST${path}${body}`);
    const response = await fetch(`https://www.okx.com${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "OK-ACCESS-KEY": this.config.okxApiKey,
        "OK-ACCESS-SIGN": signature,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": this.config.okxPassphrase,
        "x-simulated-trading": "1"
      },
      body
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok || payload.code !== "0") throw new Error(String(payload.msg ?? `OKX ${response.status}`));
    const data = Array.isArray(payload.data) ? payload.data[0] as Record<string, unknown> | undefined : undefined;
    return String(data?.ordId ?? data?.clOrdId ?? "okx-demo-ok");
  }

  private report(
    opportunity: Opportunity,
    status: SandboxExecutionReport["status"],
    reason: string,
    legs: SandboxLeg[] | SandboxExecutionReport["legs"]
  ): SandboxExecutionReport {
    return {
      id: clientOrderId("sandbox"),
      opportunityId: opportunity.id,
      route: opportunity.route,
      createdAt: Date.now(),
      mode: this.config.orderMode,
      status,
      reason,
      legs: legs.map((leg) => ({
        ...leg,
        status: "status" in leg ? leg.status : "PLANNED"
      }))
    };
  }

  private markVenue(exchange: "binance" | "okx", error: string, orderId?: string, latencyMs?: number): void {
    const venue = this.venues.find((item) => item.exchange === exchange);
    if (!venue) return;
    venue.lastError = error;
    venue.lastOrderId = orderId ?? venue.lastOrderId;
    venue.lastLatencyMs = latencyMs;
  }

  private hasConfiguredVenue(): boolean {
    return this.venues.some((venue) => venue.configured);
  }
}

function normalizeSandboxExchange(exchange: string): "binance" | "okx" | null {
  if (exchange === "binance") return "binance";
  if (exchange === "okx") return "okx";
  return null;
}

function parseOrderMode(value: string | undefined): SandboxOrderMode {
  if (value === "TEST_ORDER" || value === "LIVE_SANDBOX") return value;
  return "DRY_RUN";
}

function clientOrderId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`.replace(/[^a-zA-Z0-9_-]/g, "");
}

function performanceNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const bytes = new Uint8Array(await hmacSha256(secret, payload));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256Base64(secret: string, payload: string): Promise<string> {
  const bytes = new Uint8Array(await hmacSha256(secret, payload));
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

async function hmacSha256(secret: string, payload: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, encoder.encode(payload));
}
