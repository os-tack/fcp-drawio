import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { IntentLayer } from "./server/intent-layer.js";
import { resetIdCounters } from "./model/id.js";
import { serializeDiagram } from "./serialization/serialize.js";
import { deserializeDiagram } from "./serialization/deserialize.js";
import { writeFileSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let intent: IntentLayer;
let tmpFiles: string[] = [];

beforeEach(async () => {
  resetIdCounters();
  intent = new IntentLayer();
});

afterEach(async () => {
  for (const f of tmpFiles) {
    if (existsSync(f)) unlinkSync(f);
  }
  tmpFiles = [];
});

function tmpFile(name: string): string {
  const p = join(tmpdir(), `drawio-test-${Date.now()}-${name}`);
  tmpFiles.push(p);
  return p;
}

// ── Full session: create → edit → save → reopen ────────────

describe("Integration — full session round-trip", async () => {
  it("creates a diagram, edits it, saves, and reopens", async () => {
    // Create
    const newResult = intent.executeSession('new "Order System"');
    expect(newResult).toContain("Order System");

    // Add shapes
    const ops = await intent.executeOps([
      "add api Gateway theme:orange",
      "add svc OrderService theme:blue near:Gateway dir:below",
      "add svc PaymentService theme:blue near:OrderService dir:right",
      "add db OrderDB theme:green near:OrderService dir:below",
      "connect Gateway -> OrderService label:POST",
      "connect OrderService -> PaymentService label:charge",
      "connect OrderService -> OrderDB label:INSERT",
      "group OrderService PaymentService as:Services",
    ]);

    // All ops succeed
    expect(ops.every((r) => r.success)).toBe(true);
    expect(ops[0].message).toContain("+api");
    expect(ops[4].message).toContain("~");
    expect(ops[7].message).toContain("!group");

    // Query status
    const status = intent.executeQuery("status");
    expect(status).toContain("Order System");
    expect(status).toContain("4 shapes");
    expect(status).toContain("3 edges");

    // Save to file
    const filePath = tmpFile("order-system.drawio");
    const saveResult = intent.executeSession(`save as:${filePath}`);
    expect(saveResult).toContain("ok: saved");

    // Reopen in a fresh IntentLayer
    const intent2 = new IntentLayer();
    const openResult = intent2.executeSession(`open ${filePath}`);
    expect(openResult).toContain("ok: opened");
    expect(openResult).toContain("4 shapes");
    expect(openResult).toContain("3 edges");

    // Verify shapes survived round-trip
    const list = intent2.executeQuery("list");
    expect(list).toContain("Gateway");
    expect(list).toContain("OrderService");
    expect(list).toContain("PaymentService");
    expect(list).toContain("OrderDB");

    // Continue editing the reopened file
    const moreOps = await intent2.executeOps([
      "add svc NotificationService theme:purple near:PaymentService dir:right",
      "connect PaymentService -> NotificationService label:notify",
    ]);
    expect(moreOps.every((r) => r.success)).toBe(true);

    const status2 = intent2.executeQuery("stats");
    expect(status2).toContain("5");  // 5 shapes now
  });
});

// ── Batch operations ───────────────────────────────────────

describe("Integration — batch operations", async () => {
  it("processes all ops in array, partial failure doesn't lose successes", async () => {
    intent.executeSession('new "Test"');

    const ops = await intent.executeOps([
      "add svc ValidService theme:blue",
      "connect ValidService -> NonExistent label:fail",  // will fail
      "add db ValidDB theme:green",
    ]);

    expect(ops[0].success).toBe(true);
    expect(ops[1].success).toBe(false);
    expect(ops[2].success).toBe(true);

    // Both successful shapes exist
    const list = intent.executeQuery("list");
    expect(list).toContain("ValidService");
    expect(list).toContain("ValidDB");
  });
});

// ── Multi-page ─────────────────────────────────────────────

describe("Integration — multi-page diagrams", async () => {
  it("creates shapes on multiple pages and round-trips", async () => {
    intent.executeSession('new "Multi-Page"');

    // Page 1
    await intent.executeOps([
      "add svc Frontend theme:blue",
      "add svc Backend theme:green",
      "connect Frontend -> Backend label:API",
    ]);

    // Page 2
    await intent.executeOps(["page add Deployment"]);
    await intent.executeOps([
      "add cloud AWS theme:orange",
      "add db RDS theme:green near:AWS dir:below",
    ]);

    // Save and reopen
    const filePath = tmpFile("multi-page.drawio");
    intent.executeSession(`save as:${filePath}`);

    const intent2 = new IntentLayer();
    const openResult = intent2.executeSession(`open ${filePath}`);
    expect(openResult).toContain("2 pages");

    // Verify page 1
    const list1 = intent2.executeQuery("list");
    expect(list1).toContain("Frontend");
    expect(list1).toContain("Backend");
  });
});

// ── Undo/redo across checkpoints ───────────────────────────

describe("Integration — undo/redo with checkpoints", async () => {
  it("undoes to checkpoint and redoes correctly", async () => {
    intent.executeSession('new "Undo Test"');

    await intent.executeOps([
      "add svc A theme:blue",
      "add svc B theme:blue",
    ]);

    intent.executeSession("checkpoint v1");

    await intent.executeOps([
      "add svc C theme:red",
      "add svc D theme:red",
    ]);

    // 4 shapes
    let stats = intent.executeQuery("stats");
    expect(stats).toContain("4");

    // Undo to v1
    const undoResult = intent.executeSession("undo to:v1");
    expect(undoResult).toContain("undone");

    stats = intent.executeQuery("stats");
    expect(stats).toContain("shapes: 2");

    // Redo
    intent.executeSession("redo");
    intent.executeSession("redo");
    stats = intent.executeQuery("stats");
    expect(stats).toContain("shapes: 4");
  });
});

// ── XML round-trip with styled shapes ──────────────────────

describe("Integration — XML round-trip fidelity", async () => {
  it("preserves theme colors through serialize/deserialize", async () => {
    intent.executeSession('new "Style Test"');
    await intent.executeOps([
      "add svc BlueService theme:blue",
      "add db GreenDB theme:green",
      "add api OrangeAPI theme:orange",
      "connect BlueService -> GreenDB label:queries style:dashed",
    ]);

    const xml = serializeDiagram(intent.model.diagram);
    const restored = deserializeDiagram(xml);

    // Check shape count
    const page = restored.pages[0];
    expect(page.shapes.size).toBe(3);
    expect(page.edges.size).toBe(1);

    // Check a shape's colors survived
    const shapes = [...page.shapes.values()];
    const blueSvc = shapes.find((s) => s.label === "BlueService");
    expect(blueSvc).toBeDefined();
    expect(blueSvc!.style.fillColor).toBe("#dae8fc");
    expect(blueSvc!.style.strokeColor).toBe("#6c8ebf");

    const greenDB = shapes.find((s) => s.label === "GreenDB");
    expect(greenDB).toBeDefined();
    expect(greenDB!.type).toBe("db");
  });

  it("preserves edge labels and styles", async () => {
    intent.executeSession('new "Edge Test"');
    await intent.executeOps([
      "add svc A theme:blue",
      "add svc B theme:blue near:A dir:right",
      "connect A -> B label:calls style:dashed",
    ]);

    const xml = serializeDiagram(intent.model.diagram);
    const restored = deserializeDiagram(xml);
    const edges = [...restored.pages[0].edges.values()];
    expect(edges).toHaveLength(1);
    expect(edges[0].label).toBe("calls");
    expect(edges[0].style.dashed).toBe(true);
  });
});

// ── Custom types end-to-end ────────────────────────────────

describe("Integration — custom types", async () => {
  it("defines and uses a custom type with badge", async () => {
    intent.executeSession('new "Custom Types"');

    await intent.executeOps([
      "define payment-svc base:svc theme:purple badge:PCI",
      "add svc Placeholder theme:blue",
      "add payment-svc OrderPayment near:Placeholder dir:below",
    ]);

    const list = intent.executeQuery("list");
    expect(list).toContain("OrderPayment");
  });
});

// ── Error handling integration ─────────────────────────────

describe("Integration — error handling", async () => {
  it("handles typo in reference with suggestion", async () => {
    intent.executeSession('new "Error Test"');
    await intent.executeOps(["add svc AuthService theme:blue"]);

    const ops = await intent.executeOps(["style AthService fill:red"]);
    expect(ops[0].success).toBe(false);
    expect(ops[0].message).toContain("AuthService");  // suggestion
  });

  it("handles ambiguous reference", async () => {
    intent.executeSession('new "Ambiguous Test"');
    await intent.executeOps([
      "add svc Service theme:blue",
      "add db Service theme:green",
    ]);

    const ops = await intent.executeOps(["style Service fill:red"]);
    expect(ops[0].success).toBe(false);
    expect(ops[0].message).toContain("matches");
  });

  it("handles empty selector gracefully", async () => {
    intent.executeSession('new "Empty Selector"');
    await intent.executeOps(["add svc OnlyService theme:blue"]);

    const ops = await intent.executeOps(["style @type:db fill:green"]);
    expect(ops[0].success).toBe(false);
    expect(ops[0].message).toContain("0 shapes");
  });
});

// ── Spec example session (Appendix A) ─────────────────────

describe("Integration — spec example session", async () => {
  it("reproduces the order processing example from the spec", async () => {
    // Phase 1: Create
    intent.executeSession('new "Order Processing System"');

    // Phase 2: Build shapes
    const addResults = await intent.executeOps([
      "add api Gateway theme:orange",
      "add svc OrderService theme:blue near:Gateway dir:below",
      "add svc PaymentService theme:blue near:OrderService dir:right",
      "add svc NotificationService theme:blue near:OrderService dir:left",
      "add db OrderDB theme:green near:OrderService dir:below",
      "add db PaymentDB theme:green near:PaymentService dir:below",
      'add queue EventBus theme:orange near:OrderService dir:below-right',
      "add cloud EmailProvider theme:gray near:NotificationService dir:below",
    ]);
    expect(addResults.every((r) => r.success)).toBe(true);
    expect(addResults).toHaveLength(8);

    // Phase 3: Connect
    const connectResults = await intent.executeOps([
      'connect Gateway -> OrderService label:"POST /orders"',
      "connect OrderService -> PaymentService label:processPayment",
      "connect OrderService -> EventBus label:orderCreated",
      "connect EventBus -> NotificationService label:notify",
      "connect NotificationService -> EmailProvider label:sendEmail",
      "connect OrderService -> OrderDB label:INSERT",
      "connect PaymentService -> PaymentDB label:INSERT",
    ]);
    expect(connectResults.every((r) => r.success)).toBe(true);

    // Phase 4: Organize
    const orgResults = await intent.executeOps([
      "group OrderService PaymentService NotificationService as:Services",
      "group OrderDB PaymentDB as:Databases",
      "checkpoint initial-layout",
      'label Gateway "API Gateway v2"',
    ]);
    expect(orgResults.every((r) => r.success)).toBe(true);

    // Phase 5: Query
    const status = intent.executeQuery("status");
    expect(status).toContain("Order Processing System");
    expect(status).toContain("8 shapes");
    expect(status).toContain("7 edges");
    expect(status).toContain("Services");
    expect(status).toContain("Databases");

    // Phase 6: Save
    const filePath = tmpFile("order-processing.drawio");
    const saveResult = intent.executeSession(`save as:${filePath}`);
    expect(saveResult).toContain("ok: saved");

    // Verify file is valid XML
    const xml = readFileSync(filePath, "utf-8");
    expect(xml).toContain("<mxfile");
    expect(xml).toContain("API Gateway v2");
    expect(xml).toContain("POST /orders");
  });
});

// ── State digest ────────────────────────────────────────────

describe("Integration — state digest", async () => {
  it("digest updates after mutations", async () => {
    intent.executeSession('new "Digest Test"');

    // After adding shapes, digest should reflect counts
    await intent.executeOps([
      "add svc A theme:blue",
      "add svc B theme:blue",
      "connect A -> B label:test",
    ]);

    const digest = intent.model.getDigest();
    expect(digest).toMatch(/\[2s 1e 0g \d+x\d+ p:1\/1\]/);
  });
});
