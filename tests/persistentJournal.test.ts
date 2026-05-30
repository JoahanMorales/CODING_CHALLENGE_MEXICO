import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PersistentJournal } from "../backend/PersistentJournal";
import type { GatewayMessage, SandboxLedgerEntry } from "../src/lib/types";

describe("PersistentJournal", () => {
  it("recovers AET calibration and sandbox realized ledger entries", () => {
    const directory = `.test-journal-${Date.now()}`;
    const entry: SandboxLedgerEntry = {
      id: "sandbox_1",
      route: "Binance -> OKX",
      recordedAt: Date.now(),
      quantityBtc: "0.00033000",
      buyQuoteUsd: "24.29000000",
      sellQuoteUsd: "24.31000000",
      grossPnlUsd: "0.02000000",
      feesUsd: "0.01000000",
      netPnlUsd: "0.01000000",
      feeSource: "VENUE"
    };

    try {
      const journal = new PersistentJournal(directory);
      journal.saveCalibration({ "Binance -> OKX": { bias: 0.04, observations: 12 } });
      Array.from({ length: 100 }, () => executionMessage(entry)).forEach((message) => journal.record(message));

      const restored = new PersistentJournal(directory);
      expect(restored.loadCalibration()["Binance -> OKX"].bias).toBe(0.04);
      expect(restored.loadSandboxLedger()).toEqual([entry]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

function executionMessage(entry: SandboxLedgerEntry): GatewayMessage {
  return {
    type: "EXECUTION_RUNTIME",
    runtime: {
      mode: "PAPER",
      sandboxEnabled: false,
      orderMode: "DRY_RUN",
      maxNotionalUsd: "25.00",
      venues: [],
      killSwitchActive: false,
      killSwitchReason: "",
      ledger: {
        executions: 1,
        wins: 1,
        losses: 0,
        grossPnlUsd: entry.grossPnlUsd,
        feesUsd: entry.feesUsd,
        realizedPnlUsd: entry.netPnlUsd,
        lastEntry: entry
      }
    }
  };
}
