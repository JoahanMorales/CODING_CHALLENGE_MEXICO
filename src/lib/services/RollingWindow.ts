export interface RollingPoint {
  time: number;
  value: number;
}

export class RollingWindow {
  private readonly points: RollingPoint[] = [];

  constructor(private readonly windowMs: number) {}

  push(point: RollingPoint): void {
    this.points.push(point);
    this.prune(point.time);
  }

  values(now = Date.now()): number[] {
    this.prune(now);
    return this.points.map((point) => point.value);
  }

  count(now = Date.now()): number {
    this.prune(now);
    return this.points.length;
  }

  mean(now = Date.now()): number {
    const values = this.values(now);
    if (!values.length) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  stdDev(now = Date.now()): number {
    const values = this.values(now);
    if (values.length < 2) return 0;
    const mean = this.mean(now);
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
    return Math.sqrt(variance);
  }

  private prune(now: number): void {
    while (this.points.length && now - this.points[0].time > this.windowMs) {
      this.points.shift();
    }
  }
}
