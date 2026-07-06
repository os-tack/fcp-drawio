import { describe, it, expect } from "vitest";
import { createServer } from "./mcp-server.js";

describe("MCP Server — createServer", async () => {
  it("creates server and intent layer successfully", async () => {
    const { server, intent } = createServer();
    expect(server).toBeDefined();
    expect(intent).toBeDefined();
  });
});
