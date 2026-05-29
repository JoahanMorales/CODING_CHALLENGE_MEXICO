import type { GatewayMessage, Opportunity, RecordedEvent, Trade } from "../types";

export class EventRecorder {
  private readonly events: RecordedEvent[] = [];

  constructor(private readonly retentionMs = 5 * 60 * 1000) {}

  record(message: GatewayMessage): void {
    if (message.type === "BOOK" || message.type === "EXCHANGE_STATUS" || message.type === "METRICS" || message.type === "REPLAY") return;
    const now = Date.now();
    this.events.push({
      id: `evt_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      time: now,
      message
    });
    this.prune(now);
  }

  replay(windowMs = this.retentionMs): { events: RecordedEvent[]; opportunities: Opportunity[]; trades: Trade[] } {
    const cutoff = Date.now() - windowMs;
    const events = this.events.filter((event) => event.time >= cutoff);
    return {
      events,
      opportunities: events
        .map((event) => event.message)
        .filter((message): message is Extract<GatewayMessage, { type: "OPPORTUNITY" }> => message.type === "OPPORTUNITY")
        .map((message) => message.opportunity)
        .slice(-80)
        .reverse(),
      trades: events
        .map((event) => event.message)
        .filter((message): message is Extract<GatewayMessage, { type: "TRADE" }> => message.type === "TRADE")
        .map((message) => message.trade)
        .slice(-80)
        .reverse()
    };
  }

  private prune(now: number): void {
    while (this.events.length && now - this.events[0].time > this.retentionMs) {
      this.events.shift();
    }
  }
}
