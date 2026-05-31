import { d } from "../math/decimal";
import type { OrderBookLevel, QuoteAsset } from "../types";

const DEFAULT_USDT_USD_RATE = "1";

export class QuoteNormalizer {
  private usdtUsdRate = d(DEFAULT_USDT_USD_RATE);
  private updatedAt = 0;

  setUsdtUsdRate(rate: string | number, updatedAt = Date.now()): void {
    const next = d(rate);
    if (!next.isFinite() || next.lessThan("0.94") || next.greaterThan("1.06")) return;
    this.usdtUsdRate = next;
    this.updatedAt = updatedAt;
  }

  quoteToUsdRate(asset: QuoteAsset): string {
    return asset === "USDT" ? this.usdtUsdRate.toFixed(8) : "1.00000000";
  }

  quoteBasisBps(asset: QuoteAsset): string {
    return asset === "USDT" ? this.usdtUsdRate.minus(1).mul(10000).toFixed(3) : "0.000";
  }

  normalizeLevels(levels: Array<[string, string]>, asset: QuoteAsset): OrderBookLevel[] {
    const rate = asset === "USDT" ? this.usdtUsdRate : d(1);
    return levels.slice(0, 5).map(([sourcePrice, size]) => ({
      price: asset === "BTC" ? sourcePrice : d(sourcePrice).mul(rate).toFixed(8),
      size,
      sourcePrice
    }));
  }

  snapshot(): { usdtUsdRate: string; basisBps: string; updatedAt: number } {
    return {
      usdtUsdRate: this.usdtUsdRate.toFixed(8),
      basisBps: this.usdtUsdRate.minus(1).mul(10000).toFixed(3),
      updatedAt: this.updatedAt
    };
  }
}
