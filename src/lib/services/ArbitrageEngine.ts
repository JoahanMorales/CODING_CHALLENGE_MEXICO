import { CROSS_EXCHANGE_THRESHOLD_PCT, EXCHANGE_FEES } from "../config/exchanges";
import { Decimal, d, pct, usd, ZERO } from "../math/decimal";
import type { ExchangeId, NormalizedOrderBook, Opportunity, SymbolId } from "../types";
import { calculateNetProfit, midPrice, topAsk, topBid } from "./feeMath";
import { RollingWindow } from "./RollingWindow";

export class ArbitrageEngine {
  private readonly books = new Map<string, NormalizedOrderBook>();
  private readonly spreadWindow = new RollingWindow(60000);
  private readonly historicalSuccess = new Map<string, number>();

  onOrderBook(book: NormalizedOrderBook): Opportunity[] {
    const startedAt = performanceNow();
    this.books.set(bookKey(book.exchange, book.symbol), book);
    const opportunities = [
      ...this.detectCrossExchange(startedAt),
      ...this.detectTriangular(startedAt),
      ...this.detectStatistical(startedAt)
    ];
    return opportunities.sort((a, b) => b.score - a.score);
  }

  calculateNetProfit = calculateNetProfit;

  snapshotBooks(): NormalizedOrderBook[] {
    return [...this.books.values()];
  }

  updateHistoricalSuccess(route: string, profitable: boolean): void {
    const prior = this.historicalSuccess.get(route) ?? 0.68;
    const next = prior * 0.86 + (profitable ? 1 : 0) * 0.14;
    this.historicalSuccess.set(route, next);
  }

