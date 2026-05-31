import type { BookIntegrity, BookIntegrityStatus, ExchangeId } from "../types";

interface IntegrityInput {
  streamKey?: string;
  sequence?: string | number;
  previousSequence?: string | number;
  snapshot?: boolean;
  checksumValidated?: boolean;
  streamOnly?: boolean;
  reason?: string;
}

interface IntegrityState {
  sequence?: string;
  gapCount: number;
  resyncCount: number;
}

export class BookIntegrityService {
  private readonly states = new Map<string, IntegrityState>();

  assess(exchange: ExchangeId, input: IntegrityInput = {}): BookIntegrity {
    const stateKey = `${exchange}:${input.streamKey ?? "default"}`;
    const current = this.states.get(stateKey) ?? { gapCount: 0, resyncCount: 0 };
    const sequence = input.sequence === undefined ? undefined : String(input.sequence);
    const previousSequence = input.previousSequence === undefined ? undefined : String(input.previousSequence);
    const gapDetected = Boolean(previousSequence && current.sequence && previousSequence !== current.sequence);
    const gapCount = current.gapCount + (gapDetected ? 1 : 0);
    const resyncCount = current.resyncCount + (gapDetected && input.snapshot ? 1 : 0);
    const status = integrityStatus(input, gapDetected);
    const reason = gapDetected
      ? `Sequence gap: expected ${current.sequence}, received ${previousSequence}.`
      : input.reason ?? integrityReason(status);

    this.states.set(stateKey, {
      sequence: sequence ?? current.sequence,
      gapCount,
      resyncCount
    });

    return {
      status,
      sequence,
      previousSequence,
      gapCount,
      resyncCount,
      checksumValidated: Boolean(input.checksumValidated),
      reason
    };
  }
}

function integrityStatus(input: IntegrityInput, gapDetected: boolean): BookIntegrityStatus {
  if (gapDetected || input.checksumValidated === false) return "DEGRADED";
  if (input.checksumValidated) return "VERIFIED";
  if (input.sequence !== undefined) return "SEQUENCED";
  if (input.snapshot) return "SNAPSHOT";
  if (input.streamOnly) return "STREAMING";
  return "DEGRADED";
}

function integrityReason(status: BookIntegrityStatus): string {
  if (status === "VERIFIED") return "Checksum and sequence validated.";
  if (status === "SEQUENCED") return "Sequence continuity monitored.";
  if (status === "SNAPSHOT") return "Atomic top-of-book snapshot.";
  if (status === "STREAMING") return "Streaming reconstruction without venue checksum.";
  return "Feed does not expose enough metadata for strict verification.";
}
