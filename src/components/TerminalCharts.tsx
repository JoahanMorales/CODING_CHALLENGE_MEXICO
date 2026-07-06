"use client";

import { useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import type { Trade } from "@/lib/types";
import { useArbitrageStore } from "@/store/useArbitrageStore";

// The terminal's two recharts panels, split into their own module so recharts
// (the route's heaviest dependency) is code-split into a lazy chunk that loads
// after the shell paints instead of inflating First Load JS. Each chart
// subscribes to only its own store slice, so it re-renders on the price/trade
// cadence independently of the Dashboard body.

export function PriceLineChart() {
  const priceSeries = useArbitrageStore((state) => state.priceSeries);
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={priceSeries}>
        <CartesianGrid stroke="#e4edf7" vertical={false} />
        <XAxis dataKey="time" hide />
        <YAxis domain={["dataMin - 25", "dataMax + 25"]} hide />
        <Tooltip contentStyle={{ background: "#ffffff", border: "1px solid #dbeafe", borderRadius: 12, color: "#27272a" }} />
        <Line type="monotone" dataKey="binance" stroke="#0ea5e9" dot={false} isAnimationActive={false} strokeWidth={2} />
        <Line type="monotone" dataKey="kraken" stroke="#10b981" dot={false} isAnimationActive={false} strokeWidth={2} />
        <Line type="monotone" dataKey="coinbase" stroke="#f59e0b" dot={false} isAnimationActive={false} strokeWidth={2} />
        <Line type="monotone" dataKey="okx" stroke="#8b5cf6" dot={false} isAnimationActive={false} strokeWidth={2} />
        <Line type="monotone" dataKey="bybit" stroke="#ec4899" dot={false} isAnimationActive={false} strokeWidth={2} />
        <Line type="monotone" dataKey="bitfinex" stroke="#64748b" dot={false} isAnimationActive={false} strokeWidth={2} />
        <Line type="monotone" dataKey="gate" stroke="#14b8a6" dot={false} isAnimationActive={false} strokeWidth={2} />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function PnlAreaChart() {
  const trades = useArbitrageStore((state) => state.trades);
  const pnlSeries = useMemo(() => makePnlSeries(trades), [trades]);
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={pnlSeries}>
        <defs>
          <linearGradient id="pnlGradient" x1="0" x2="0" y1="0" y2="1">
            <stop offset="5%" stopColor="#10b981" stopOpacity={0.48} />
            <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="#d9f3e8" vertical={false} />
        <XAxis dataKey="index" hide />
        <YAxis hide />
        <Tooltip contentStyle={{ background: "#ffffff", border: "1px solid #bbf7d0", borderRadius: 12, color: "#27272a" }} />
        <Area type="monotone" dataKey="pnl" stroke="#10b981" fill="url(#pnlGradient)" isAnimationActive={false} strokeWidth={2.4} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function makePnlSeries(trades: Trade[]): Array<{ index: number; pnl: number }> {
  return trades
    .slice()
    .reverse()
    .reduce<Array<{ index: number; pnl: number }>>((series, trade, index) => {
      const previous = series.at(-1)?.pnl ?? 0;
      series.push({ index: index + 1, pnl: previous + Number(trade.pnlUsd) });
      return series;
    }, [{ index: 0, pnl: 0 }]);
}