  private detectCrossExchange(startedAt: number): Opportunity[] {
    const btcBooks = this.booksForSymbol("BTC/USDT");
    const opportunities: Opportunity[] = [];

    btcBooks.forEach((buyBook) => {
      btcBooks.forEach((sellBook) => {
        if (buyBook.exchange === sellBook.exchange) return;
        const ask = topAsk(buyBook);
        const bid = topBid(sellBook);
        if (!ask || !bid || bid.price.lessThanOrEqualTo(ask.price)) return;
        const topDepth = Decimal.min(ask.size, bid.size);
        const uncappedQty = Decimal.min(d("0.1"), ask.size, bid.size);
        const rawImpactRatio = topDepth.greaterThan(0) ? uncappedQty.div(topDepth) : d(1);
        // Production arbitrage desks operate prefunded wallets and rebalance in batches.
        // We therefore charge an amortized rebalance cost while limiting any single trade
        // to at most 20% of visible top-level liquidity.
        const desiredQty = rawImpactRatio.greaterThan("0.2") ? Decimal.min(uncappedQty, topDepth.mul("0.2")) : uncappedQty;
        const takerNet = calculateNetProfit({
          buyExchange: buyBook.exchange,
          sellExchange: sellBook.exchange,
          askPrice: ask.price,
          bidPrice: bid.price,
          quantityBtc: desiredQty,
          availableAskQty: ask.size,
          availableBidQty: bid.size,
          includeWithdrawal: true,
          withdrawalAmortization: d("0.02")
        });
        const buyTopBid = topBid(buyBook);
        const sellTopAsk = topAsk(sellBook);
        const makerBuyPrice = buyTopBid
          ? ask.price.minus(ask.price.minus(buyTopBid.price).mul("0.35"))
          : ask.price;
        const makerSellPrice = sellTopAsk
          ? bid.price.plus(sellTopAsk.price.minus(bid.price).mul("0.35"))
          : bid.price;
        const makerNetRaw = calculateNetProfit({
          buyExchange: buyBook.exchange,
          sellExchange: sellBook.exchange,
          askPrice: makerBuyPrice,
          bidPrice: makerSellPrice,
          quantityBtc: desiredQty,
          availableAskQty: ask.size,
          availableBidQty: bid.size,
          includeWithdrawal: true,
          withdrawalAmortization: d("0.01"),
          buyLiquidityRole: "maker",
          sellLiquidityRole: "maker"
        });
        const makerFillProbability = this.estimateMakerFillProbability(buyBook, sellBook, desiredQty);
        const microstructureAlignment = this.microstructureAlignment(buyBook, sellBook);
        const makerRiskMultiplier = d("1.18").minus(d(microstructureAlignment).mul("0.36"));
        const makerRiskCost = makerBuyPrice
          .mul(desiredQty)
          .mul(d("0.00012").plus(d(1).minus(makerFillProbability).mul("0.00018")))
          .mul(makerRiskMultiplier);
        const makerExpectedProfit = makerNetRaw.netProfitUsd.mul(makerFillProbability).minus(makerRiskCost);
        const makerNetSpreadPct = makerBuyPrice.mul(desiredQty).greaterThan(0)
          ? makerExpectedProfit.div(makerBuyPrice.mul(desiredQty))
          : d(0);
        const tradeValue = ask.price.mul(desiredQty);
        const threshold = tradeValue.mul(CROSS_EXCHANGE_THRESHOLD_PCT);
        const takerExecutable = takerNet.netProfitUsd.greaterThan(threshold);
        const makerExecutable = !takerExecutable && makerExpectedProfit.greaterThan("0.35") && makerNetSpreadPct.greaterThan("0.00004");
        const status = takerExecutable || makerExecutable ? "DETECTED" : "REJECTED";
        const executionStyle = takerExecutable ? "INSTANT_TAKER" : makerExecutable ? "MAKER_ASSISTED" : "INSTANT_TAKER";
        const selectedNet = makerExecutable ? makerNetRaw : takerNet;
        const selectedProfit = makerExecutable ? makerExpectedProfit : takerNet.netProfitUsd;
        const selectedNetSpreadPct = makerExecutable ? makerNetSpreadPct : takerNet.netSpreadPct;
        const route = `${label(buyBook.exchange)} -> ${label(sellBook.exchange)}`;

        opportunities.push({
          id: cryptoId("cross"),
          type: "CROSS_EXCHANGE",
          executionStyle,
          status,
          route,
          createdAt: Date.now(),
          expiresAt: Date.now() + 500,
          detectionLatencyMs: performanceNow() - startedAt,
          buyExchange: buyBook.exchange,
          sellExchange: sellBook.exchange,
          grossSpreadPct: pct(selectedNet.grossSpreadPct),
          netSpreadPct: pct(selectedNetSpreadPct),
          tradeSizeBtc: desiredQty.toFixed(8),
          expectedProfitUsd: usd(selectedProfit),
          grossProfitUsd: usd(selectedNet.grossProfitUsd),
          totalFeesUsd: usd(selectedNet.buyFeeUsd.plus(selectedNet.sellFeeUsd)),
          slippageUsd: usd(selectedNet.slippageUsd),
          networkCostUsd: usd(selectedNet.networkCostUsd.plus(makerExecutable ? makerRiskCost : 0)),
          score: this.scoreOpportunity({
            route,
            netSpreadPct: selectedNetSpreadPct,
            quantity: desiredQty,
            availableDepth: Decimal.min(ask.size, bid.size),
            exchanges: [buyBook.exchange, sellBook.exchange],
            confidenceBoost: makerExecutable
              ? makerFillProbability.toNumber() * 0.7 + microstructureAlignment * 0.3
              : microstructureAlignment * 0.55
          }),
          confidence: takerExecutable ? Math.round(70 + microstructureAlignment * 18) : makerExecutable ? Math.round(54 + makerFillProbability.toNumber() * 24 + microstructureAlignment * 12) : 32,
          highImpact: rawImpactRatio.greaterThan("0.2"),
          impactRatio: rawImpactRatio.toNumber(),
          reason:
            status === "DETECTED"
              ? takerExecutable
                ? "Executable instant taker edge after fees, slippage and amortized rebalance cost."
                : `Executable maker-assisted paper trade: expected fill probability ${makerFillProbability.mul(100).toFixed(0)}%, microstructure alignment ${(microstructureAlignment * 100).toFixed(0)}%, lower maker fees, queue-risk adjusted.`
              : "Rejected: live spread does not survive taker/maker fee, slippage and queue-risk models."
        });
      });
    });

    return opportunities;
  }

