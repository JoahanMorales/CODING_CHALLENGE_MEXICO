import { readFileSync } from "node:fs";

loadLocalEnv();

const quantity = process.argv[2] ?? "";
if (process.env.SANDBOX_ORDER_MODE !== "LIVE_SANDBOX") throw new Error("LIVE_SANDBOX is required.");
if (process.env.CONFIRM_SANDBOX_HEDGE !== "YES") throw new Error("Set CONFIRM_SANDBOX_HEDGE=YES for a deliberate demo hedge.");
if (!/^\d+(\.\d+)?$/.test(quantity) || Number(quantity) <= 0 || Number(quantity) > 0.001) {
  throw new Error("Hedge quantity must be positive and no greater than 0.001 BTC.");
}

const key = process.env.OKX_DEMO_API_KEY ?? "";
const secret = process.env.OKX_DEMO_API_SECRET ?? "";
const passphrase = process.env.OKX_DEMO_API_PASSPHRASE ?? "";
if (!key || !secret || !passphrase) throw new Error("OKX Demo credentials are required.");

const tickerPayload = await fetch("https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT").then(jsonRecord);
const ticker = Array.isArray(tickerPayload.data) && isRecord(tickerPayload.data[0]) ? tickerPayload.data[0] : {};
const price = (Number(ticker.bidPx) * 0.995).toFixed(1);
const path = "/api/v5/trade/order";
const timestamp = new Date().toISOString();
const body = JSON.stringify({
  instId: "BTC-USDT",
  tdMode: "cash",
  clOrdId: `arbaihedge${Date.now().toString(36)}`.slice(0, 32),
  side: "sell",
  ordType: "ioc",
  px: price,
  sz: quantity
});
const signature = await hmacSha256Base64(secret, `${timestamp}POST${path}${body}`);
const payload = await fetch(`https://www.okx.com${path}`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "OK-ACCESS-KEY": key,
    "OK-ACCESS-SIGN": signature,
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": passphrase,
    "x-simulated-trading": "1"
  },
  body
}).then(jsonRecord);

console.log(JSON.stringify(payload, null, 2));

function loadLocalEnv(): void {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([^#][^=]*)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  }
}

async function jsonRecord(response: Response): Promise<Record<string, unknown>> {
  const payload = (await response.json()) as unknown;
  if (!response.ok || !isRecord(payload)) throw new Error(`OKX request failed with ${response.status}.`);
  return payload;
}

async function hmacSha256Base64(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
  return Buffer.from(bytes).toString("base64");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
