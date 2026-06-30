import { CROSS_EXCHANGE_THRESHOLD_PCT, EXCHANGE_FEES, EXCHANGE_IDS } from "../config/exchanges";
import { Decimal, d, pct, usd, ZERO } from "../math/decimal";
import type { ExchangeId, NormalizedOrderBook, Opportunity, SymbolId } from "../types";
import { EdgeTensor, serializeEdgeTensor } from "./EdgeTensor";
import { calculateNetProfit, midPrice, simulateVwap, topAsk, topBid } from "./feeMath";
import { MlEdgeTensor } from "./MlEdgeTensor";
import { RollingWindow } from "./RollingWindow";

export class ArbitrageEngine {
  private readonly books = new Map<string, NormalizedOrderBook>();
  private readonly spreadWindows = new Map<string, RollingWindow>();
  private readonly lastStatSampleAt = new Map<string, number>();
  private readonly historicalSuccess = new Map<string, number>();
  private readonly edgeTensor = new EdgeTensor();
  readonly mlEdgeTensor = new MlEdgeTensor();

  onOrderBook(book: NormalizedOrderBook): Opportunity[] {
    const startedAt = performanceNow();
    this.edgeTensor.ingest(book);
    this.books.set(bookKey(book.exchange, book.symbol), book);
    const opportunities = [
      ...(book.symbol === "BTC/USDT" ? this.detectCrossExchange(startedAt, book.exchange) : []),
      ...this.detectTriangular(startedAt, book.exchange),
      ...(book.symbol === "BTC/USDT" ? this.detectStatistical(startedAt, book.exchange) : [])
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
    this.trainMlModel(opportunity, pnlUsd, 1);
  }

  recordShadowOutcome(route: string, predictedSurvival: number, pnlUsd: number): void {
    this.edgeTensor.recordOutcome({
      route,
      predictedSurvival,
      realizedPnlUsd: pnlUsd,
      weight: 0.22
    });
  }

  trainMlModel(opportunity: Opportunity, pnlUsd: number, weight?: number): void {
    const buyBook = opportunity.buyExchange
      ? this.books.get(bookKey(opportunity.buyExchange, "BTC/USDT"))
      : undefined;
    const sellBook = opportunity.sellExchange
      ? this.books.get(bookKey(opportunity.sellExchange, "BTC/USDT"))
      : undefined;
    if (!buyBook || !sellBook) return;
    const features = this.mlEdgeTensor.extractFeatures(
      buyBook,
      sellBook,
      d(opportunity.tradeSizeBtc),
      opportunity.executionStyle,
      d(opportunity.netSpreadPct)
    );
    const realizedWin = pnlUsd > 0 ? 1 : 0;
    this.mlEdgeTensor.train(opportunity.route, features, realizedWin, weight ?? 0.3);
    this.mlEdgeTensor.recordOutcome(opportunity.route, Number(opportunity.edgeModel?.survivalProbability ?? 0.5), pnlUsd, weight);
  }

  exportCalibration() {
    return this.edgeTensor.exportCalibration();
  }

  importCalibration(calibration: ReturnType<EdgeTensor["exportCalibration"]>): void {
    this.edgeTensor.importCalibration(calibration);
  }

  calibrationSummary(): ReturnType<EdgeTensor["calibrationSummary"]> {
    return this.edgeTensor.calibrationSummary();
  }

  private detectCrossExchange(startedAt: number, changedExchange: ExchangeId): Opportunity[] {
    const btcBooks = this.booksForSymbol("BTC/USDT");
    const opportunities: Opportunity[] = [];

    btcBooks.forEach((buyBook) => {
      btcBooks.forEach((sellBook) => {
        if (buyBook.exchange === sellBook.exchange) return;
        if (buyBook.exchange !== changedExchange && sellBook.exchange !== changedExchange) return;
        const ask = topAsk(buyBook);
        const bid = topBid(sellBook);
        if (!ask || !bid || bid.price.lessThanOrEqualTo(ask.price)) return;
        const quoteSkewMs = Math.abs(buyBook.receivedAt - sellBook.receivedAt);
        const quotesSynchronized = quoteSkewMs <= 1800;
        const buyAskDepth5 = buyBook.asks.slice(0, 5).reduce((s, l) => s.plus(d(l.size)), ZERO);
        const sellBidDepth5 = sellBook.bids.slice(0, 5).reduce((s, l) => s.plus(d(l.size)), ZERO);
        const depth5Total = Decimal.min(buyAskDepth5, sellBidDepth5);
        const depthBasedSize = depth5Total.mul("0.18");
        const uncappedQty = Decimal.min(d("0.1"), depthBasedSize);
        const rawImpactRatio = depth5Total.greaterThan(0) ? uncappedQty.div(Decimal.min(ask.size, bid.size)) : d(1);
        const desiredQty = rawImpactRatio.greaterThan("0.2") ? Decimal.min(uncappedQty, depth5Total.mul("0.2")) : uncappedQty;
        const takerNet = calculateNetProfit({
          buyExchange: buyBook.exchange,
          sellExchange: sellBook.exchange,
          askPrice: ask.price,
          bidPrice: bid.price,
          quantityBtc: desiredQty,
          availableAskQty: ask.size,
          availableBidQty: bid.size,
          includeWithdrawal: true,
          withdrawalAmortization: d("0.02"),
          buyQuoteAsset: buyBook.quoteAsset,
          sellQuoteAsset: sellBook.quoteAsset,
          buyQuoteToUsdRate: d(buyBook.quoteToUsdRate),
          sellQuoteToUsdRate: d(sellBook.quoteToUsdRate)
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
          sellLiquidityRole: "maker",
          buyQuoteAsset: buyBook.quoteAsset,
          sellQuoteAsset: sellBook.quoteAsset,
          buyQuoteToUsdRate: d(buyBook.quoteToUsdRate),
          sellQuoteToUsdRate: d(sellBook.quoteToUsdRate)
        });
        const makerFillProbability = this.estimateMakerFillProbability(buyBook, sellBook, desiredQty);
        const microstructureAlignment = this.microstructureAlignment(buyBook, sellBook);
        const makerRiskMultiplier = d("1.18").minus(d(microstructureAlignment).mul("0.36"));
        const makerRiskCost = makerBuyPrice
          .mul(desiredQty)
          .mul(d("0.00012").plus(d(1).minus(makerFillProbability).mul("0.00018")))
          .mul(makerRiskMultiplier);
        const makerExpectedProfit = makerNetRaw.rebalanceAdjustedProfitUsd.mul(makerFillProbability).minus(makerRiskCost);
        const makerNetSpreadPct = makerBuyPrice.mul(desiredQty).greaterThan(0)
          ? makerExpectedProfit.div(makerBuyPrice.mul(desiredQty))
          : d(0);
        const route = `${label(buyBook.exchange)} -> ${label(sellBook.exchange)}`;
        const tradeValue = ask.price.mul(desiredQty);
        const baseThreshold = tradeValue.mul(CROSS_EXCHANGE_THRESHOLD_PCT);
        const takerEdge = this.edgeTensor.routeSignal({
          route,
          buyBook,
          sellBook,
          executionStyle: "INSTANT_TAKER",
          expectedProfitUsd: takerNet.rebalanceAdjustedProfitUsd,
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
        const effectiveVolatilityBps = (takerEdge.volatilityBps + makerEdge.volatilityBps) / 2;
        const volatilityMultiplier = Math.max(1.0, Math.min(2, 1 + (effectiveVolatilityBps - 1.5) / 5));
        const threshold = baseThreshold.mul(volatilityMultiplier);
        // Hybrid: buy leg as maker (better price, lower fee), sell leg as taker (guaranteed fill)
        const hybridNet = calculateNetProfit({
          buyExchange: buyBook.exchange,
          sellExchange: sellBook.exchange,
          askPrice: makerBuyPrice,
          bidPrice: bid.price,
          quantityBtc: desiredQty,
          availableAskQty: ask.size,
          availableBidQty: bid.size,
          includeWithdrawal: true,
          withdrawalAmortization: d("0.015"),
          buyLiquidityRole: "maker",
          sellLiquidityRole: "taker",
          buyQuoteAsset: buyBook.quoteAsset,
          sellQuoteAsset: sellBook.quoteAsset,
          buyQuoteToUsdRate: d(buyBook.quoteToUsdRate),
          sellQuoteToUsdRate: d(sellBook.quoteToUsdRate)
        });
        const hybridMakerFillProbability = this.estimateMakerFillProbability(buyBook, sellBook, desiredQty);
        const hybridRiskCost = makerBuyPrice
          .mul(desiredQty)
          .mul(d("0.00010").plus(d(1).minus(hybridMakerFillProbability).mul("0.00012")))
          .mul(makerRiskMultiplier);
        const hybridExpectedProfit = hybridNet.rebalanceAdjustedProfitUsd.mul(hybridMakerFillProbability).minus(hybridRiskCost);
        const hybridNetSpreadPct = makerBuyPrice.mul(desiredQty).greaterThan(0)
          ? hybridExpectedProfit.div(makerBuyPrice.mul(desiredQty))
          : d(0);
        const hybridEdge = this.edgeTensor.routeSignal({
          route,
          buyBook,
          sellBook,
          executionStyle: "MAKER_ASSISTED",
          expectedProfitUsd: hybridExpectedProfit,
          netSpreadPct: hybridNetSpreadPct,
          quantityBtc: desiredQty
        });

        const booksHealthy = buyBook.integrity.status !== "DEGRADED" && sellBook.integrity.status !== "DEGRADED";
        const takerExecutable = quotesSynchronized && booksHealthy && takerEdge.expectedValueUsd.greaterThan(threshold) && takerEdge.survivalProbability > 0.5;
        const makerExecutable = quotesSynchronized && booksHealthy && !takerExecutable && makerEdge.expectedValueUsd.greaterThan("0.25") && makerNetSpreadPct.greaterThan("0.000025") && makerEdge.survivalProbability > 0.54;
        const hybridExecutable = quotesSynchronized && booksHealthy && !takerExecutable && !makerExecutable && hybridEdge.expectedValueUsd.greaterThan("0.25") && hybridNetSpreadPct.greaterThan("0.000025") && hybridEdge.survivalProbability > 0.54;
        const status = takerExecutable || makerExecutable || hybridExecutable ? "DETECTED" : "REJECTED";
        const executionStyle = takerExecutable ? "INSTANT_TAKER" : makerExecutable ? "MAKER_ASSISTED" : "INSTANT_TAKER";
        const selectedNet = makerExecutable ? makerNetRaw : hybridExecutable ? hybridNet : takerNet;
        const selectedEdge = makerExecutable ? makerEdge : hybridExecutable ? hybridEdge : takerEdge;
        const selectedProfit = selectedEdge.riskAdjustedProfitUsd;
        const selectedNetSpreadPct = makerExecutable ? makerNetSpreadPct : hybridExecutable ? hybridNetSpreadPct : takerNet.netSpreadPct;
        const isMakerSelected = makerExecutable || hybridExecutable;

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
          expectedValueUsd: usd(selectedEdge.expectedValueUsd),
          executionNetProfitUsd: usd(selectedNet.netProfitUsd),
          rebalanceAdjustedProfitUsd: usd(selectedNet.rebalanceAdjustedProfitUsd),
          grossProfitUsd: usd(selectedNet.grossProfitUsd),
          totalFeesUsd: usd(selectedNet.buyFeeUsd.plus(selectedNet.sellFeeUsd)),
          slippageUsd: usd(selectedNet.slippageUsd),
          networkCostUsd: usd(selectedNet.networkCostUsd.plus(isMakerSelected ? makerRiskCost : 0)),
          quoteConversionCostUsd: usd(selectedNet.quoteConversionCostUsd),
          rebalanceCostUsd: usd(selectedNet.rebalanceCostUsd),
          score: this.scoreOpportunity({
            route,
            netSpreadPct: selectedNetSpreadPct,
            quantity: desiredQty,
            availableDepth: Decimal.min(ask.size, bid.size),
            exchanges: [buyBook.exchange, sellBook.exchange],
            expectedValueUsd: selectedEdge.expectedValueUsd,
            confidenceBoost: isMakerSelected
              ? (makerExecutable ? makerFillProbability : hybridMakerFillProbability).toNumber() * 0.42 + microstructureAlignment * 0.18 + selectedEdge.modelScore / 100 * 0.4
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
              : !booksHealthy
                ? "Rejected: at least one order book is degraded or awaiting sequence recovery."
              : status === "DETECTED"
              ? takerExecutable
                ? `Executable instant taker edge. Edge Tensor survival ${(selectedEdge.survivalProbability * 100).toFixed(0)}%, adverse-selection ${selectedEdge.adverseSelectionBps.toFixed(2)}bps.`
                : makerExecutable
                  ? `Executable maker-assisted paper trade. Fill ${makerFillProbability.mul(100).toFixed(0)}%, Edge Tensor survival ${(selectedEdge.survivalProbability * 100).toFixed(0)}%, microstructure alignment ${(microstructureAlignment * 100).toFixed(0)}%.`
                  : `Executable hybrid trade (maker buy, taker sell). Fill ${hybridMakerFillProbability.mul(100).toFixed(0)}%, Edge Tensor survival ${(selectedEdge.survivalProbability * 100).toFixed(0)}%.`
              : `Rejected: Edge Tensor quality ${selectedEdge.edgeQuality}, survival ${(selectedEdge.survivalProbability * 100).toFixed(0)}%, risk-adjusted P&L ${usd(selectedEdge.riskAdjustedProfitUsd)} USD.`,
          edgeModel: serializeEdgeTensor(selectedEdge),
          executionPlan: {
            buyLevels: buyBook.asks.slice(0, 5),
            sellLevels: sellBook.bids.slice(0, 5),
            buyLiquidityRole: isMakerSelected ? (makerExecutable ? "maker" : "maker") : "taker",
            sellLiquidityRole: isMakerSelected ? (makerExecutable ? "maker" : "taker") : "taker",
            referenceBuyPrice: (isMakerSelected ? makerBuyPrice : ask.price).toFixed(8),
            referenceSellPrice: (isMakerSelected ? (makerExecutable ? makerSellPrice : bid.price) : bid.price).toFixed(8),
            referenceBuySourcePrice: sourceLevelPrice(buyBook, isMakerSelected ? makerBuyPrice : ask.price, "ask"),
            referenceSellSourcePrice: sourceLevelPrice(sellBook, isMakerSelected ? (makerExecutable ? makerSellPrice : bid.price) : bid.price, "bid")
          }
        });
      });
    });

    return opportunities;
  }

  private detectTriangular(startedAt: number, changedExchange: ExchangeId): Opportunity[] {
    const opportunities: Opportunity[] = [];
    EXCHANGE_IDS.filter((exchange) => exchange === changedExchange).forEach((exchange) => {
      const btcUsdt = this.books.get(bookKey(exchange, "BTC/USDT"));
      const ethUsdt = this.books.get(bookKey(exchange, "ETH/USDT"));
      const ethBtc = this.books.get(bookKey(exchange, "ETH/BTC"));
      if (!btcUsdt || !ethUsdt || !ethBtc) return;
      if ([btcUsdt, ethUsdt, ethBtc].some((book) => Date.now() - book.receivedAt > 2800)) return;
      const btcBid = topBid(btcUsdt);
      const ethAsk = topAsk(ethUsdt);
      const ethBtcBid = topBid(ethBtc);
      if (!btcBid || !ethAsk || !ethBtcBid) return;
      const startingBtc = d("0.1");
      const ethQtyApprox = startingBtc.mul(btcBid.price).div(ethAsk.price);
      const btcBidVwap = simulateVwap(btcUsdt.bids, startingBtc);
      const ethAskVwap = simulateVwap(ethUsdt.asks, ethQtyApprox);
      const ethBtcBidVwap = simulateVwap(ethBtc.bids, ethQtyApprox);
      if (btcBidVwap.filledQty.lessThanOrEqualTo(0) || ethAskVwap.filledQty.lessThanOrEqualTo(0) || ethBtcBidVwap.filledQty.lessThanOrEqualTo(0)) return;

      const usdt = startingBtc.mul(btcBidVwap.price).mul(d(1).minus(EXCHANGE_FEES[exchange].taker));
      const eth = usdt.div(ethAskVwap.price).mul(d(1).minus(EXCHANGE_FEES[exchange].taker));
      const endingBtc = eth.mul(ethBtcBidVwap.price).mul(d(1).minus(EXCHANGE_FEES[exchange].taker));
      const profitBtc = endingBtc.minus(startingBtc);
      const slippageUsd = startingBtc.mul(btcBidVwap.price).mul("0.0003");
      const profitUsd = profitBtc.mul(btcBidVwap.price).minus(slippageUsd);
      const netSpreadPct = profitUsd.div(startingBtc.mul(btcBidVwap.price));
      if (netSpreadPct.lessThan("-0.001")) return;

      const route = `${label(exchange)} BTC/USDT -> ETH/USDT -> ETH/BTC`;
      const status = profitUsd.greaterThan(startingBtc.mul(btcBidVwap.price).mul(CROSS_EXCHANGE_THRESHOLD_PCT))
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
        expectedValueUsd: usd(profitUsd),
        executionNetProfitUsd: usd(profitUsd),
        rebalanceAdjustedProfitUsd: usd(profitUsd),
        grossProfitUsd: usd(profitUsd),
        totalFeesUsd: usd(startingBtc.mul(btcBidVwap.price).mul(EXCHANGE_FEES[exchange].taker).mul(3)),
        slippageUsd: usd(slippageUsd),
        networkCostUsd: "0.00",
        quoteConversionCostUsd: "0.00",
        rebalanceCostUsd: "0.00",
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

  private detectStatistical(startedAt: number, changedExchange: ExchangeId): Opportunity[] {
    const btcBooks = this.booksForSymbol("BTC/USDT", 1800);
    const now = Date.now();
    interface RawSignal {
      leftBook: NormalizedOrderBook;
      rightBook: NormalizedOrderBook;
      zScore: number;
      mean: number;
      spread: number;
      stdDev: number;
    }
    const rawSignals: RawSignal[] = [];

    // First pass: collect all z-scores for FDR
    for (let left = 0; left < btcBooks.length; left += 1) {
      for (let right = left + 1; right < btcBooks.length; right += 1) {
        const leftBook = btcBooks[left];
        const rightBook = btcBooks[right];
        if (leftBook.exchange !== changedExchange && rightBook.exchange !== changedExchange) continue;
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
        rawSignals.push({ leftBook, rightBook, zScore, mean, spread, stdDev });
      }
    }

    // FDR correction using Benjamini-Hochberg
    const pValues = rawSignals.map((signal) => 2 * (1 - normalCdf(Math.abs(signal.zScore))));
    const rejections = benjaminiHochberg(pValues, 0.25);
    const opportunities: Opportunity[] = [];

    for (let index = 0; index < rawSignals.length; index++) {
      if (!rejections[index]) continue;
      const { leftBook, rightBook, zScore, mean, spread } = rawSignals[index];
      const values = this.spreadWindows.get([leftBook.exchange, rightBook.exchange].sort().join(":"))?.values(now) ?? [];
      const reversion = estimateOuMle(values);
      const expectedMoveUsd = d(Math.abs(spread - mean)).mul("0.54").mul(d(reversion.quality).plus("0.25"));
      const size = d("0.06");
      const leftMid = midPrice(leftBook);
      const rightMid = midPrice(rightBook);
      if (!leftMid || !rightMid) continue;
      const referenceMid = leftMid.plus(rightMid).div(2);
      const longExchange: ExchangeId = zScore > 0 ? rightBook.exchange : leftBook.exchange;
      const shortExchange: ExchangeId = zScore > 0 ? leftBook.exchange : rightBook.exchange;
      const longBook = longExchange === leftBook.exchange ? leftBook : rightBook;
      const shortBook = shortExchange === leftBook.exchange ? leftBook : rightBook;
      const route = `STAT ARB SIGNAL ${label(longExchange)} long / ${label(shortExchange)} short`;
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
        tensor.expectedValueUsd.greaterThan("0.05") &&
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
        expectedValueUsd: usd(tensor.expectedValueUsd),
        executionNetProfitUsd: usd(conservativeProfit),
        rebalanceAdjustedProfitUsd: usd(conservativeProfit),
        grossProfitUsd: usd(expectedMoveUsd.mul(size)),
        totalFeesUsd: usd(referenceMid.mul(size).mul(roundTripFeeRate)),
        slippageUsd: usd(referenceMid.mul(size).mul(slippageRate)),
        networkCostUsd: usd(referenceMid.mul(size).mul(latencyRiskRate)),
        quoteConversionCostUsd: "0.00",
        rebalanceCostUsd: "0.00",
        score: this.scoreOpportunity({
          route,
          netSpreadPct,
          quantity: size,
          availableDepth: d("0.4"),
          exchanges: [longExchange, shortExchange],
          expectedValueUsd: tensor.expectedValueUsd,
          confidenceBoost: Math.min(1, Math.abs(zScore) / 4 * 0.52 + reversion.quality * 0.24 + tensor.modelScore / 100 * 0.24)
        }),
        confidence: Math.min(99, Math.round(28 + Math.abs(zScore) * 10 + reversion.quality * 24 + tensor.survivalProbability * 28)),
        highImpact: false,
        impactRatio: 0.08,
        reason: `Stat arb multi-venue: Z ${zScore.toFixed(2)}, OU half-life ${reversion.halfLifeSamples.toFixed(1)} samples, reversion quality ${(reversion.quality * 100).toFixed(0)}%, round-trip costs ${(totalCostRate.mul(10000)).toFixed(2)}bps.`,
        edgeModel: serializeEdgeTensor(tensor)
      });
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
    expectedValueUsd?: Decimal;
    confidenceBoost?: number;
  }): number {
    const profitability = Decimal.max(0, input.netSpreadPct.div(CROSS_EXCHANGE_THRESHOLD_PCT)).mul(32);
    const expectedValue = Decimal.max(0, input.expectedValueUsd ?? 0).div(Decimal.max("0.25", input.quantity.mul(70000).mul(CROSS_EXCHANGE_THRESHOLD_PCT))).mul(8);
    const liquidity = Decimal.min(1, input.availableDepth.div(Decimal.max(input.quantity, d("0.00000001")))).mul(30);
    const reliability =
      input.exchanges.reduce((sum, exchange) => sum + EXCHANGE_FEES[exchange].reliability, 0) / input.exchanges.length * 20;
    const historical = (this.historicalSuccess.get(input.route) ?? 0.68) * 10;
    const boost = (input.confidenceBoost ?? 0) * 6;
    return Math.round(Math.max(0, Math.min(100, profitability.plus(expectedValue).plus(liquidity).plus(reliability).plus(historical).plus(boost).toNumber())));
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

function sourceLevelPrice(book: NormalizedOrderBook, normalizedPrice: Decimal, side: "bid" | "ask"): string {
  const top = side === "bid" ? book.bids[0] : book.asks[0];
  if (top?.sourcePrice && d(top.price).equals(normalizedPrice)) return top.sourcePrice;
  return book.quoteAsset === "BTC" ? normalizedPrice.toFixed(8) : normalizedPrice.div(book.quoteToUsdRate).toFixed(8);
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

function estimateOuMle(values: number[]): { halfLifeSamples: number; quality: number } {
  if (values.length < 5) return { halfLifeSamples: 999, quality: 0 };
  const n = values.length;
  let sumY = 0, sumX = 0, sumX2 = 0, sumXY = 0;
  for (let i = 1; i < n; i++) {
    const x = values[i - 1];
    const y = values[i];
    sumX += x;
    sumY += y;
    sumX2 += x * x;
    sumXY += x * y;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (Math.abs(denom) < 1e-12) return { halfLifeSamples: 999, quality: 0 };
  const beta = (n * sumXY - sumX * sumY) / denom;
  const kappa = Math.max(0, -Math.log(Math.max(beta, 1e-6)));
  const halfLifeSamples = kappa > 0 ? Math.log(2) / kappa : 999;
  const quality = Math.max(0, Math.min(1, (80 - halfLifeSamples) / 80));
  return { halfLifeSamples, quality };
}

function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1 / (1 + p * absX);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
  return sign * y;
}

function benjaminiHochberg(pValues: number[], fdrLevel: number): boolean[] {
  const n = pValues.length;
  if (n === 0) return [];
  const indexed = pValues.map((p, i) => ({ p, i }));
  indexed.sort((a, b) => a.p - b.p);
  let maxReject = -1;
  for (let k = 0; k < n; k++) {
    if (indexed[k].p <= ((k + 1) / n) * fdrLevel) maxReject = k;
  }
  const rejected = new Array(n).fill(false);
  for (let k = 0; k <= maxReject; k++) rejected[indexed[k].i] = true;
  return rejected;
}