  private detectTriangular(startedAt: number): Opportunity[] {
    const opportunities: Opportunity[] = [];
    (["binance", "kraken", "coinbase"] as ExchangeId[]).forEach((exchange) => {
      const btcUsdt = this.books.get(bookKey(exchange, "BTC/USDT"));
      const ethUsdt = this.books.get(bookKey(exchange, "ETH/USDT"));
      const ethBtc = this.books.get(bookKey(exchange, "ETH/BTC"));
      if (!btcUsdt || !ethUsdt || !ethBtc) return;
      const btcBid = topBid(btcUsdt);
      const ethAsk = topAsk(ethUsdt);
      const ethBtcBid = topBid(ethBtc);
      if (!btcBid || !ethAsk || !ethBtcBid) return;

      // Cycle math: 1 BTC -> USDT at BTC/USDT bid -> ETH at ETH/USDT ask -> BTC at ETH/BTC bid.
      const startingBtc = d("0.1");
      const usdt = startingBtc.mul(btcBid.price).mul(d(1).minus(EXCHANGE_FEES[exchange].taker));
      const eth = usdt.div(ethAsk.price).mul(d(1).minus(EXCHANGE_FEES[exchange].taker));
      const endingBtc = eth.mul(ethBtcBid.price).mul(d(1).minus(EXCHANGE_FEES[exchange].taker));
      const profitBtc = endingBtc.minus(startingBtc);
      const profitUsd = profitBtc.mul(btcBid.price);
      const netSpreadPct = profitBtc.div(startingBtc);
      if (netSpreadPct.lessThan("-0.001")) return;

      const route = `${label(exchange)} BTC/USDT -> ETH/USDT -> ETH/BTC`;
      const status = profitUsd.greaterThan(startingBtc.mul(btcBid.price).mul(CROSS_EXCHANGE_THRESHOLD_PCT))
        ? "DETECTED"
        : "REJECTED";
      opportunities.push({
        id: cryptoId("tri"),
        type: "TRIANGULAR",
        executionStyle: "TRIANGULAR_CYCLE",
        status,
        route,
        createdAt: Date.now(),
        expiresAt: Date.now() + 500,
        detectionLatencyMs: performanceNow() - startedAt,
        exchange,
        grossSpreadPct: pct(netSpreadPct),
        netSpreadPct: pct(netSpreadPct),
        tradeSizeBtc: startingBtc.toFixed(8),
        expectedProfitUsd: usd(profitUsd),
        grossProfitUsd: usd(profitUsd),
        totalFeesUsd: usd(startingBtc.mul(btcBid.price).mul(EXCHANGE_FEES[exchange].taker).mul(3)),
        slippageUsd: usd(startingBtc.mul(btcBid.price).mul("0.0003")),
        networkCostUsd: "0.00",
        score: this.scoreOpportunity({
          route,
          netSpreadPct,
          quantity: startingBtc,
          availableDepth: Decimal.min(btcBid.size, ethAsk.size.mul(ethBtcBid.price), ethBtcBid.size),
          exchanges: [exchange]
        }),
        confidence: netSpreadPct.greaterThan(0) ? 81 : 38,
        highImpact: false,
        impactRatio: 0.12,
        reason: "Circular BTC -> USDT -> ETH -> BTC rate product checked after taker fees."
      });
    });
    return opportunities;
  }

  private detectStatistical(startedAt: number): Opportunity[] {
    const binance = this.books.get(bookKey("binance", "BTC/USDT"));
    const kraken = this.books.get(bookKey("kraken", "BTC/USDT"));
    if (!binance || !kraken) return [];
    const binanceMid = midPrice(binance);
    const krakenMid = midPrice(kraken);
    if (!binanceMid || !krakenMid) return [];
    const spread = binanceMid.minus(krakenMid).toNumber();
    const now = Date.now();
    this.spreadWindow.push({ time: now, value: spread });
    const mean = this.spreadWindow.mean(now);
    const stdDev = this.spreadWindow.stdDev(now);
    if (stdDev <= 0) return [];
    const zScore = (spread - mean) / stdDev;
    if (this.spreadWindow.count(now) < 12 || Math.abs(zScore) <= 1.15) return [];

    const expectedMoveUsd = d(Math.abs(spread - mean)).mul("0.56");
    const size = d("0.08");
    const hedgeCostRate = d("0.00008").plus(d(Math.max(0, 2 - Math.abs(zScore))).mul("0.000035"));
    const expectedProfit = expectedMoveUsd.mul(size).minus(binanceMid.mul(size).mul(hedgeCostRate));
    const longExchange: ExchangeId = zScore > 0 ? "kraken" : "binance";
    const shortExchange: ExchangeId = zScore > 0 ? "binance" : "kraken";
    const route = `STAT ARB SIGNAL ${label(longExchange)} long / ${label(shortExchange)} short`;
    const netSpreadPct = expectedProfit.div(binanceMid.mul(size));

    return [
      {
        id: cryptoId("stat"),
        type: "STAT_ARB",
        executionStyle: "STAT_MEAN_REVERSION",
        status: expectedProfit.greaterThan("0.05") ? "DETECTED" : "REJECTED",
        route,
        createdAt: now,
        expiresAt: now + 500,
        detectionLatencyMs: performanceNow() - startedAt,
        buyExchange: longExchange,
        sellExchange: shortExchange,
        grossSpreadPct: pct(d(Math.abs(spread)).div(binanceMid)),
        netSpreadPct: pct(netSpreadPct),
        tradeSizeBtc: size.toFixed(8),
        expectedProfitUsd: usd(expectedProfit),
        grossProfitUsd: usd(expectedMoveUsd.mul(size)),
        totalFeesUsd: usd(binanceMid.mul(size).mul(hedgeCostRate)),
        slippageUsd: usd(binanceMid.mul(size).mul("0.0002")),
        networkCostUsd: "0.00",
        score: this.scoreOpportunity({
          route,
          netSpreadPct,
          quantity: size,
          availableDepth: d("0.4"),
          exchanges: [longExchange, shortExchange],
          confidenceBoost: Math.min(1, Math.abs(zScore) / 4)
        }),
        confidence: Math.min(99, Math.round(50 + Math.abs(zScore) * 15)),
        highImpact: false,
        impactRatio: 0.08,
        reason: `Stat arb paper trade: 60-second spread Z-score ${zScore.toFixed(2)} crossed +/-1.15; expected convergence after hedge cost is ${usd(expectedProfit)} USD.`
      }
    ];
  }

