import Decimal from "decimal.js";

Decimal.set({
  precision: 28,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -18,
  toExpPos: 28
});

export { Decimal };

export const ZERO = new Decimal(0);
export const ONE = new Decimal(1);

export function d(value: Decimal.Value): Decimal {
  return new Decimal(value);
}

export function clampDecimal(value: Decimal, min: Decimal, max: Decimal): Decimal {
  if (value.lessThan(min)) return min;
  if (value.greaterThan(max)) return max;
  return value;
}

export function pct(value: Decimal): string {
  return value.mul(100).toFixed(4);
}

export function usd(value: Decimal): string {
  return value.toFixed(2);
}
