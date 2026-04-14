import { describe, it, expect } from "vitest";
import { EventLog } from "@ostk-ai/fcp-core";
import type { ParsedOp } from "@ostk-ai/fcp-core";
import { DrawioAdapter } from "./adapter.js";
import type { DiagramEvent } from "./types/index.js";

describe("DrawioAdapter", () => {
  it("createEmpty() returns a valid DiagramModel", () => {
    const adapter = new DrawioAdapter();
    const model = adapter.createEmpty("Test Diagram", {});
    expect(model).toBeDefined();
    expect(model.diagram.title).toBe("Test Diagram");
    expect(model.diagram.pages.length).toBeGreaterThan(0);
  });

  it("serialize() -> deserialize() round-trips", () => {
    const adapter = new DrawioAdapter();
    const model = adapter.createEmpty("Round Trip", {});
    model.addShape("AuthService", "svc", { theme: "blue" });
    model.addShape("UserDB", "db", { theme: "green" });

    const serialized = adapter.serialize(model);
    expect(typeof serialized).toBe("string");
    expect(serialized.length).toBeGreaterThan(0);

    const restored = adapter.deserialize(serialized);
    expect(restored.diagram.pages.length).toBeGreaterThan(0);
    const page = restored.getActivePage();
    expect(page.shapes.size).toBe(2);
  });

  it("rebuildIndices() does not throw", () => {
    const adapter = new DrawioAdapter();
    const model = adapter.createEmpty("Test", {});
    model.addShape("A", "svc");
    expect(() => adapter.rebuildIndices(model)).not.toThrow();
  });

  it("getDigest() returns a compact summary string", () => {
    const adapter = new DrawioAdapter();
    const model = adapter.createEmpty("Test", {});
    model.addShape("A", "svc");
    const digest = adapter.getDigest(model);
    expect(digest).toContain("1s");
    expect(digest).toContain("0e");
  });

  it("dispatchQuery('list') returns shapes", async () => {
    const adapter = new DrawioAdapter();
    const model = adapter.createEmpty("Test", {});
    model.addShape("AuthService", "svc");
    model.addShape("UserDB", "db");

    const result = await adapter.dispatchQuery("list", adapter.intentLayer.model);
    expect(typeof result).toBe("string");
    expect(result as string).toContain("AuthService");
    expect(result as string).toContain("UserDB");
  });

  it("dispatchQuery('stats') returns stats", async () => {
    const adapter = new DrawioAdapter();
    const model = adapter.createEmpty("Test", {});
    model.addShape("A", "svc");
    const result = await adapter.dispatchQuery("stats", adapter.intentLayer.model);
    expect(typeof result).toBe("string");
    expect(result as string).toContain("shapes: 1");
  });

  it("dispatchOp() executes via IntentLayer using op.raw", async () => {
    const adapter = new DrawioAdapter();
    const model = adapter.createEmpty("Test", {});
    const log = new EventLog<DiagramEvent>();

    const op: ParsedOp = {
      verb: "add",
      positionals: ["svc", "TestService"],
      params: { theme: "blue" },
      selectors: [],
      raw: "add svc TestService theme:blue",
    };

    const result = await adapter.dispatchOp(op, model, log);
    expect(result.success).toBe(true);
    expect(result.message).toContain("TestService");

    const page = adapter.intentLayer.model.getActivePage();
    expect(page.shapes.size).toBe(1);
  });

  it("dispatchQuery() returns unknown for removed snapshot query", async () => {
    const adapter = new DrawioAdapter();
    adapter.createEmpty("Test", {});

    // snapshot query was removed — should return unknown command
    const result = await adapter.dispatchQuery("snapshot", adapter.intentLayer.model);
    expect(typeof result).toBe("string");
    expect(result as string).toContain("Unknown query command");
  });

  it("reverseEvent() undoes a shape creation", () => {
    const adapter = new DrawioAdapter();
    const model = adapter.createEmpty("Test", {});
    const shape = model.addShape("ToUndo", "svc");
    const page = model.getActivePage();
    expect(page.shapes.size).toBe(1);

    const event: DiagramEvent = { type: "shape_created", shape };
    adapter.reverseEvent(event, model);
    expect(page.shapes.size).toBe(0);
  });

  it("replayEvent() re-applies a shape creation", () => {
    const adapter = new DrawioAdapter();
    const model = adapter.createEmpty("Test", {});
    const shape = model.addShape("ToReplay", "svc");
    const page = model.getActivePage();

    // Remove it first
    const event: DiagramEvent = { type: "shape_created", shape };
    adapter.reverseEvent(event, model);
    expect(page.shapes.size).toBe(0);

    // Replay it
    adapter.replayEvent(event, model);
    expect(page.shapes.size).toBe(1);
    expect(page.shapes.get(shape.id)?.label).toBe("ToReplay");
  });

  it("EventLog from @ostk-ai/fcp-core works with DiagramEvent", () => {
    const log = new EventLog<DiagramEvent>();
    const adapter = new DrawioAdapter();
    const model = adapter.createEmpty("Test", {});
    const shape = model.addShape("A", "svc");

    const event: DiagramEvent = { type: "shape_created", shape };
    log.append(event);
    expect(log.cursor).toBe(1);

    const undone = log.undo();
    expect(undone.length).toBe(1);
    expect(undone[0].type).toBe("shape_created");
  });
});