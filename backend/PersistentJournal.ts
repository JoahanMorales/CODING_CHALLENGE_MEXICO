import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GatewayMessage, SandboxLedgerEntry } from "../src/lib/types";
import type { RouteCalibration } from "../src/lib/services/EdgeTensor";

export class PersistentJournal {
  private readonly directory: string;
  private readonly eventsPath: string;
  private readonly calibrationPath: string;
  private eventCount = 0;
  private readonly buffer: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(directory = process.env.ARBITRAI_DATA_DIR ?? "data") {
    this.directory = directory;
    this.eventsPath = join(directory, "session-events.jsonl");
    this.calibrationPath = join(directory, "aet-calibration.json");
    mkdirSync(this.directory, { recursive: true });
    this.eventCount = countLines(this.eventsPath);
  }

  record(message: GatewayMessage): void {
    if (!shouldPersist(message)) return;
    this.buffer.push(`${JSON.stringify({ recordedAt: Date.now(), message })}\n`);
    if (this.buffer.length >= 100) {
      this.flush();
      return;
    }
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 350);
  }

  saveCalibration(calibration: Record<string, RouteCalibration>): void {
    writeFileSync(this.calibrationPath, JSON.stringify(calibration, null, 2), "utf8");
  }

  loadCalibration(): Record<string, RouteCalibration> {
    if (!existsSync(this.calibrationPath)) return {};
    try {
      const value = JSON.parse(readFileSync(this.calibrationPath, "utf8")) as unknown;
      return isRecord(value) ? value as Record<string, RouteCalibration> : {};
    } catch {
      return {};
    }
  }

  loadSandboxLedger(): SandboxLedgerEntry[] {
    if (!existsSync(this.eventsPath)) return [];
    const entries = new Map<string, SandboxLedgerEntry>();
    readFileSync(this.eventsPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => {
        try {
          const record = JSON.parse(line) as { message?: GatewayMessage };
          if (record.message?.type !== "EXECUTION_RUNTIME") return;
          const entry = record.message.runtime.ledger.lastEntry;
          if (entry) entries.set(entry.id, entry);
        } catch {
          // Preserve recovery from the remaining valid JSONL records.
        }
      });
    return [...entries.values()].sort((a, b) => b.recordedAt - a.recordedAt).slice(0, 100);
  }

  summary(): { persistedEvents: number; calibrationRoutes: number } {
    return {
      persistedEvents: this.eventCount + this.buffer.length,
      calibrationRoutes: Object.keys(this.loadCalibration()).length
    };
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.buffer.length) return;
    appendFileSync(this.eventsPath, this.buffer.join(""), "utf8");
    this.eventCount += this.buffer.length;
    this.buffer.length = 0;
  }
}

function shouldPersist(message: GatewayMessage): boolean {
  return message.type === "TRADE" || message.type === "LEARNING" || message.type === "EXECUTION_RUNTIME";
}

function countLines(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
