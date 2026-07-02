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
    // Feed the ML's rolling per-venue history BEFORE detection, so the temporal
    // features (momentum, imbalance delta, realized vol) include this round.
    this.mlEdgeTensor.observeBook(book);
    this.books.set(bookKey(book.exchange, book.symbol), book);
    const opportunities = [
      ...(book.symbol === "BTC/USDT" ? this.detectCrossExchange(startedAt, book.exchange) : []),
      ...this.detectTriangular(startedAt, book.exchange),
      ...(book.symbol === "BTC/USDT" ? this.detectStatistical(startedAt, book.exchange) : []),
      ...(book.symbol === "BTC/USDT" ? this.detectLatencyArb(startedAt, book.exchange) : [])
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
      // opportunity.netSpreadPct is formatted in percent units (pct() multiplies
      // by 100). Inference (detectCrossExchange) extracts features from the raw
      // decimal spread, so divide by 100 here to train on the SAME scale -- without
      // this the model learns a netEdgeBps threshold ~100x what it sees live and
      // mis-scores every real signal.
      d(opportunity.netSpreadPct).div(100)
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
        // Avellaneda-Stoikov optimal maker quote: instead of a fixed aggressiveness,
        // derive how far inside the spread to post from the optimal half-spread
        // delta = 0.5[gamma*sigma^2*(T-t) + (2/gamma)ln(1+gamma/kappa)] -- wider in
        // higher volatility, tighter in deeper books -- skewed by order-flow
        // imbalance (adverse pressure => quote more passively). Avellaneda & Stoikov
        // (2008); OFI enhancement (Cont-Kukanov-Stoikov 2014).
        const buyQuoteSpreadBps = buyTopBid ? ask.price.minus(buyTopBid.price).div(ask.price).mul(10000).toNumber() : 8;
        const sellQuoteSpreadBps = sellTopAsk ? sellTopAsk.price.minus(bid.price).div(bid.price).mul(10000).toNumber() : 8;
        const asVolBps = (buyQuoteSpreadBps + sellQuoteSpreadBps) / 2;
        const asImbalance = buyAskDepth5.plus(sellBidDepth5).greaterThan(0)
          ? sellBidDepth5.minus(buyAskDepth5).div(buyAskDepth5.plus(sellBidDepth5)).toNumber()
          : 0;
        const makerFraction = avellanedaStoikovMakerFraction(asVolBps, depth5Total.toNumber(), asImbalance);
        const makerBuyPrice = buyTopBid
          ? ask.price.minus(ask.price.minus(buyTopBid.price).mul(makerFraction))
          : ask.price;
        const makerSellPrice = sellTopAsk
          ? bid.price.plus(sellTopAsk.price.minus(bid.price).mul(makerFraction))
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

        // Dual-model ensemble: the AET microstructure survival is cross-checked
        // by the gradient-boosted ML model. Both must agree before a paper trade
        // executes — the ML can veto a signal AET admitted, but never resurrect
        // one AET rejected. It stays inert (mlSurvival === null) until the model
        // has been fitted on enough realized outcomes, so the tuned hot path and
        // the deterministic demo behave exactly as before until then. Only the
        // would-be-executable signals pay the inference cost.
        const mlSurvival = this.mlEdgeTensor.isTrained() && status === "DETECTED"
          ? this.mlEdgeTensor.predict(
              this.mlEdgeTensor.extractFeatures(buyBook, sellBook, desiredQty, executionStyle, selectedNetSpreadPct)
            ).survivalProbability
          : null;
        const ensembleSurvival = mlSurvival === null
          ? selectedEdge.survivalProbability
          : selectedEdge.survivalProbability * 0.7 + mlSurvival * 0.3;
        const mlVeto = mlSurvival !== null && mlSurvival < 0.3;
        const finalStatus = mlVeto ? "REJECTED" : status;

        // The ensemble doesn't just gate execution — it reprices the Expected
        // Value the queue is ordered by. When the ML agrees with AET the edge is
        // scaled up (higher priority); when it disagrees it is discounted. The
        // factor is bounded (AET survival > 0.5 on executable signals, ML in
        // [0,1] => ~[0.7, 1.3]) and is exactly 1 until the model is trained.
        const ensembleEvFactor = mlSurvival === null || selectedEdge.survivalProbability <= 0
          ? 1
          : ensembleSurvival / selectedEdge.survivalProbability;
        const ensembleExpectedValueUsd = selectedEdge.expectedValueUsd.mul(ensembleEvFactor);

        // Fractional Kelly position sizing. Kelly (1956) maximizes long-run
        // log-growth by betting in proportion to edge and inversely to risk:
        // f* = p - (1-p)/b, with p the ensemble survival, b the gain/loss odds
        // (edge vs adverse-selection + volatility downside). We scale the
        // already-conservative depth-based base by f* clamped to [0.3, 1], so a
        // strong, high-survival edge trades near full base size while a marginal
        // one is trimmed — never exceeding the cap (Kelly 1956; Thorp 2006).
        const kellyEdgeBps = Math.max(0, selectedNetSpreadPct.mul(10000).toNumber());
        const kellyLossBps = Math.max(2, selectedEdge.adverseSelectionBps + selectedEdge.volatilityBps);
        const kellyScale = kellySizeFraction(ensembleSurvival, kellyEdgeBps, kellyLossBps);
        const k = d(kellyScale);
        const finalQty = desiredQty.mul(k);
        const sizedProfit = selectedProfit.mul(k);
        const sizedEv = ensembleExpectedValueUsd.mul(k);

        let confidence = takerExecutable
          ? Math.round(52 + selectedEdge.survivalProbability * 40)
          : makerExecutable
            ? Math.round(42 + makerFillProbability.toNumber() * 18 + selectedEdge.survivalProbability * 32)
            : Math.round(18 + selectedEdge.survivalProbability * 28);
        if (mlSurvival !== null) confidence = Math.round(confidence * 0.7 + ensembleSurvival * 30);

        let reason =
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
            : `Rejected: Edge Tensor quality ${selectedEdge.edgeQuality}, survival ${(selectedEdge.survivalProbability * 100).toFixed(0)}%, risk-adjusted P&L ${usd(selectedEdge.riskAdjustedProfitUsd)} USD.`;
        if (mlVeto) {
          reason = `Rejected by ML ensemble veto: gradient-boosted survival ${(mlSurvival * 100).toFixed(0)}% disagrees with Edge Tensor ${(selectedEdge.survivalProbability * 100).toFixed(0)}%.`;
        } else if (mlSurvival !== null) {
          reason += ` ML ensemble survival ${(mlSurvival * 100).toFixed(0)}%.`;
        }

        opportunities.push({
          id: cryptoId("cross"),
          type: "CROSS_EXCHANGE",
          executionStyle,
          status: finalStatus,
          route,
          createdAt: Date.now(),
          expiresAt: Date.now() + 500,
          detectionLatencyMs: performanceNow() - startedAt,
          buyExchange: buyBook.exchange,
          sellExchange: sellBook.exchange,
          grossSpreadPct: pct(selectedNet.grossSpreadPct),
          netSpreadPct: pct(selectedNetSpreadPct),
          tradeSizeBtc: finalQty.toFixed(8),
          expectedProfitUsd: usd(sizedProfit),
          expectedValueUsd: usd(sizedEv),
          executionNetProfitUsd: usd(selectedNet.netProfitUsd.mul(k)),
          rebalanceAdjustedProfitUsd: usd(selectedNet.rebalanceAdjustedProfitUsd.mul(k)),
          grossProfitUsd: usd(selectedNet.grossProfitUsd.mul(k)),
          totalFeesUsd: usd(selectedNet.buyFeeUsd.plus(selectedNet.sellFeeUsd).mul(k)),
          slippageUsd: usd(selectedNet.slippageUsd.mul(k)),
          networkCostUsd: usd(selectedNet.networkCostUsd.plus(isMakerSelected ? makerRiskCost : 0).mul(k)),
          quoteConversionCostUsd: usd(selectedNet.quoteConversionCostUsd.mul(k)),
          rebalanceCostUsd: usd(selectedNet.rebalanceCostUsd.mul(k)),
          score: this.scoreOpportunity({
            route,
            netSpreadPct: selectedNetSpreadPct,
            quantity: finalQty,
            availableDepth: Decimal.min(ask.size, bid.size),
            exchanges: [buyBook.exchange, sellBook.exchange],
            expectedValueUsd: sizedEv,
            confidenceBoost: isMakerSelected
              ? (makerExecutable ? makerFillProbability : hybridMakerFillProbability).toNumber() * 0.42 + microstructureAlignment * 0.18 + selectedEdge.modelScore / 100 * 0.4
              : microstructureAlignment * 0.24 + selectedEdge.modelScore / 100 * 0.48
          }),
          confidence,
          highImpact: rawImpactRatio.greaterThan("0.2"),
          impactRatio: rawImpactRatio.toNumber(),
          reason,
          edgeModel: {
            ...serializeEdgeTensor(selectedEdge),
            mlSurvivalProbability: mlSurvival === null ? undefined : mlSurvival.toFixed(3)
          },
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
      const adfStat = dickeyFullerStat(values);
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
      // Only trade spreads that reject the unit root (stationary / cointegrated).
      const stationary = adfStat < -2.0;
      const status =
        conservativeProfit.greaterThan("0.10") &&
        tensor.expectedValueUsd.greaterThan("0.05") &&
        tensor.survivalProbability > 0.56 &&
        reversion.quality > 0.14 &&
        Math.abs(zScore) > 1.6 &&
        stationary
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
        reason: `Stat arb multi-venue: Z ${zScore.toFixed(2)}, ADF t ${adfStat.toFixed(2)} (${stationary ? "stationary" : "unit-root"}), OU half-life ${reversion.halfLifeSamples.toFixed(1)} samples, reversion quality ${(reversion.quality * 100).toFixed(0)}%, round-trip costs ${(totalCostRate.mul(10000)).toFixed(2)}bps.`,
        edgeModel: serializeEdgeTensor(tensor)
      });
    }

    return opportunities.sort((a, b) => b.score - a.score).slice(0, 3);
  }

  // Latency / stale-quote arbitrage targets exactly the async space that
  // cross-exchange rejects: a venue whose cheap *buy* quote has gone stale while
  // another venue prints a fresh, richer bid. We lift the resting stale ask and
  // sell into the fresh bid, but charge an explicit staleness-risk premium that
  // grows with the age of the stale quote (the older it is, the likelier the
  // resting order is already gone) and demand a higher bar than cross-exchange.
  // It is dormant whenever quotes are synchronized, so the deterministic demo
  // (which stamps every venue with the same timestamp) never triggers it.
  private detectLatencyArb(startedAt: number, changedExchange: ExchangeId): Opportunity[] {
    const now = Date.now();
    const btcBooks = this.booksForSymbol("BTC/USDT", 8000);
    const opportunities: Opportunity[] = [];

    btcBooks.forEach((buyBook) => {
      btcBooks.forEach((sellBook) => {
        if (buyBook.exchange === sellBook.exchange) return;
        if (buyBook.exchange !== changedExchange && sellBook.exchange !== changedExchange) return;
        const ask = topAsk(buyBook);
        const bid = topBid(sellBook);
        if (!ask || !bid || bid.price.lessThanOrEqualTo(ask.price)) return;
        const stalenessMs = sellBook.receivedAt - buyBook.receivedAt;
        const buyAgeMs = now - buyBook.receivedAt;
        if (stalenessMs <= 1800 || buyAgeMs > 6000) return;
        if (buyBook.integrity.status === "DEGRADED" || sellBook.integrity.status === "DEGRADED") return;

        const depthBtc = Decimal.min(
          buyBook.asks.slice(0, 5).reduce((sum, level) => sum.plus(d(level.size)), ZERO),
          sellBook.bids.slice(0, 5).reduce((sum, level) => sum.plus(d(level.size)), ZERO)
        );
        const desiredQty = Decimal.min(d("0.05"), depthBtc.mul("0.15"));
        if (desiredQty.lessThanOrEqualTo("0.0001")) return;

        const net = calculateNetProfit({
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
        const notional = ask.price.mul(desiredQty);
        const stalenessRiskRate = d(Math.min(0.006, buyAgeMs / 6000 * 0.006));
        const stalenessRiskUsd = notional.mul(stalenessRiskRate);
        const netProfitUsd = net.rebalanceAdjustedProfitUsd.minus(stalenessRiskUsd);
        const netSpreadPct = notional.greaterThan(0) ? netProfitUsd.div(notional) : ZERO;
        const route = `${label(buyBook.exchange)} (stale ${Math.round(buyAgeMs)}ms) -> ${label(sellBook.exchange)}`;
        // Higher bar than cross-exchange: a stale edge must clear 1.5x threshold.
        const threshold = notional.mul(CROSS_EXCHANGE_THRESHOLD_PCT).mul("1.5");
        const status = netProfitUsd.greaterThan(threshold) ? "DETECTED" : "REJECTED";

        opportunities.push({
          id: cryptoId("lat"),
          type: "LATENCY_ARB",
          executionStyle: "INSTANT_TAKER",
          status,
          route,
          createdAt: now,
          expiresAt: now + 400,
          detectionLatencyMs: performanceNow() - startedAt,
          buyExchange: buyBook.exchange,
          sellExchange: sellBook.exchange,
          grossSpreadPct: pct(bid.price.minus(ask.price).div(ask.price)),
          netSpreadPct: pct(netSpreadPct),
          tradeSizeBtc: desiredQty.toFixed(8),
          expectedProfitUsd: usd(netProfitUsd),
          expectedValueUsd: usd(netProfitUsd),
          executionNetProfitUsd: usd(net.netProfitUsd),
          rebalanceAdjustedProfitUsd: usd(net.rebalanceAdjustedProfitUsd),
          grossProfitUsd: usd(net.grossProfitUsd),
          totalFeesUsd: usd(net.buyFeeUsd.plus(net.sellFeeUsd)),
          slippageUsd: usd(net.slippageUsd),
          networkCostUsd: usd(stalenessRiskUsd),
          quoteConversionCostUsd: usd(net.quoteConversionCostUsd),
          rebalanceCostUsd: usd(net.rebalanceCostUsd),
          score: this.scoreOpportunity({
            route,
            netSpreadPct,
            quantity: desiredQty,
            availableDepth: Decimal.min(ask.size, bid.size),
            exchanges: [buyBook.exchange, sellBook.exchange]
          }),
          confidence: status === "DETECTED" ? Math.round(Math.max(20, 58 - buyAgeMs / 200)) : 22,
          highImpact: false,
          impactRatio: 0.1,
          reason: status === "DETECTED"
            ? `Latency edge: lifting a ${Math.round(buyAgeMs)}ms-stale ask on ${label(buyBook.exchange)} into a fresh ${label(sellBook.exchange)} bid, net of a ${stalenessRiskRate.mul(10000).toFixed(1)}bps staleness-risk premium.`
            : `Rejected: ${Math.round(buyAgeMs)}ms-stale quote edge did not clear the 1.5x staleness-risk bar.`,
          executionPlan: {
            buyLevels: buyBook.asks.slice(0, 5),
            sellLevels: sellBook.bids.slice(0, 5),
            buyLiquidityRole: "taker",
            sellLiquidityRole: "taker",
            referenceBuyPrice: ask.price.toFixed(8),
            referenceSellPrice: bid.price.toFixed(8),
            referenceBuySourcePrice: sourceLevelPrice(buyBook, ask.price, "ask"),
            referenceSellSourcePrice: sourceLevelPrice(sellBook, bid.price, "bid")
          }
        });
      });
    });

    return opportunities.sort((a, b) => b.score - a.score).slice(0, 4);
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

// Fractional Kelly: f* = p - (1-p)/b, with p the win probability and b the
// gain/loss odds. Clamped to [0.3, 1] so a green-lit signal always trades a
// meaningful but bounded fraction of the conservative base size.
export function kellySizeFraction(survival: number, edgeBps: number, lossBps: number): number {
  const b = Math.max(0.1, edgeBps / Math.max(lossBps, 1));
  const fStar = survival - (1 - survival) / b;
  return Math.max(0.3, Math.min(1, fStar));
}

// Avellaneda-Stoikov (2008) optimal market-making spread, used to set how far
// inside the quoted spread our maker leg posts (as a fraction of bid..ask).
// delta = 0.5[ gamma*sigma^2*(T-t) + (2/gamma)*ln(1 + gamma/kappa) ]
//   sigma  = quoted-spread volatility proxy (bps, normalized)
//   kappa  = order-arrival/liquidity intensity proxy (visible depth, BTC)
//   gamma  = inventory risk aversion
// plus an order-flow-imbalance skew (Cont-Kukanov-Stoikov 2014): adverse pressure
// (imbalance < 0) widens our quote (more passive). Bounded to [0.2, 0.6] so a
// degenerate input can never post outside the spread or cross the book.
export function avellanedaStoikovMakerFraction(volBps: number, depthBtc: number, imbalance: number, gamma = 0.8): number {
  const sigma = Math.max(0.2, volBps) / 100;
  const kappa = Math.max(0.3, Math.min(8, depthBtc));
  const horizon = 1;
  const halfSpread = 0.5 * (gamma * sigma * sigma * horizon + (2 / gamma) * Math.log(1 + gamma / kappa));
  const skew = Math.max(-0.1, Math.min(0.1, -imbalance * 0.1));
  return Math.max(0.2, Math.min(0.6, 0.18 + halfSpread + skew));
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

// Augmented Dickey-Fuller style stationarity test on the spread series.
// Regresses the first difference on the lagged level with a drift term
//   Δy_t = α + ρ·y_{t-1} + ε
// and returns the t-statistic of ρ. A unit root (ρ = 0) means the spread is a
// non-mean-reverting random walk and must NOT be traded; a sufficiently
// negative t-statistic rejects the unit root, confirming a stationary,
// cointegrated relationship between the two venues (Dickey-Fuller 1979;
// Engle & Granger 1987). For the same asset across venues the spread is
// stationary by arbitrage, so this mainly vetoes decoupled/depegged regimes.
export function dickeyFullerStat(values: number[]): number {
  const m = values.length - 1;
  if (m < 6) return 0;
  const x: number[] = []; // lagged level y_{t-1}
  const delta: number[] = []; // Δy_t
  for (let i = 1; i < values.length; i += 1) {
    x.push(values[i - 1]);
    delta.push(values[i] - values[i - 1]);
  }
  const meanX = x.reduce((s, v) => s + v, 0) / m;
  const meanD = delta.reduce((s, v) => s + v, 0) / m;
  let sxx = 0;
  let sxd = 0;
  for (let i = 0; i < m; i += 1) {
    const dx = x[i] - meanX;
    sxx += dx * dx;
    sxd += dx * (delta[i] - meanD);
  }
  if (sxx < 1e-12) return 0;
  const rho = sxd / sxx;
  const alpha = meanD - rho * meanX;
  let sse = 0;
  for (let i = 0; i < m; i += 1) {
    const residual = delta[i] - alpha - rho * x[i];
    sse += residual * residual;
  }
  const dof = m - 2;
  if (dof <= 0) return 0;
  const sigma2 = sse / dof;
  const seRho = Math.sqrt(sigma2 / sxx);
  if (!Number.isFinite(seRho) || seRho < 1e-12) return 0;
  return rho / seRho;
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
