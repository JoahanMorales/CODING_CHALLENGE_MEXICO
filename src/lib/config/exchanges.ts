import type { ExchangeId, SymbolId, WalletSeed } from "../types";

export interface ExchangeFeeConfig {
  maker: string;
  taker: string;
  withdrawalBtc: string;
  reliability: number;
}

export const EXCHANGE_IDS: ExchangeId[] = ["binance", "kraken", "coinbase", "okx", "bybit", "bitfinex", "gate", "bitstamp"];

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
  },
  okx: {
    maker: "0.0008",
    taker: "0.001",
    withdrawalBtc: "0.0004",
    reliability: 0.93
  },
  bybit: {
    maker: "0.001",
    taker: "0.001",
    withdrawalBtc: "0.0002",
    reliability: 0.92
  },
  bitfinex: {
    maker: "0.001",
    taker: "0.002",
    withdrawalBtc: "0.0004",
    reliability: 0.9
  },
  gate: {
    maker: "0.001",
    taker: "0.001",
    withdrawalBtc: "0.0002",
    reliability: 0.89
  },
  bitstamp: {
    maker: "0.003",
    taker: "0.004",
    withdrawalBtc: "0.0005",
    reliability: 0.9
  }
};

export const EXCHANGE_LABELS: Record<ExchangeId, string> = {
  binance: "Binance",
  kraken: "Kraken",
  coinbase: "Coinbase",
  okx: "OKX",
  bybit: "Bybit",
  bitfinex: "Bitfinex",
  gate: "Gate",
  bitstamp: "Bitstamp"
};

export const SYMBOLS: SymbolId[] = ["BTC/USDT", "ETH/USDT", "ETH/BTC"];

export const CROSS_EXCHANGE_THRESHOLD_PCT = "0.0005";

export const INITIAL_WALLETS: WalletSeed = {
  binance: { btc: "1.0", usdt: "70000" },
  kraken: { btc: "1.0", usdt: "70000" },
  coinbase: { btc: "0.5", usdt: "35000" },
  okx: { btc: "0.8", usdt: "56000" },
  bybit: { btc: "0.8", usdt: "56000" },
  bitfinex: { btc: "0.6", usdt: "42000" },
  gate: { btc: "0.6", usdt: "42000" },
  bitstamp: { btc: "0.5", usdt: "35000" }
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
  },
  okx: {
    public: "wss://ws.okx.com:8443/ws/v5/public"
  },
  bybit: {
    spot: "wss://stream.bybit.com/v5/public/spot"
  },
  bitfinex: {
    public: "wss://api-pub.bitfinex.com/ws/2"
  },
  gate: {
    spot: "wss://api.gateio.ws/ws/v4/"
  },
  bitstamp: {
    public: "wss://ws.bitstamp.net"
  }
} as const;
