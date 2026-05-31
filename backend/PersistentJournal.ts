import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GatewayMessage, SandboxLedgerEntry } from "../src/lib/types";
import type { RouteCalibration } from "../src/lib/services/EdgeTensor";

const AET_CALIBRATION_VERSION = 2;

interface CalibrationPayload {
  version: number;
  savedAt: string;
  routes: Record<string, RouteCalibration>;
}

export class PersistentJournal {
  private readonly directory: string;
  private readonly eventsPath: string;
  private readonly calibrationPath: string;
  private readonly maxBytes: number;
  private eventCount = 0;
  private readonly buffer: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(directory = process.env.ARBITRAI_DATA_DIR ?? "data", maxBytes = Number(process.env.ARBITRAI_JOURNAL_MAX_BYTES ?? 8_000_000)) {
    this.directory = directory;
    this.eventsPath = join(directory, "session-events.jsonl");
    this.calibrationPath = join(directory, "aet-calibration.json");
    this.maxBytes = Math.max(256_000, maxBytes);
    mkdirSync(this.directory, { recursive: true });
    this.rotateIfNeeded();
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
    const payload: CalibrationPayload = {
      version: AET_CALIBRATION_VERSION,
      savedAt: new Date().toISOString(),
      routes: calibration
    };
    writeFileSync(this.calibrationPath, JSON.stringify(payload, null, 2), "utf8");
  }

  loadCalibration(): Record<string, RouteCalibration> {
    if (!existsSync(this.calibrationPath)) return {};
    try {
      const value = JSON.parse(readFileSync(this.calibrationPath, "utf8")) as unknown;
      if (!isRecord(value) || value.version !== AET_CALIBRATION_VERSION || !isRecord(value.routes)) return {};
      return value.routes as Record<string, RouteCalibration>;
    } catch {
      return {};
    }
  }

  loadSandboxLedger(): SandboxLedgerEntry[] {
    const entries = new Map<string, SandboxLedgerEntry>();
    [this.eventsPath, `${this.eventsPath}.1`]
      .filter(existsSync)
      .flatMap((path) => readTail(path).split(/\r?\n/))
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

  summary(): { persistedEvents: number; calibrationRoutes: number; maxBytes: number } {
    return {
      persistedEvents: this.eventCount + this.buffer.length,
      calibrationRoutes: Object.keys(this.loadCalibration()).length,
      maxBytes: this.maxBytes
    };
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.buffer.length) return;
    appendFileSync(this.eventsPath, this.buffer.join(""), "utf8");
    this.eventCount += this.buffer.length;
    this.buffer.length = 0;
    this.rotateIfNeeded();
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.eventsPath) || statSync(this.eventsPath).size <= this.maxBytes) return;
    const previousPath = `${this.eventsPath}.1`;
    if (existsSync(previousPath)) unlinkSync(previousPath);
    renameSync(this.eventsPath, previousPath);
    this.eventCount = 0;
  }
}

function shouldPersist(message: GatewayMessage): boolean {
  return message.type === "TRADE" || message.type === "LEARNING" || message.type === "EXECUTION_RUNTIME" || message.type === "EXECUTION_STATE";
}

function countLines(path: string): number {
  if (!existsSync(path)) return 0;
  return readTail(path).split(/\r?\n/).filter(Boolean).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readTail(path: string, maxBytes = 2_000_000): string {
  const size = statSync(path).size;
  const length = Math.min(size, maxBytes);
  if (!length) return "";
  const buffer = Buffer.alloc(length);
  const handle = openSync(path, "r");
  try {
    readSync(handle, buffer, 0, length, Math.max(0, size - length));
    return buffer.toString("utf8");
  } finally {
    closeSync(handle);
  }
}
