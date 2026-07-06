import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./mcp-server.js";

/**
 * These tests exercise the *registered* MCP tool handlers exactly as a real
 * client would: build the server the way src/index.ts does (createServer(),
 * which wraps DrawioAdapter with fcp-core's createFcpServer()), connect an
 * MCP Client over an in-memory transport, and call drawio / drawio_session /
 * drawio_query by tool name.
 *
 * Every other test in this suite calls IntentLayer/DiagramModel/DrawioAdapter
 * internals directly, which all route through DiagramModel's own event log
 * and pass regardless of whether the fcp-core session wiring is correct.
 * This file is the only one that would have caught fcp-core's SessionDispatcher
 * (driving `drawio_session`) operating on a completely separate, always-empty
 * EventLog from the one DrawioAdapter.dispatchOp populated.
 */

async function connectedClient() {
  const { server } = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.map((c) => c.text ?? "").join("\n");
}

describe("MCP tool handlers — production session wiring", () => {
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("drawio_session undo/redo round-trips a mutation made via the drawio tool", async () => {
    client = await connectedClient();

    await client.callTool({ name: "drawio_session", arguments: { action: 'new "Undo Seam Test"' } });

    const addResult = await client.callTool({
      name: "drawio",
      arguments: { ops: ["add svc AuthService"] },
    });
    expect(text(addResult)).toContain("AuthService");

    let listed = await client.callTool({ name: "drawio_query", arguments: { q: "list" } });
    expect(text(listed)).toContain("AuthService");

    const undoResult = await client.callTool({ name: "drawio_session", arguments: { action: "undo" } });
    expect(text(undoResult)).toContain("undone 1 event");

    listed = await client.callTool({ name: "drawio_query", arguments: { q: "list" } });
    expect(text(listed)).not.toContain("AuthService");

    const redoResult = await client.callTool({ name: "drawio_session", arguments: { action: "redo" } });
    expect(text(redoResult)).toContain("redone 1 event");

    listed = await client.callTool({ name: "drawio_query", arguments: { q: "list" } });
    expect(text(listed)).toContain("AuthService");
  });

  it("drawio_session checkpoint/undo to:/redo round-trips across multiple ops", async () => {
    client = await connectedClient();

    await client.callTool({ name: "drawio_session", arguments: { action: 'new "Checkpoint Test"' } });
    await client.callTool({ name: "drawio", arguments: { ops: ["add svc AuthService"] } });

    const checkpointResult = await client.callTool({
      name: "drawio_session",
      arguments: { action: "checkpoint v1" },
    });
    expect(text(checkpointResult)).toContain('checkpoint "v1" created');

    await client.callTool({
      name: "drawio",
      arguments: { ops: ["add db UserDB", "connect AuthService -> UserDB"] },
    });

    let listed = await client.callTool({ name: "drawio_query", arguments: { q: "list" } });
    expect(text(listed)).toContain("UserDB");

    const undoToResult = await client.callTool({
      name: "drawio_session",
      arguments: { action: "undo to:v1" },
    });
    expect(text(undoToResult)).toContain('checkpoint "v1"');

    listed = await client.callTool({ name: "drawio_query", arguments: { q: "list" } });
    expect(text(listed)).toContain("AuthService");
    expect(text(listed)).not.toContain("UserDB");

    const redoResult = await client.callTool({ name: "drawio_session", arguments: { action: "redo" } });
    expect(text(redoResult)).toContain("redone");

    listed = await client.callTool({ name: "drawio_query", arguments: { q: "list" } });
    expect(text(listed)).toContain("UserDB");
  });

  it("drawio_session reports nothing to undo/redo on a fresh diagram", async () => {
    client = await connectedClient();

    await client.callTool({ name: "drawio_session", arguments: { action: 'new "Empty"' } });

    const undoResult = await client.callTool({ name: "drawio_session", arguments: { action: "undo" } });
    expect(text(undoResult)).toContain("nothing to undo");

    const redoResult = await client.callTool({ name: "drawio_session", arguments: { action: "redo" } });
    expect(text(redoResult)).toContain("nothing to redo");
  });

  it("undo resolves the shape's own page even after switching back to a different active page", async () => {
    client = await connectedClient();

    await client.callTool({ name: "drawio_session", arguments: { action: 'new "Cross-Page Undo"' } });
    await client.callTool({ name: "drawio", arguments: { ops: ["add svc PageOneShape"] } });
    await client.callTool({
      name: "drawio",
      arguments: { ops: ['page add "Page 2"', 'page switch "Page 2"', "add svc PageTwoShape"] },
    });
    // Switch back to Page-1 — the active page no longer matches where the
    // most recent event (adding PageTwoShape) actually happened.
    await client.callTool({ name: "drawio", arguments: { ops: ['page switch "Page-1"'] } });

    const undoResult = await client.callTool({ name: "drawio_session", arguments: { action: "undo" } });
    expect(text(undoResult)).toContain("undone 1 event");

    // Page-1's own shape must be untouched by the undo.
    let listed = await client.callTool({ name: "drawio_query", arguments: { q: "list" } });
    expect(text(listed)).toContain("PageOneShape");

    // The undo must have actually removed PageTwoShape from Page 2, not
    // silently no-opped because it looked for the shape on the wrong page.
    await client.callTool({ name: "drawio", arguments: { ops: ['page switch "Page 2"'] } });
    listed = await client.callTool({ name: "drawio_query", arguments: { q: "list" } });
    expect(text(listed)).not.toContain("PageTwoShape");
  });
});
