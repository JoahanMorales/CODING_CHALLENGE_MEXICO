import { CROSS_EXCHANGE_THRESHOLD_PCT, EXCHANGE_FEES, EXCHANGE_IDS } from "../config/exchanges";
import { Decimal, d, pct, usd, ZERO } from "../math/decimal";
import type { ExchangeId, NormalizedOrderBook, Opportunity, SymbolId } from "../types";
import { EdgeTensor, serializeEdgeTensor } from "./EdgeTensor";
import { calculateNetProfit, midPrice, topAsk, topBid } from "./feeMath";
import { RollingWindow } from "./RollingWindow";

export class ArbitrageEngine {
  private readonly books = new Map<string, NormalizedOrderBook>();
  private readonly spreadWindows = new Map<string, RollingWindow>();
  private readonly lastStatSampleAt = new Map<string, number>();
  private readonly historicalSuccess = new Map<string, number>();
  private readonly edgeTensor = new EdgeTensor();

  onOrderBook(book: NormalizedOrderBook): Opportunity[] {
    const startedAt = performanceNow();
    this.edgeTensor.ingest(book);
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

  recordExecutionOutcome(opportunity: Opportunity, pnlUsd: number): void {
    this.updateHistoricalSuccess(opportunity.route, pnlUsd > 0);
    if (opportunity.edgeModel) {
      this.edgeTensor.recordOutcome({
        route: opportunity.route,
        predictedSurvival: Number(opportunity.edgeModel.survivalProbability),
        realizedPnlUsd: pnlUsd
      });
    }
  }

  recordShadowOutcome(route: string, predictedSurvival: number, pnlUsd: number): void {
    this.edgeTensor.recordOutcome({
      route,
      predictedSurvival,
      realizedPnlUsd: pnlUsd,
      weight: 0.22
    });
  }

  exportCalibration() {
    return this.edgeTensor.exportCalibration();
  }

  importCalibration(calibration: ReturnType<EdgeTensor["exportCalibration"]>): void {
    this.edgeTensor.importCalibration(calibration);
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
        const quoteSkewMs = Math.abs(buyBook.receivedAt - sellBook.receivedAt);
        const quotesSynchronized = quoteSkewMs <= 1800;
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
        const route = `${label(buyBook.exchange)} -> ${label(sellBook.exchange)}`;
        const tradeValue = ask.price.mul(desiredQty);
        const threshold = tradeValue.mul(CROSS_EXCHANGE_THRESHOLD_PCT);
        const takerEdge = this.edgeTensor.routeSignal({
          route,
          buyBook,
          sellBook,
          executionStyle: "INSTANT_TAKER",
          expectedProfitUsd: takerNet.netProfitUsd,
          netSpreadPct: takerNet.netSpreadPct,
          quantityBtc: desiredQty
        });
        const makerEdge = this.edgeTensor.routeSignal({
          route,
          buyBook,
          sellBook,
          executionStyle: "MAKER_ASSISTED",
          expectedProfitUsd: makerExpectedProfit,
          netSpreadPct: makerNetSpreadPct,
          quantityBtc: desiredQty
        });
        const takerExecutable = quotesSynchronized && takerEdge.riskAdjustedProfitUsd.greaterThan(threshold) && takerEdge.survivalProbability > 0.5;
        const makerExecutable = quotesSynchronized && !takerExecutable && makerEdge.riskAdjustedProfitUsd.greaterThan("0.25") && makerNetSpreadPct.greaterThan("0.000025") && makerEdge.survivalProbability > 0.54;
        const status = takerExecutable || makerExecutable ? "DETECTED" : "REJECTED";
        const executionStyle = takerExecutable ? "INSTANT_TAKER" : makerExecutable ? "MAKER_ASSISTED" : "INSTANT_TAKER";
        const selectedNet = makerExecutable ? makerNetRaw : takerNet;
        const selectedEdge = makerExecutable ? makerEdge : takerEdge;
        const selectedProfit = selectedEdge.riskAdjustedProfitUsd;
        const selectedNetSpreadPct = makerExecutable ? makerNetSpreadPct : takerNet.netSpreadPct;

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
              ? makerFillProbability.toNumber() * 0.42 + microstructureAlignment * 0.18 + selectedEdge.modelScore / 100 * 0.4
              : microstructureAlignment * 0.24 + selectedEdge.modelScore / 100 * 0.48
          }),
          confidence: takerExecutable
            ? Math.round(52 + selectedEdge.survivalProbability * 40)
            : makerExecutable
              ? Math.round(42 + makerFillProbability.toNumber() * 18 + selectedEdge.survivalProbability * 32)
              : Math.round(18 + selectedEdge.survivalProbability * 28),
          highImpact: rawImpactRatio.greaterThan("0.2"),
          impactRatio: rawImpactRatio.toNumber(),
          reason:
            !quotesSynchronized
              ? `Rejected: quote skew ${quoteSkewMs}ms exceeds the 1800ms synchronization budget.`
              : status === "DETECTED"
              ? takerExecutable
                ? `Executable instant taker edge. Edge Tensor survival ${(selectedEdge.survivalProbability * 100).toFixed(0)}%, adverse-selection ${selectedEdge.adverseSelectionBps.toFixed(2)}bps.`
                : `Executable maker-assisted paper trade. Fill ${makerFillProbability.mul(100).toFixed(0)}%, Edge Tensor survival ${(selectedEdge.survivalProbability * 100).toFixed(0)}%, microstructure alignment ${(microstructureAlignment * 100).toFixed(0)}%.`
              : `Rejected: Edge Tensor quality ${selectedEdge.edgeQuality}, survival ${(selectedEdge.survivalProbability * 100).toFixed(0)}%, risk-adjusted P&L ${usd(selectedEdge.riskAdjustedProfitUsd)} USD.`,
          edgeModel: serializeEdgeTensor(selectedEdge),
          executionPlan: {
            buyLevels: buyBook.asks.slice(0, 5),
            sellLevels: sellBook.bids.slice(0, 5),
            buyLiquidityRole: makerExecutable ? "maker" : "taker",
            sellLiquidityRole: makerExecutable ? "maker" : "taker",
            referenceBuyPrice: (makerExecutable ? makerBuyPrice : ask.price).toFixed(8),
            referenceSellPrice: (makerExecutable ? makerSellPrice : bid.price).toFixed(8)
          }
        });
      });
    });

    return opportunities;
  }

  private detectTriangular(startedAt: number): Opportunity[] {
    const opportunities: Opportunity[] = [];
    EXCHANGE_IDS.forEach((exchange) => {
      const btcUsdt = this.books.get(bookKey(exchange, "BTC/USDT"));
      const ethUsdt = this.books.get(bookKey(exchange, "ETH/USDT"));
      const ethBtc = this.books.get(bookKey(exchange, "ETH/BTC"));
      if (!btcUsdt || !ethUsdt || !ethBtc) return;
      if ([btcUsdt, ethUsdt, ethBtc].some((book) => Date.now() - book.receivedAt > 2800)) return;
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
      const slippageUsd = startingBtc.mul(btcBid.price).mul("0.0003");
      const profitUsd = profitBtc.mul(btcBid.price).minus(slippageUsd);
      const netSpreadPct = profitUsd.div(startingBtc.mul(btcBid.price));
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
        slippageUsd: usd(slippageUsd),
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
    const btcBooks = this.booksForSymbol("BTC/USDT", 1800);
    const opportunities: Opportunity[] = [];
    const now = Date.now();

    for (let left = 0; left < btcBooks.length; left += 1) {
      for (let right = left + 1; right < btcBooks.length; right += 1) {
        const leftBook = btcBooks[left];
        const rightBook = btcBooks[right];
        if (Math.abs(leftBook.receivedAt - rightBook.receivedAt) > 1200) continue;
        const leftMid = midPrice(leftBook);
        const rightMid = midPrice(rightBook);
        if (!leftMid || !rightMid) continue;

        const pairKey = [leftBook.exchange, rightBook.exchange].sort().join(":");
        const lastSampleAt = this.lastStatSampleAt.get(pairKey) ?? 0;
        if (now - lastSampleAt < 160) continue;
        this.lastStatSampleAt.set(pairKey, now);
        const window = this.spreadWindows.get(pairKey) ?? new RollingWindow(60000);
        this.spreadWindows.set(pairKey, window);
        const spread = leftMid.minus(rightMid).toNumber();
        window.push({ time: now, value: spread });
        const mean = window.mean(now);
        const stdDev = window.stdDev(now);
        if (stdDev <= 0 || window.count(now) < 12) continue;
        const zScore = (spread - mean) / stdDev;
        if (Math.abs(zScore) <= 1.35) continue;

        const reversion = estimateOuReversion(window.values(now));
        const expectedMoveUsd = d(Math.abs(spread - mean)).mul("0.54").mul(d(reversion.quality).plus("0.25"));
        const size = d("0.06");
        const referenceMid = leftMid.plus(rightMid).div(2);
        const longExchange: ExchangeId = zScore > 0 ? rightBook.exchange : leftBook.exchange;
        const shortExchange: ExchangeId = zScore > 0 ? leftBook.exchange : rightBook.exchange;
        const longBook = longExchange === leftBook.exchange ? leftBook : rightBook;
        const shortBook = shortExchange === leftBook.exchange ? leftBook : rightBook;
        const route = `STAT ARB SIGNAL ${label(longExchange)} long / ${label(shortExchange)} short`;
        // Mean reversion needs an opening and a closing leg on both venues.
        // The signal remains visible when rejected, but execution only happens
        // after round-trip taker fees and a microstructure buffer are paid.
        const roundTripFeeRate = d(EXCHANGE_FEES[longExchange].taker)
          .plus(EXCHANGE_FEES[shortExchange].taker)
          .mul(2);
        const slippageRate = d("0.0002");
        const latencyRiskRate = d("0.00014")
          .plus(d(Math.max(0, 2.1 - Math.abs(zScore))).mul("0.00004"))
          .plus(d(Math.max(0, reversion.halfLifeSamples - 55)).mul("0.000001"));
        const executionBufferRate = slippageRate.plus(latencyRiskRate);
        const totalCostRate = roundTripFeeRate.plus(executionBufferRate);
        const conservativeProfit = expectedMoveUsd.mul(size).minus(referenceMid.mul(size).mul(totalCostRate));
        const netSpreadPct = conservativeProfit.div(referenceMid.mul(size));
        const tensor = this.edgeTensor.routeSignal({
          route,
          buyBook: longBook,
          sellBook: shortBook,
          executionStyle: "STAT_MEAN_REVERSION",
          expectedProfitUsd: conservativeProfit,
          netSpreadPct,
          quantityBtc: size
        });
        const status =
          conservativeProfit.greaterThan("0.10") &&
          tensor.riskAdjustedProfitUsd.greaterThan("0.05") &&
          tensor.survivalProbability > 0.56 &&
          reversion.quality > 0.14 &&
          Math.abs(zScore) > 1.6
            ? "DETECTED"
            : "REJECTED";

        opportunities.push({
          id: cryptoId("stat"),
          type: "STAT_ARB",
          executionStyle: "STAT_MEAN_REVERSION",
          status,
          route,
          createdAt: now,
          expiresAt: now + 500,
          detectionLatencyMs: performanceNow() - startedAt,
          buyExchange: longExchange,
          sellExchange: shortExchange,
          grossSpreadPct: pct(d(Math.abs(spread)).div(referenceMid)),
          netSpreadPct: pct(netSpreadPct),
          tradeSizeBtc: size.toFixed(8),
          expectedProfitUsd: usd(tensor.riskAdjustedProfitUsd),
          grossProfitUsd: usd(expectedMoveUsd.mul(size)),
          totalFeesUsd: usd(referenceMid.mul(size).mul(roundTripFeeRate)),
          slippageUsd: usd(referenceMid.mul(size).mul(slippageRate)),
          networkCostUsd: usd(referenceMid.mul(size).mul(latencyRiskRate)),
          score: this.scoreOpportunity({
            route,
            netSpreadPct,
            quantity: size,
            availableDepth: d("0.4"),
            exchanges: [longExchange, shortExchange],
            confidenceBoost: Math.min(1, Math.abs(zScore) / 4 * 0.52 + reversion.quality * 0.24 + tensor.modelScore / 100 * 0.24)
          }),
          confidence: Math.min(99, Math.round(28 + Math.abs(zScore) * 10 + reversion.quality * 24 + tensor.survivalProbability * 28)),
          highImpact: false,
          impactRatio: 0.08,
          reason: `Stat arb multi-venue: Z ${zScore.toFixed(2)}, OU half-life ${reversion.halfLifeSamples.toFixed(1)} samples, reversion quality ${(reversion.quality * 100).toFixed(0)}%, round-trip costs ${(totalCostRate.mul(10000)).toFixed(2)}bps.`,
          edgeModel: serializeEdgeTensor(tensor)
        });
      }
    }

    return opportunities.sort((a, b) => b.score - a.score).slice(0, 3);
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

  private booksForSymbol(symbol: SymbolId, maxAgeMs = 2800): NormalizedOrderBook[] {
    const now = Date.now();
    return [...this.books.values()].filter((book) => book.symbol === symbol && now - book.receivedAt <= maxAgeMs);
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

function estimateOuReversion(values: number[]): { halfLifeSamples: number; quality: number } {
  if (values.length < 8) return { halfLifeSamples: 999, quality: 0 };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 1; index < values.length; index += 1) {
    const lag = values[index - 1] - mean;
    const change = values[index] - values[index - 1];
    numerator += lag * change;
    denominator += lag * lag;
  }
  if (denominator === 0) return { halfLifeSamples: 999, quality: 0 };
  const beta = numerator / denominator;
  const kappa = Math.max(0, -beta);
  if (kappa <= 0) return { halfLifeSamples: 999, quality: 0 };
  const halfLifeSamples = Math.log(2) / kappa;
  const quality = Math.max(0, Math.min(1, (80 - halfLifeSamples) / 80));
  return { halfLifeSamples, quality };
}
