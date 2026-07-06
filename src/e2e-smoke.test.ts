/**
 * End-to-end smoke tests simulating real MCP tool calls.
 * Exercises the server the way Claude would actually use it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createServer } from "./server/mcp-server.js";
import { resetIdCounters } from "./model/id.js";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Helpers to call tools the way the MCP SDK does
function makeServer() {
  return createServer();
}

let tmpFiles: string[] = [];
function tmpFile(name: string): string {
  const p = join(tmpdir(), `e2e-smoke-${Date.now()}-${name}`);
  tmpFiles.push(p);
  return p;
}

beforeEach(async () => {
  resetIdCounters();
  for (const f of tmpFiles) {
    if (existsSync(f)) unlinkSync(f);
  }
  tmpFiles = [];
});

// ── Scenario 1: Complete architecture diagram session ─────────

describe("E2E Smoke — full architecture diagram", async () => {
  it("creates, populates, queries, saves, and reopens a diagram", async () => {
    const { intent } = makeServer();

    // drawio_session: new
    const newResult = intent.executeSession('new "Payment System"');
    expect(newResult).toContain("Payment System");

    // drawio: add shapes
    const addOps = await intent.executeOps([
      "add api Gateway theme:orange",
      "add svc PaymentService theme:blue near:Gateway dir:below",
      "add svc FraudDetection theme:red near:PaymentService dir:right",
      "add db TransactionDB theme:green near:PaymentService dir:below",
      "add queue EventStream theme:orange near:TransactionDB dir:right",
      "add cloud StripeAPI theme:gray near:FraudDetection dir:right",
    ]);
    expect(addOps.every((r) => r.success)).toBe(true);
    expect(addOps).toHaveLength(6);

    // Verify response format: +type label @(x,y wxh) theme
    expect(addOps[0].message).toContain("+api");
    expect(addOps[0].message).toContain("Gateway");
    expect(addOps[1].message).toContain("+svc");

    // drawio: connect
    const connectOps = await intent.executeOps([
      'connect Gateway -> PaymentService label:"POST /pay"',
      "connect PaymentService -> FraudDetection label:validate",
      "connect PaymentService -> TransactionDB label:INSERT",
      "connect PaymentService -> EventStream label:emit",
      "connect FraudDetection -> StripeAPI label:verify",
    ]);
    expect(connectOps.every((r) => r.success)).toBe(true);
    expect(connectOps[0].message).toContain("~");

    // drawio: group + style
    const orgOps = await intent.executeOps([
      "group PaymentService FraudDetection as:CoreServices",
      "style @type:db fill:#e8f5e9",
    ]);
    expect(orgOps.every((r) => r.success)).toBe(true);

    // drawio_query: status
    const status = intent.executeQuery("status");
    expect(status).toContain("Payment System");
    expect(status).toContain("6 shapes");
    expect(status).toContain("5 edges");
    expect(status).toContain("CoreServices");

    // drawio_query: list
    const list = intent.executeQuery("list");
    expect(list).toContain("Gateway");
    expect(list).toContain("PaymentService");
    expect(list).toContain("FraudDetection");
    expect(list).toContain("TransactionDB");
    expect(list).toContain("EventStream");
    expect(list).toContain("StripeAPI");

    // drawio_query: stats
    const stats = intent.executeQuery("stats");
    expect(stats).toContain("6");
    expect(stats).toContain("5");

    // drawio_query: describe a shape
    const desc = intent.executeQuery("describe PaymentService");
    expect(desc).toContain("PaymentService");
    expect(desc).toContain("svc");

    // drawio_query: connections
    const conns = intent.executeQuery("connections PaymentService");
    expect(conns).toContain("FraudDetection");
    expect(conns).toContain("TransactionDB");

    // State digest format check
    const digest = intent.model.getDigest();
    expect(digest).toMatch(/\[\d+s \d+e \d+g \d+x\d+ p:\d+\/\d+\]/);
    expect(digest).toMatch(/\[6s 5e 1g \d+x\d+ p:1\/1\]/);

    // drawio_session: save
    const filePath = tmpFile("payment-system.drawio");
    const saveResult = intent.executeSession(`save as:${filePath}`);
    expect(saveResult).toContain("ok: saved");
    expect(existsSync(filePath)).toBe(true);

    // Verify saved XML
    const xml = readFileSync(filePath, "utf-8");
    expect(xml).toContain("<mxfile");
    // Title is diagram metadata; page name goes into XML
    expect(xml).toContain("POST /pay");
    expect(xml).toContain("Gateway");

    // drawio_session: open in new server
    const { intent: intent2 } = makeServer();
    const openResult = intent2.executeSession(`open ${filePath}`);
    expect(openResult).toContain("ok: opened");
    expect(openResult).toContain("6 shapes");
    expect(openResult).toContain("5 edges");

    // Verify all shapes survived round-trip
    const list2 = intent2.executeQuery("list");
    expect(list2).toContain("Gateway");
    expect(list2).toContain("PaymentService");
    expect(list2).toContain("TransactionDB");
    expect(list2).toContain("StripeAPI");
  });
});

// ── Scenario 2: Error recovery and suggestions ────────────────

describe("E2E Smoke — error recovery", async () => {
  it("provides repair suggestions for typos", async () => {
    const { intent } = makeServer();
    intent.executeSession('new "Error Test"');
    await intent.executeOps(["add svc AuthenticationService theme:blue"]);

    // Typo in reference
    const ops = await intent.executeOps(["connect AuthenticatonService -> Nowhere label:fail"]);
    expect(ops[0].success).toBe(false);
    expect(ops[0].message).toContain("AuthenticationService"); // suggests correct name
    // Should have a suggestion field
    if (ops[0].suggestion) {
      expect(ops[0].suggestion).toContain("AuthenticationService");
    }
  });

  it("handles partial batch failures without losing successes", async () => {
    const { intent } = makeServer();
    intent.executeSession('new "Batch Test"');

    const ops = await intent.executeOps([
      "add svc ServiceA theme:blue",
      "connect ServiceA -> NonExistent label:broken",
      "add db DatabaseB theme:green",
      "connect ServiceA -> DatabaseB label:queries",
    ]);

    expect(ops[0].success).toBe(true);
    expect(ops[1].success).toBe(false);
    expect(ops[2].success).toBe(true);
    expect(ops[3].success).toBe(true);

    const stats = intent.executeQuery("stats");
    expect(stats).toContain("shapes: 2");
    expect(stats).toContain("edges: 1");
  });

  it("rejects ambiguous references with disambiguation hint", async () => {
    const { intent } = makeServer();
    intent.executeSession('new "Ambiguity Test"');
    await intent.executeOps([
      "add svc Cache theme:blue",
      "add db Cache theme:green",
    ]);

    const ops = await intent.executeOps(["style Cache fill:red"]);
    expect(ops[0].success).toBe(false);
    expect(ops[0].message).toContain("matches");
  });
});

// ── Scenario 3: Undo/redo workflow ────────────────────────────

describe("E2E Smoke — undo/redo", async () => {
  it("checkpoints and restores state", async () => {
    const { intent } = makeServer();
    intent.executeSession('new "Undo Test"');

    await intent.executeOps([
      "add svc Alpha theme:blue",
      "add svc Beta theme:blue",
    ]);
    intent.executeSession("checkpoint v1");

    await intent.executeOps([
      "add svc Gamma theme:red",
      "add svc Delta theme:red",
    ]);

    expect(intent.model.getDigest()).toMatch(/\[4s 0e 0g \d+x\d+ p:1\/1\]/);

    // Undo to checkpoint
    const undoResult = intent.executeSession("undo to:v1");
    expect(undoResult).toContain("undone");
    expect(intent.model.getDigest()).toMatch(/\[2s 0e 0g \d+x\d+ p:1\/1\]/);

    // Redo
    intent.executeSession("redo");
    intent.executeSession("redo");
    expect(intent.model.getDigest()).toMatch(/\[4s 0e 0g \d+x\d+ p:1\/1\]/);
  });
});

// ── Scenario 4: Multi-page diagrams ──────────────────────────

describe("E2E Smoke — multi-page", async () => {
  it("creates shapes across pages and round-trips", async () => {
    const { intent } = makeServer();
    intent.executeSession('new "Multi-Page App"');

    // Page 1: Architecture
    await intent.executeOps([
      "add svc Frontend theme:blue",
      "add svc Backend theme:green near:Frontend dir:below",
      "connect Frontend -> Backend label:REST",
    ]);

    // Add page 2
    await intent.executeOps(["page add Infrastructure"]);
    await intent.executeOps([
      "add cloud AWS theme:orange",
      "add db RDS theme:green near:AWS dir:below",
      "connect AWS -> RDS label:hosts",
    ]);

    expect(intent.model.getDigest()).toMatch(/p:2\/2/);

    // Save and reopen
    const filePath = tmpFile("multi-page.drawio");
    intent.executeSession(`save as:${filePath}`);

    const { intent: intent2 } = makeServer();
    const openResult = intent2.executeSession(`open ${filePath}`);
    expect(openResult).toContain("2 pages");
  });
});

// ── Scenario 5: Custom types ─────────────────────────────────

describe("E2E Smoke — custom types", async () => {
  it("defines and uses custom type", async () => {
    const { intent } = makeServer();
    intent.executeSession('new "Custom Type Test"');

    // Define custom type
    await intent.executeOps(["define kafka-stream base:queue theme:orange badge:Kafka"]);

    // Use it
    await intent.executeOps([
      "add svc Producer theme:blue",
      "add kafka-stream OrderEvents near:Producer dir:right",
    ]);

    const list = intent.executeQuery("list");
    expect(list).toContain("OrderEvents");
  });
});

// ── Scenario 6: Selectors ────────────────────────────────────

describe("E2E Smoke — selectors", async () => {
  it("bulk styles by type selector", async () => {
    const { intent } = makeServer();
    intent.executeSession('new "Selector Test"');

    await intent.executeOps([
      "add db UserDB theme:green",
      "add db OrderDB theme:green",
      "add db CacheDB theme:green",
      "add svc ApiServer theme:blue",
    ]);

    // Style all databases
    const ops = await intent.executeOps(["style @type:db fill:#e0f2f1"]);
    expect(ops[0].success).toBe(true);
    expect(ops[0].message).toContain("3"); // 3 shapes styled
  });

  it("selects by group", async () => {
    const { intent } = makeServer();
    intent.executeSession('new "Group Select Test"');

    await intent.executeOps([
      "add svc Auth theme:blue",
      "add svc Users theme:blue",
      "add svc Billing theme:green",
      "group Auth Users as:CoreAPI",
    ]);

    const ops = await intent.executeOps(["style @group:CoreAPI fill:#bbdefb"]);
    expect(ops[0].success).toBe(true);
    expect(ops[0].message).toContain("group CoreAPI");
  });

  it("@recent selects last created shape", async () => {
    const { intent } = makeServer();
    intent.executeSession('new "Recent Test"');

    await intent.executeOps([
      "add svc First theme:blue",
      "add svc Second theme:green",
      "add svc Third theme:red",
    ]);

    const ops = await intent.executeOps(["label @recent NewThirdName"]);
    expect(ops[0].success).toBe(true);

    const list = intent.executeQuery("list");
    expect(list).toContain("NewThirdName");
    // "NewThirdName" contains "Third" as substring, so check exact line
    expect(list).not.toMatch(/^Third\(/m);
  });
});

// ── Scenario 7: Edge styles and arrows ───────────────────────

describe("E2E Smoke — edge variations", async () => {
  it("creates edges with different styles and arrows", async () => {
    const { intent } = makeServer();
    intent.executeSession('new "Edge Styles"');

    await intent.executeOps([
      "add svc A theme:blue",
      "add svc B theme:blue near:A dir:right",
      "add svc C theme:blue near:A dir:below",
    ]);

    const ops = await intent.executeOps([
      "connect A -> B label:directed style:dashed",
      "connect A <-> C label:bidirectional style:thick",
      "connect B -- C label:undirected",
    ]);

    expect(ops.every((r) => r.success)).toBe(true);
    expect(intent.model.getDigest()).toMatch(/\[3s 3e 0g \d+x\d+ p:1\/1\]/);
  });
});

// ── Scenario 8: Label and relabel ────────────────────────────

describe("E2E Smoke — label operations", async () => {
  it("renames shapes and edges", async () => {
    const { intent } = makeServer();
    intent.executeSession('new "Relabel Test"');

    await intent.executeOps([
      "add svc OldName theme:blue",
      "add svc Target theme:green near:OldName dir:right",
      "connect OldName -> Target label:old-connection",
    ]);

    // Relabel shape
    const ops = await intent.executeOps(['label OldName "NewName"']);
    expect(ops[0].success).toBe(true);

    // Can now reference by new name
    const desc = intent.executeQuery("describe NewName");
    expect(desc).toContain("NewName");

    // Old name no longer resolves
    const failOps = await intent.executeOps(["style OldName fill:red"]);
    expect(failOps[0].success).toBe(false);
  });
});

// ── Scenario 9: Move and resize ──────────────────────────────

describe("E2E Smoke — move and resize", async () => {
  it("moves and resizes shapes", async () => {
    const { intent } = makeServer();
    intent.executeSession('new "Move Test"');

    await intent.executeOps(["add svc Widget theme:blue"]);

    const moveOps = await intent.executeOps([
      "move Widget at:500,300",
      "resize Widget to:200x100",
    ]);
    expect(moveOps.every((r) => r.success)).toBe(true);
  });
});

// ── Scenario 10: Stress test — many shapes ───────────────────

describe("E2E Smoke — stress", async () => {
  it("handles 50 shapes and 49 connections", async () => {
    const { intent } = makeServer();
    intent.executeSession('new "Stress Test"');

    // Add 50 shapes
    const addOps: string[] = [];
    for (let i = 0; i < 50; i++) {
      addOps.push(`add svc Node${i} theme:blue`);
    }
    const addResults = await intent.executeOps(addOps);
    expect(addResults.every((r) => r.success)).toBe(true);

    // Connect them in a chain
    const connectOps: string[] = [];
    for (let i = 0; i < 49; i++) {
      connectOps.push(`connect Node${i} -> Node${i + 1} label:link${i}`);
    }
    const connectResults = await intent.executeOps(connectOps);
    expect(connectResults.every((r) => r.success)).toBe(true);

    expect(intent.model.getDigest()).toMatch(/\[50s 49e 0g \d+x\d+ p:1\/1\]/);

    // Save and verify XML size is reasonable
    const filePath = tmpFile("stress.drawio");
    intent.executeSession(`save as:${filePath}`);
    const xml = readFileSync(filePath, "utf-8");
    expect(xml.length).toBeGreaterThan(1000);
    expect(xml).toContain("Node0");
    expect(xml).toContain("Node49");
  });
});
