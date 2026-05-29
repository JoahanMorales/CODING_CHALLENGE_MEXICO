import type { ExchangeId, SymbolId, WalletSeed } from "../types";

export interface ExchangeFeeConfig {
  maker: string;
  taker: string;
  withdrawalBtc: string;
  reliability: number;
}

export const EXCHANGE_FEES: Record<ExchangeId, ExchangeFeeConfig> = {
  binance: {
    maker: "0.001",
    taker: "0.001",
    withdrawalBtc: "0.0004",
    reliability: 0.98
  },
  kraken: {
    maker: "0.0016",
    taker: "0.0026",
    withdrawalBtc: "0.0002",
    reliability: 0.94
  },
  coinbase: {
    maker: "0.004",
    taker: "0.006",
    withdrawalBtc: "0",
    reliability: 0.91
  }
};

export const EXCHANGE_LABELS: Record<ExchangeId, string> = {
  binance: "Binance",
  kraken: "Kraken",
  coinbase: "Coinbase"
};

export const SYMBOLS: SymbolId[] = ["BTC/USDT", "ETH/USDT", "ETH/BTC"];

export const CROSS_EXCHANGE_THRESHOLD_PCT = "0.0005";

export const INITIAL_WALLETS: WalletSeed = {
  binance: { btc: "1.0", usdt: "70000" },
  kraken: { btc: "1.0", usdt: "70000" },
  coinbase: { btc: "0.5", usdt: "35000" }
};

export const EXCHANGE_WS_ENDPOINTS = {
  binance: {
    depth:
      "wss://stream.binance.com:9443/stream?streams=btcusdt@depth5@100ms/ethusdt@depth5@100ms/ethbtc@depth5@100ms"
  },
  kraken: {
    v2: "wss://ws.kraken.com/v2"
  },
  coinbase: {
    advanced: "wss://advanced-trade-ws.coinbase.com"
  }
} as const;