  private estimateMakerFillProbability(buyBook: NormalizedOrderBook, sellBook: NormalizedOrderBook, quantity: Decimal): Decimal {
    const buyBid = topBid(buyBook);
    const buyAsk = topAsk(buyBook);
    const sellBid = topBid(sellBook);
    const sellAsk = topAsk(sellBook);
    if (!buyBid || !buyAsk || !sellBid || !sellAsk) return d("0.35");
    const buySpreadBps = buyAsk.price.minus(buyBid.price).div(buyAsk.price).mul(10000);
    const sellSpreadBps = sellAsk.price.minus(sellBid.price).div(sellAsk.price).mul(10000);
    const depth = Decimal.min(buyBid.size.plus(buyAsk.size), sellBid.size.plus(sellAsk.size));
    const depthScore = Decimal.min(1, depth.div(Decimal.max(quantity.mul(6), d("0.0001"))));
    const spreadScore = Decimal.max(0, d(1).minus(buySpreadBps.plus(sellSpreadBps).div(12)));
    return Decimal.max("0.18", Decimal.min("0.82", d("0.28").plus(depthScore.mul("0.34")).plus(spreadScore.mul("0.20"))));
  }

  private microstructureAlignment(buyBook: NormalizedOrderBook, sellBook: NormalizedOrderBook): number {
    const buySkew = this.microSkewBps(buyBook);
    const sellSkew = this.microSkewBps(sellBook);
    const buyImbalance = this.bookImbalance(buyBook);
    const sellImbalance = this.bookImbalance(sellBook);
    // Maker-assisted cross-exchange trades are cleaner when the buy venue has
    // sell pressure and the sell venue has buy pressure. This reduces leg risk.
    const skewScore = sigmoid((-buySkew + sellSkew) / 4);
    const imbalanceScore = sigmoid((-buyImbalance + sellImbalance) / 0.7);
    return Math.max(0, Math.min(1, skewScore * 0.62 + imbalanceScore * 0.38));
  }

  private microSkewBps(book: NormalizedOrderBook): number {
    const bid = topBid(book);
    const ask = topAsk(book);
    if (!bid || !ask) return 0;
    const total = bid.size.plus(ask.size);
    if (total.lessThanOrEqualTo(0)) return 0;
    const mid = bid.price.plus(ask.price).div(2);
    const microprice = bid.price.mul(ask.size).plus(ask.price.mul(bid.size)).div(total);
    return microprice.minus(mid).div(mid).mul(10000).toNumber();
  }

  private bookImbalance(book: NormalizedOrderBook): number {
    const bidDepth = book.bids.slice(0, 5).reduce((sum, level) => sum.plus(level.size), ZERO);
    const askDepth = book.asks.slice(0, 5).reduce((sum, level) => sum.plus(level.size), ZERO);
    const total = bidDepth.plus(askDepth);
    return total.greaterThan(0) ? bidDepth.minus(askDepth).div(total).toNumber() : 0;
  }

  private scoreOpportunity(input: {
    route: string;
    netSpreadPct: Decimal;
    quantity: Decimal;
    availableDepth: Decimal;
    exchanges: ExchangeId[];
    confidenceBoost?: number;
  }): number {
    const profitability = Decimal.max(0, input.netSpreadPct.div(CROSS_EXCHANGE_THRESHOLD_PCT)).mul(40);
    const liquidity = Decimal.min(1, input.availableDepth.div(Decimal.max(input.quantity, d("0.00000001")))).mul(30);
    const reliability =
      input.exchanges.reduce((sum, exchange) => sum + EXCHANGE_FEES[exchange].reliability, 0) / input.exchanges.length * 20;
    const historical = (this.historicalSuccess.get(input.route) ?? 0.68) * 10;
    const boost = (input.confidenceBoost ?? 0) * 6;
    return Math.round(Math.max(0, Math.min(100, profitability.plus(liquidity).plus(reliability).plus(historical).plus(boost).toNumber())));
  }

  private booksForSymbol(symbol: SymbolId): NormalizedOrderBook[] {
    return [...this.books.values()].filter((book) => book.symbol === symbol);
  }
}

function bookKey(exchange: ExchangeId, symbol: SymbolId): string {
  return `${exchange}:${symbol}`;
}

function label(exchange: ExchangeId): string {
  return exchange[0].toUpperCase() + exchange.slice(1);
}

function performanceNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function cryptoId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}
