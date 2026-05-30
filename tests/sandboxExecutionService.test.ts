import { describe, expect, it } from "vitest";
import { SandboxExecutionService } from "../src/lib/services/SandboxExecutionService";

describe("SandboxExecutionService", () => {
  it("stays in paper mode when sandbox credentials are missing", () => {
    const service = new SandboxExecutionService({});
    const runtime = service.setMode("SANDBOX");

    expect(runtime.mode).toBe("PAPER");
    expect(runtime.sandboxEnabled).toBe(false);
    expect(runtime.venues.every((venue) => !venue.configured)).toBe(true);
  });
});
