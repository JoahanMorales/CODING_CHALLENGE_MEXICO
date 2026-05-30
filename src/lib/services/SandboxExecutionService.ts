import { d, Decimal } from "../math/decimal";
import type {
  ExecutionRuntimeMode,
  ExecutionRuntimeState,
  Opportunity,
  SandboxAssetBalance,
  SandboxExecutionReport,
  SandboxFill,
  SandboxOrderMode,
  SandboxReconciliation,
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
  private lastReconciliation: SandboxReconciliation | undefined;
  private killSwitchActive = false;
  private killSwitchReason = "";

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
        lastError: "",
        balances: emptyBalances()
      },
      {
        exchange: "okx",
        configured: Boolean(this.config.okxApiKey && this.config.okxApiSecret && this.config.okxPassphrase),
        environment: "demo-trading",
        lastError: "",
        balances: emptyBalances()
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
      venues: this.venues.map((venue) => ({ ...venue, balances: venue.balances.map((balance) => ({ ...balance })) })),
      killSwitchActive: this.killSwitchActive,
      killSwitchReason: this.killSwitchReason,
      lastReconciliation: this.lastReconciliation,
      lastReport: this.lastReport
    };
  }

  setKillSwitch(active: boolean, reason = active ? "Manual sandbox kill switch engaged." : ""): ExecutionRuntimeState {
    this.killSwitchActive = active;
    this.killSwitchReason = reason;
    return this.status();
  }

  async refreshBalances(): Promise<ExecutionRuntimeState> {
    await Promise.all(
      this.venues.map(async (venue) => {
        if (!venue.configured) return;
        const startedAt = performanceNow();
        try {
          venue.balances = venue.exchange === "binance" ? await this.fetchBinanceBalances() : await this.fetchOkxBalances();
          venue.balanceFetchedAt = Date.now();
          if (venue.lastError.startsWith("Balance refresh:")) venue.lastError = "";
          venue.lastLatencyMs = performanceNow() - startedAt;
        } catch (error) {
          this.markVenue(venue.exchange, `Balance refresh: ${errorMessage(error)}`, undefined, performanceNow() - startedAt);
        }
      })
    );
    return this.status();
  }

  async reconcileLastReport(): Promise<ExecutionRuntimeState> {
    if (!this.lastReport) {
      this.lastReconciliation = reconciliation("IDLE", "No sandbox report is available yet.");
      return this.status();
    }
    if (this.lastReport.mode !== "LIVE_SANDBOX") {
      this.lastReconciliation = reconciliation("TEST_ONLY", "TEST_ORDER and DRY_RUN never create exchange fills.");
      return this.status();
    }
    const submitted = this.lastReport.legs.filter((leg) => leg.status === "SUBMITTED" && leg.orderId);
    if (submitted.length !== 2) {
      this.lastReconciliation = reconciliation("FAILED", "Both sandbox legs were not submitted. Manual review required.", [], "0", "BLOCKED");
      this.setKillSwitch(true, "Sandbox leg submission mismatch.");
      return this.status();
    }
    try {
      const fills = await Promise.all(submitted.map((leg) => this.fetchFill(leg)));
      const buy = fills.find((fill) => this.lastReport?.legs.find((leg) => leg.orderId === fill.orderId)?.side === "BUY");
      const sell = fills.find((fill) => this.lastReport?.legs.find((leg) => leg.orderId === fill.orderId)?.side === "SELL");
      const residual = d(buy?.filledQuantity ?? "0").minus(sell?.filledQuantity ?? "0");
      if (residual.abs().greaterThan("0.00001")) {
        this.lastReconciliation = reconciliation("PARTIAL", "Leg fills diverged. Hedge is planned and sandbox execution is paused.", fills, residual.toFixed(8), "PLANNED");
        this.setKillSwitch(true, "Residual BTC exposure requires hedge review.");
      } else {
        this.lastReconciliation = reconciliation("BALANCED", "Both sandbox legs reconcile within BTC tolerance.", fills, residual.toFixed(8));
      }
    } catch (error) {
      this.lastReconciliation = reconciliation("FAILED", `Reconciliation failed: ${errorMessage(error)}`, [], "0", "BLOCKED");
      this.setKillSwitch(true, "Sandbox reconciliation failed.");
    }
    return this.status();
  }

  async execute(opportunity: Opportunity): Promise<SandboxExecutionReport | null> {
    if (this.mode !== "SANDBOX") return null;
    if (this.killSwitchActive) {
      this.lastReport = this.report(opportunity, "SKIPPED", `Sandbox kill switch active: ${this.killSwitchReason}`, []);
      return this.lastReport;
    }
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
    const failures: string[] = [];
    for (const leg of legs) {
      if (this.config.orderMode === "TEST_ORDER" && leg.exchange === "okx") {
        submitted.push({ ...leg, status: "PLANNED" });
        continue;
      }
      const startedAt = performanceNow();
      try {
        const orderId = leg.exchange === "binance" ? await this.submitBinance(leg) : await this.submitOkx(leg);
        this.markVenue(leg.exchange, "", orderId, performanceNow() - startedAt);
        submitted.push({ ...leg, orderId, status: "SUBMITTED" });
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown sandbox error";
        this.markVenue(leg.exchange, message, undefined, performanceNow() - startedAt);
        submitted.push({ ...leg, status: "FAILED" });
        failures.push(`${leg.exchange}: ${message}`);
        break;
      }
    }

    const failed = submitted.some((leg) => leg.status === "FAILED");
    const validatedOnly = this.config.orderMode === "TEST_ORDER" && !failed;
    this.lastReport = this.report(
      opportunity,
      failed ? "FAILED" : "SUBMITTED",
      failed
        ? `Sandbox venue rejected order: ${failures.join("; ")}`
        : validatedOnly
          ? "Binance test order validated. OKX demo leg remained planned and was not submitted."
          : "Sandbox order legs submitted.",
      submitted
    );
    if (this.config.orderMode === "TEST_ORDER") {
      this.lastReconciliation = reconciliation("TEST_ONLY", "Binance payload validated only. No order or fill was created.");
    }
    if (this.config.orderMode === "LIVE_SANDBOX") await this.reconcileLastReport();
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
        price: normalizePrice(buy, buyPrice),
        quantity: normalizeQuantity(buy, quantity)
      },
      {
        exchange: sell,
        side: "SELL",
        symbol: sell === "binance" ? "BTCUSDT" : "BTC-USDT",
        price: normalizePrice(sell, sellPrice),
        quantity: normalizeQuantity(sell, quantity)
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
      clOrdId: clientOrderId("arbaiokx").replace(/[^a-zA-Z0-9]/g, "").slice(0, 32),
      side: leg.side.toLowerCase(),
      ordType: "ioc",
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

  private async fetchBinanceBalances(): Promise<SandboxAssetBalance[]> {
    const payload = await this.binanceSignedGet("/api/v3/account");
    const balances = Array.isArray(payload.balances) ? payload.balances : [];
    return assetBalances(
      balances.filter(isRecord).map((balance) => ({
        asset: String(balance.asset ?? ""),
        available: String(balance.free ?? "0"),
        locked: String(balance.locked ?? "0")
      }))
    );
  }

  private async fetchOkxBalances(): Promise<SandboxAssetBalance[]> {
    const payload = await this.okxSignedGet("/api/v5/account/balance?ccy=BTC,USDT");
    const accounts = Array.isArray(payload.data) ? payload.data : [];
    const account = accounts.find(isRecord);
    const details = account && Array.isArray(account.details) ? account.details : [];
    return assetBalances(
      details.filter(isRecord).map((balance) => ({
        asset: String(balance.ccy ?? ""),
        available: String(balance.availBal ?? balance.availEq ?? "0"),
        locked: String(balance.frozenBal ?? "0")
      }))
    );
  }

  private async fetchFill(leg: SandboxExecutionReport["legs"][number]): Promise<SandboxFill> {
    if (!leg.orderId) throw new Error(`${leg.exchange} order id missing`);
    if (leg.exchange === "binance") {
      const payload = await this.binanceSignedGet("/api/v3/order", { symbol: "BTCUSDT", orderId: leg.orderId });
      const quantity = String(payload.executedQty ?? "0");
      const quote = String(payload.cummulativeQuoteQty ?? "0");
      return fill("binance", leg.orderId, String(payload.status ?? "UNKNOWN"), quantity, quote);
    }
    const payload = await this.okxSignedGet(`/api/v5/trade/order?instId=BTC-USDT&ordId=${encodeURIComponent(leg.orderId)}`);
    const data = Array.isArray(payload.data) ? payload.data.find(isRecord) : undefined;
    const quantity = String(data?.accFillSz ?? "0");
    const average = String(data?.avgPx ?? "0");
    return {
      exchange: "okx",
      orderId: leg.orderId,
      status: String(data?.state ?? "UNKNOWN"),
      filledQuantity: quantity,
      quoteQuantity: d(quantity).mul(average || "0").toFixed(8),
      averagePrice: average,
      fetchedAt: Date.now()
    };
  }

  private async binanceSignedGet(path: string, extra: Record<string, string> = {}): Promise<Record<string, unknown>> {
    if (!this.config.binanceApiKey || !this.config.binanceApiSecret) throw new Error("Binance testnet API key missing");
    const params = new URLSearchParams({ ...extra, recvWindow: "5000", timestamp: String(Date.now()) });
    params.set("signature", await hmacSha256Hex(this.config.binanceApiSecret, params.toString()));
    const response = await fetch(`https://testnet.binance.vision${path}?${params.toString()}`, {
      headers: { "X-MBX-APIKEY": this.config.binanceApiKey }
    });
    const payload = await jsonRecord(response);
    if (!response.ok) throw new Error(String(payload.msg ?? `Binance ${response.status}`));
    return payload;
  }

  private async okxSignedGet(path: string): Promise<Record<string, unknown>> {
    if (!this.config.okxApiKey || !this.config.okxApiSecret || !this.config.okxPassphrase) throw new Error("OKX demo API key missing");
    const timestamp = new Date().toISOString();
    const signature = await hmacSha256Base64(this.config.okxApiSecret, `${timestamp}GET${path}`);
    const response = await fetch(`https://www.okx.com${path}`, {
      headers: {
        "OK-ACCESS-KEY": this.config.okxApiKey,
        "OK-ACCESS-SIGN": signature,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": this.config.okxPassphrase,
        "x-simulated-trading": "1"
      }
    });
    const payload = await jsonRecord(response);
    if (!response.ok || payload.code !== "0") throw new Error(String(payload.msg ?? `OKX ${response.status}`));
    return payload;
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

function emptyBalances(): SandboxAssetBalance[] {
  return assetBalances([]);
}

function assetBalances(input: Array<{ asset: string; available: string; locked: string }>): SandboxAssetBalance[] {
  return (["BTC", "USDT"] as const).map((asset) => {
    const source = input.find((balance) => balance.asset === asset);
    return { asset, available: source?.available ?? "0", locked: source?.locked ?? "0" };
  });
}

function fill(exchange: "binance" | "okx", orderId: string, status: string, quantity: string, quote: string): SandboxFill {
  return {
    exchange,
    orderId,
    status,
    filledQuantity: quantity,
    quoteQuantity: quote,
    averagePrice: d(quantity).greaterThan(0) ? d(quote).div(quantity).toFixed(8) : "0",
    fetchedAt: Date.now()
  };
}

function reconciliation(
  status: SandboxReconciliation["status"],
  reason: string,
  fills: SandboxFill[] = [],
  residualBtc = "0",
  hedgeAction: SandboxReconciliation["hedgeAction"] = "NONE"
): SandboxReconciliation {
  return { checkedAt: Date.now(), status, reason, residualBtc, hedgeAction, fills };
}

async function jsonRecord(response: Response): Promise<Record<string, unknown>> {
  const payload = (await response.json().catch(() => ({}))) as unknown;
  return isRecord(payload) ? payload : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown sandbox error";
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

function normalizeQuantity(exchange: "binance" | "okx", quantity: Decimal): string {
  // BTCUSDT Spot Testnet LOT_SIZE currently uses a 0.00001000 step. OKX BTC-USDT
  // uses BTC sizing and accepts the same conservative precision for this bridge.
  const step = exchange === "binance" ? d("0.00001") : d("0.00001");
  return quantity.div(step).floor().mul(step).toFixed(5);
}

function normalizePrice(exchange: "binance" | "okx", price: Decimal): string {
  // Binance BTCUSDT testnet tickSize is 0.01000000. OKX BTC-USDT accepts two
  // decimal places at current BTC price levels.
  const tick = exchange === "binance" ? d("0.01") : d("0.01");
  return price.div(tick).floor().mul(tick).toFixed(2);
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
