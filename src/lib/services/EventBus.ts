import type {
  GatewayMessage,
  NormalizedOrderBook,
  Opportunity,
  PerformanceMetrics,
  RiskState,
  Trade,
  WalletBalance
} from "../types";

export interface KernelEvents {
  "market:update": NormalizedOrderBook;
  "opportunity:detected": Opportunity;
  "execution:queued": Opportunity[];
  "execution:completed": Trade;
  "wallet:update": WalletBalance[];
  "risk:update": RiskState;
  "pnl:update": PerformanceMetrics;
  "gateway:message": GatewayMessage;
}

type Handler<T> = (payload: T) => void;

export class EventBus {
  private readonly handlers = new Map<keyof KernelEvents, Set<Handler<KernelEvents[keyof KernelEvents]>>>();

  on<K extends keyof KernelEvents>(event: K, handler: Handler<KernelEvents[K]>): () => void {
    const existing = this.handlers.get(event) ?? new Set<Handler<KernelEvents[keyof KernelEvents]>>();
    existing.add(handler as Handler<KernelEvents[keyof KernelEvents]>);
    this.handlers.set(event, existing);
    return () => existing.delete(handler as Handler<KernelEvents[keyof KernelEvents]>);
  }

  emit<K extends keyof KernelEvents>(event: K, payload: KernelEvents[K]): void {
    const handlers = this.handlers.get(event);
    if (!handlers) return;
    handlers.forEach((handler) => handler(payload));
  }
}
