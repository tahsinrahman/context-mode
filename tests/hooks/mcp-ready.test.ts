import { afterEach, describe, expect, it } from "vitest";
import { isMCPReady } from "../../hooks/core/mcp-ready.mjs";

describe("isMCPReady assume-ready env", () => {
  afterEach(() => {
    delete process.env.CONTEXT_MODE_ASSUME_MCP_READY;
    delete process.env.CONTEXT_MODE_MCP_SENTINEL_DIR;
  });

  it("returns true when CONTEXT_MODE_ASSUME_MCP_READY=1", () => {
    process.env.CONTEXT_MODE_ASSUME_MCP_READY = "1";
    process.env.CONTEXT_MODE_MCP_SENTINEL_DIR = "/tmp/context-mode-no-sentinels-should-not-exist";
    expect(isMCPReady()).toBe(true);
  });
});
