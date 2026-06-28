import { describe, it, expect } from "vitest";
import { parseRsyncProgress, backupInFlightFor } from "./model-backup";

describe("parseRsyncProgress", () => {
  it("parses the percentage from an --info=progress2 line", () => {
    expect(parseRsyncProgress("  1,234,567  45%   12.3MB/s    0:00:10")).toBe(45);
  });
  it("returns null for non-progress lines", () => {
    expect(parseRsyncProgress("sending incremental file list")).toBe(null);
  });
});

describe("backupInFlightFor", () => {
  it("is false when no job is running", () => {
    expect(backupInFlightFor("openai/gpt-oss-120b")).toBe(false);
  });
});
