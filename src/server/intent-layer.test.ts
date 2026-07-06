import { describe, it, expect, beforeEach } from "vitest";
import { IntentLayer } from "./intent-layer.js";
import { resetIdCounters } from "../model/id.js";

let layer: IntentLayer;

beforeEach(async () => {
  resetIdCounters();
  layer = new IntentLayer();
});

describe("IntentLayer — add", async () => {
  it("adds a shape with type and theme", async () => {
    const results = await layer.executeOps(["add svc AuthService theme:blue"]);
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(results[0].message).toContain("+svc");
    expect(results[0].message).toContain("AuthService");
    expect(results[0].message).toContain("blue");

    // Verify shape in model
    const page = layer.model.getActivePage();
    expect(page.shapes.size).toBe(1);
    const shape = [...page.shapes.values()][0];
    expect(shape.label).toBe("AuthService");
    expect(shape.type).toBe("svc");
  });

  it("uses label: modifier to override display name", async () => {
    const results = await layer.executeOps(['add svc AuthService label:"HTTP Server"']);
    expect(results[0].success).toBe(true);

    const page = layer.model.getActivePage();
    const shape = [...page.shapes.values()][0];
    expect(shape.label).toBe("HTTP Server");
  });

  it("infers type from label when no type given", async () => {
    const results = await layer.executeOps(["add UserDB"]);
    expect(results[0].success).toBe(true);

    const page = layer.model.getActivePage();
    const shape = [...page.shapes.values()][0];
    expect(shape.type).toBe("db");
  });

  it("defaults to svc when type cannot be inferred", async () => {
    const results = await layer.executeOps(["add Gateway"]);
    expect(results[0].success).toBe(true);

    const page = layer.model.getActivePage();
    const shape = [...page.shapes.values()][0];
    // "Gateway" doesn't match any inferred type patterns, defaults to svc
    expect(shape.type).toBe("svc");
  });

  it("handles batch add with count:N", async () => {
    const results = await layer.executeOps(["add svc Worker count:3"]);
    expect(results[0].success).toBe(true);

    const page = layer.model.getActivePage();
    expect(page.shapes.size).toBe(3);

    const labels = [...page.shapes.values()].map((s) => s.label).sort();
    expect(labels).toEqual(["Worker1", "Worker2", "Worker3"]);
  });

  it("adds a shape at a specific position", async () => {
    const results = await layer.executeOps(["add svc Frontend at:100,200"]);
    expect(results[0].success).toBe(true);

    const shape = [...layer.model.getActivePage().shapes.values()][0];
    expect(shape.bounds.x).toBe(100);
    expect(shape.bounds.y).toBe(200);
  });

  it("adds a shape with explicit size", async () => {
    const results = await layer.executeOps(["add box Header size:200x40"]);
    expect(results[0].success).toBe(true);

    const shape = [...layer.model.getActivePage().shapes.values()][0];
    expect(shape.bounds.width).toBe(200);
    expect(shape.bounds.height).toBe(40);
  });
});

describe("IntentLayer — connect", async () => {
  beforeEach(async () => {
    await layer.executeOps([
      "add svc AuthService",
      "add db UserDB",
      "add db TokenCache",
    ]);
  });

  it("connects two shapes with directed arrow", async () => {
    const results = await layer.executeOps(["connect AuthService -> UserDB label:queries"]);
    expect(results[0].success).toBe(true);
    expect(results[0].message).toContain("~AuthService->UserDB");
    expect(results[0].message).toContain('"queries"');

    const page = layer.model.getActivePage();
    expect(page.edges.size).toBe(1);
  });

  it("creates chained connections", async () => {
    const results = await layer.executeOps(["connect AuthService -> UserDB -> TokenCache"]);
    expect(results[0].success).toBe(true);

    const page = layer.model.getActivePage();
    expect(page.edges.size).toBe(2);
  });

  it("handles bidirectional arrows", async () => {
    const results = await layer.executeOps(["connect AuthService <-> UserDB"]);
    expect(results[0].success).toBe(true);

    const page = layer.model.getActivePage();
    const edge = [...page.edges.values()][0];
    expect(edge.sourceArrow).toBe("arrow");
    expect(edge.targetArrow).toBe("arrow");
  });

  it("handles undirected edges", async () => {
    const results = await layer.executeOps(["connect AuthService -- UserDB"]);
    expect(results[0].success).toBe(true);

    const page = layer.model.getActivePage();
    const edge = [...page.edges.values()][0];
    expect(edge.sourceArrow).toBe("none");
    expect(edge.targetArrow).toBe("none");
  });

  it("returns error for unknown reference", async () => {
    const results = await layer.executeOps(["connect AuthService -> NonExistent"]);
    expect(results[0].success).toBe(false);
    expect(results[0].message).toContain("NonExistent");
  });

  it("creates dotted edge distinct from dashed", async () => {
    await layer.executeOps(["connect AuthService -> UserDB style:dotted"]);
    await layer.executeOps(["connect AuthService -> TokenCache style:dashed"]);

    const page = layer.model.getActivePage();
    const edges = [...page.edges.values()];

    const dotted = edges.find(e => e.style.dotted);
    const dashed = edges.find(e => e.style.dashed && !e.style.dotted);

    expect(dotted).toBeDefined();
    expect(dotted!.style.dashed).toBe(true);
    expect(dotted!.style.dotted).toBe(true);

    expect(dashed).toBeDefined();
    expect(dashed!.style.dashed).toBe(true);
    expect(dashed!.style.dotted).toBe(false);
  });

  it("reports dotted in response message", async () => {
    const results = await layer.executeOps(["connect AuthService -> UserDB style:dotted"]);
    expect(results[0].success).toBe(true);
    expect(results[0].message).toContain("dotted");
    expect(results[0].message).not.toContain("dashed");
  });
});

describe("IntentLayer — connect port hints", async () => {
  beforeEach(async () => {
    await layer.executeOps([
      "add svc A at:100,100",
      "add svc B at:400,400",
    ]);
  });

  it("stores exit:bottom entry:top as port coordinates on edge style", async () => {
    const results = await layer.executeOps(["connect A -> B exit:bottom entry:top"]);
    expect(results[0].success).toBe(true);

    const page = layer.model.getActivePage();
    const edge = [...page.edges.values()][0];
    const style = edge.style as Record<string, unknown>;
    expect(style["exitX"]).toBe(0.5);
    expect(style["exitY"]).toBe(1);
    expect(style["entryX"]).toBe(0.5);
    expect(style["entryY"]).toBe(0);
  });

  it("stores exit:left entry:right as port coordinates on edge style", async () => {
    const results = await layer.executeOps(["connect A -> B exit:left entry:right"]);
    expect(results[0].success).toBe(true);

    const page = layer.model.getActivePage();
    const edge = [...page.edges.values()][0];
    const style = edge.style as Record<string, unknown>;
    expect(style["exitX"]).toBe(0);
    expect(style["exitY"]).toBe(0.5);
    expect(style["entryX"]).toBe(1);
    expect(style["entryY"]).toBe(0.5);
  });

  it("edges without port hints have no explicit port coordinates", async () => {
    const results = await layer.executeOps(["connect A -> B"]);
    expect(results[0].success).toBe(true);

    const page = layer.model.getActivePage();
    const edge = [...page.edges.values()][0];
    const style = edge.style as Record<string, unknown>;
    expect(style["exitX"]).toBeUndefined();
    expect(style["exitY"]).toBeUndefined();
    expect(style["entryX"]).toBeUndefined();
    expect(style["entryY"]).toBeUndefined();
  });
});

describe("IntentLayer — style", async () => {
  beforeEach(async () => {
    await layer.executeOps([
      "add db UserDB theme:green",
      "add db TokenCache theme:green",
      "add svc AuthService theme:blue",
    ]);
  });

  it("styles a single shape by label", async () => {
    const results = await layer.executeOps(["style AuthService fill:red"]);
    expect(results[0].success).toBe(true);
    expect(results[0].message).toContain("*styled");
    expect(results[0].message).toContain("1 shape");
  });

  it("styles multiple shapes with selector", async () => {
    const results = await layer.executeOps(["style @type:db fill:#ff0000"]);
    expect(results[0].success).toBe(true);
    expect(results[0].message).toContain("2 shapes");
  });

  it("returns error for unknown ref", async () => {
    const results = await layer.executeOps(["style NonExistent fill:red"]);
    expect(results[0].success).toBe(false);
  });
});

describe("IntentLayer — group", async () => {
  beforeEach(async () => {
    await layer.executeOps([
      "add svc AuthService",
      "add db UserDB",
    ]);
  });

  it("creates a group from multiple shapes", async () => {
    const results = await layer.executeOps(["group AuthService UserDB as:Backend"]);
    expect(results[0].success).toBe(true);
    expect(results[0].message).toContain("!group");
    expect(results[0].message).toContain("Backend");
    expect(results[0].message).toContain("2 shapes");

    const group = layer.model.getGroupByName("Backend");
    expect(group).toBeDefined();
    expect(group!.memberIds.size).toBe(2);
  });

  it("ungroups a group", async () => {
    await layer.executeOps(["group AuthService UserDB as:Backend"]);
    const results = await layer.executeOps(["ungroup Backend"]);
    expect(results[0].success).toBe(true);
    expect(results[0].message).toContain("ungrouped");

    const group = layer.model.getGroupByName("Backend");
    expect(group).toBeUndefined();
  });

  it("applies label: param as display name with underscore-to-space conversion", async () => {
    const results = await layer.executeOps([
      "group AuthService UserDB as:CP label:Control_Plane",
    ]);
    expect(results[0].success).toBe(true);

    const page = layer.model.getActivePage();
    const group = [...page.groups.values()].find((g) => g.name === "Control Plane");
    expect(group).toBeDefined();
    expect(group!.name).toBe("Control Plane");
  });

  it("applies theme: param to group style", async () => {
    const results = await layer.executeOps([
      "group AuthService UserDB as:Backend theme:green",
    ]);
    expect(results[0].success).toBe(true);

    const group = layer.model.getGroupByName("Backend");
    expect(group).toBeDefined();
    expect(group!.style.fillColor).toBe("#d5e8d4");
    expect(group!.style.strokeColor).toBe("#82b366");
  });

  it("applies theme: with fontColor for dark theme on group", async () => {
    const results = await layer.executeOps([
      "group AuthService UserDB as:Backend theme:dark",
    ]);
    expect(results[0].success).toBe(true);

    const group = layer.model.getGroupByName("Backend");
    expect(group).toBeDefined();
    expect(group!.style.fillColor).toBe("#1a1a2e");
    expect(group!.style.strokeColor).toBe("#16213e");
    expect(group!.style.fontColor).toBe("#e0e0e0");
  });
});

describe("IntentLayer — queries", async () => {
  beforeEach(async () => {
    await layer.executeOps([
      "add svc AuthService theme:blue",
      "add db UserDB theme:green",
      "connect AuthService -> UserDB",
    ]);
  });

  it("lists all shapes", async () => {
    const result = layer.executeQuery("list");
    expect(result).toContain("AuthService(svc)");
    expect(result).toContain("UserDB(db)");
  });

  it("lists filtered by type", async () => {
    const result = layer.executeQuery("list @type:db");
    expect(result).toContain("UserDB(db)");
    expect(result).not.toContain("AuthService");
  });

  it("returns stats", async () => {
    const result = layer.executeQuery("stats");
    expect(result).toContain("shapes: 2");
    expect(result).toContain("edges: 1");
  });

  it("returns status", async () => {
    const result = layer.executeQuery("status");
    expect(result).toContain("Untitled");
    expect(result).toContain("AuthService(svc)");
    expect(result).toContain("UserDB(db)");
  });

  it("describes a shape", async () => {
    const result = layer.executeQuery("describe AuthService");
    expect(result).toContain("AuthService (svc)");
    expect(result).toContain("position:");
    expect(result).toContain("size:");
  });

  it("shows connections", async () => {
    const result = layer.executeQuery("connections AuthService");
    expect(result).toContain("out:");
    expect(result).toContain("UserDB");
  });

  it("finds shapes by text", async () => {
    const result = layer.executeQuery("find Auth");
    expect(result).toContain("AuthService");
  });

  it("returns history", async () => {
    const result = layer.executeQuery("history 5");
    // Should contain recent events
    expect(result).toContain("+");
  });
});

describe("IntentLayer — session", async () => {
  it("creates a new diagram", async () => {
    const result = layer.executeSession('new "My Diagram"');
    expect(result).toContain("My Diagram");
    expect(layer.model.diagram.title).toBe("My Diagram");
  });

  it("creates and restores checkpoints", async () => {
    await layer.executeOps(["add svc AuthService"]);
    const cpResult = layer.executeSession("checkpoint v1");
    expect(cpResult).toContain("v1");

    await layer.executeOps(["add db UserDB"]);
    expect(layer.model.getActivePage().shapes.size).toBe(2);

    const undoResult = layer.executeSession("undo to:v1");
    expect(undoResult).toContain("undone");
    expect(layer.model.getActivePage().shapes.size).toBe(1);
  });

  it("handles undo and redo", async () => {
    await layer.executeOps(["add svc AuthService"]);
    expect(layer.model.getActivePage().shapes.size).toBe(1);

    const undoResult = layer.executeSession("undo");
    expect(undoResult).toContain("undone");
    expect(layer.model.getActivePage().shapes.size).toBe(0);

    const redoResult = layer.executeSession("redo");
    expect(redoResult).toContain("redone");
    expect(layer.model.getActivePage().shapes.size).toBe(1);
  });

  it("reports nothing to undo when empty", async () => {
    const result = layer.executeSession("undo");
    expect(result).toContain("nothing to undo");
  });
});

describe("IntentLayer — error handling", async () => {
  it("returns error for parse errors", async () => {
    const results = await layer.executeOps(["bogus command"]);
    expect(results[0].success).toBe(false);
    expect(results[0].message).toContain("unknown verb");
  });

  it("returns error for unknown reference in connect", async () => {
    await layer.executeOps(["add svc A"]);
    const results = await layer.executeOps(["connect A -> B"]);
    expect(results[0].success).toBe(false);
  });

  it("handles empty ops array", async () => {
    const results = await layer.executeOps([]);
    expect(results).toHaveLength(0);
  });

  it("returns error for empty op string", async () => {
    const results = await layer.executeOps([""]);
    expect(results[0].success).toBe(false);
  });
});

describe("IntentLayer — define custom type", async () => {
  it("defines a custom type and uses it", async () => {
    const defineResult = await layer.executeOps([
      "define payment-svc base:svc theme:purple badge:PCI",
    ]);
    expect(defineResult[0].success).toBe(true);
    expect(defineResult[0].message).toContain("payment-svc");

    // Use the custom type
    const addResult = await layer.executeOps(["add payment-svc PaymentGateway"]);
    expect(addResult[0].success).toBe(true);
    expect(addResult[0].message).toContain("PaymentGateway");
    expect(addResult[0].message).toContain("purple");

    // Verify shape has custom type base
    const shape = [...layer.model.getActivePage().shapes.values()][0];
    expect(shape.type).toBe("svc");

    // Verify badge was applied
    expect(shape.metadata.badges).toBeDefined();
    expect(shape.metadata.badges!.length).toBe(1);
    expect(shape.metadata.badges![0].text).toBe("PCI");
  });
});

describe("IntentLayer — define custom theme", async () => {
  it("defines a custom theme", async () => {
    const results = await layer.executeOps([
      "define theme critical fill:#f8cecc stroke:#990000",
    ]);
    expect(results[0].success).toBe(true);
    expect(results[0].message).toContain("critical");
    expect(results[0].message).toContain("#f8cecc");
    expect(layer.model.diagram.customThemes.size).toBe(1);
  });

  it("custom theme is usable in style operations", async () => {
    await layer.executeOps([
      "define theme critical fill:#f8cecc stroke:#990000",
      "add svc Alert theme:critical",
    ]);
    const shape = [...layer.model.getActivePage().shapes.values()][0];
    expect(shape.style.fillColor).toBe("#f8cecc");
    expect(shape.style.strokeColor).toBe("#990000");
  });
});

describe("IntentLayer — remove", async () => {
  it("removes a shape", async () => {
    await layer.executeOps(["add svc AuthService"]);
    const results = await layer.executeOps(["remove AuthService"]);
    expect(results[0].success).toBe(true);
    expect(results[0].message).toContain("-AuthService");
    expect(layer.model.getActivePage().shapes.size).toBe(0);
  });
});

describe("IntentLayer — label and badge", async () => {
  beforeEach(async () => {
    await layer.executeOps(["add svc AuthService"]);
  });

  it("relabels a shape", async () => {
    const results = await layer.executeOps(['label AuthService "Auth Gateway"']);
    expect(results[0].success).toBe(true);
    const shape = [...layer.model.getActivePage().shapes.values()][0];
    expect(shape.label).toBe("Auth Gateway");
  });

  it("relabels an edge via arrow syntax", async () => {
    await layer.executeOps(["add svc Gateway"]);
    await layer.executeOps(['connect AuthService -> Gateway label:queries']);
    const results = await layer.executeOps(['label AuthService -> Gateway "read/write"']);
    expect(results[0].success).toBe(true);
    expect(results[0].message).toContain("read/write");

    const edge = [...layer.model.getActivePage().edges.values()][0];
    expect(edge.label).toBe("read/write");
  });

  it("returns error when relabeling nonexistent edge", async () => {
    await layer.executeOps(["add svc Gateway"]);
    const results = await layer.executeOps(['label AuthService -> Gateway "text"']);
    expect(results[0].success).toBe(false);
    expect(results[0].message).toContain("No edge");
  });

  it("adds a badge to a shape", async () => {
    const results = await layer.executeOps(['badge AuthService "v2"']);
    expect(results[0].success).toBe(true);
    const shape = [...layer.model.getActivePage().shapes.values()][0];
    expect(shape.metadata.badges).toBeDefined();
    expect(shape.metadata.badges![0].text).toBe("v2");
  });
});

describe("IntentLayer — page operations", async () => {
  it("adds and switches pages", async () => {
    const results = await layer.executeOps(["page add Page-2"]);
    expect(results[0].success).toBe(true);
    expect(layer.model.diagram.pages).toHaveLength(2);

    const switchResult = await layer.executeOps(["page switch Page-1"]);
    expect(switchResult[0].success).toBe(true);
    expect(layer.model.getActivePage().name).toBe("Page-1");
  });

  it("lists all pages with shape counts", async () => {
    await layer.executeOps(["add svc A", "add svc B"]);
    await layer.executeOps(["page add Page-2"]);
    await layer.executeOps(["add svc C"]);
    const results = await layer.executeOps(["page list"]);
    expect(results[0].success).toBe(true);
    expect(results[0].message).toContain("Page-1");
    expect(results[0].message).toContain("Page-2");
    expect(results[0].message).toContain("active");
  });
});

describe("IntentLayer — layer operations", async () => {
  it("creates a layer", async () => {
    const results = await layer.executeOps(['layer create Background']);
    expect(results[0].success).toBe(true);
    expect(results[0].message).toContain("Background");
    const page = layer.model.getActivePage();
    expect(page.layers).toHaveLength(2);
  });

  it("switches the active layer", async () => {
    await layer.executeOps(['layer create Background']);
    const results = await layer.executeOps(['layer switch Background']);
    expect(results[0].success).toBe(true);
    expect(results[0].message).toContain("switched to layer Background");
    const page = layer.model.getActivePage();
    const bgLayer = page.layers.find(l => l.name === "Background")!;
    expect(page.defaultLayer).toBe(bgLayer.id);
  });

  it("reports error for switching to unknown layer", async () => {
    const results = await layer.executeOps(['layer switch Nonexistent']);
    expect(results[0].success).toBe(false);
    expect(results[0].message).toContain("Unknown layer");
  });

  it("lists all layers with status markers", async () => {
    await layer.executeOps(['layer create Background']);
    await layer.executeOps(['layer hide Background']);
    const results = await layer.executeOps(['layer list']);
    expect(results[0].success).toBe(true);
    expect(results[0].message).toContain("Default");
    expect(results[0].message).toContain("active");
    expect(results[0].message).toContain("Background");
    expect(results[0].message).toContain("hidden");
  });

  it("new shapes go to the active layer", async () => {
    await layer.executeOps(['layer create Background']);
    await layer.executeOps(['layer switch Background']);
    await layer.executeOps(['add svc TestShape']);
    const page = layer.model.getActivePage();
    const shape = [...page.shapes.values()][0];
    const bgLayer = page.layers.find(l => l.name === "Background")!;
    expect(shape.layer).toBe(bgLayer.id);
  });
});

describe("IntentLayer — move and resize", async () => {
  beforeEach(async () => {
    await layer.executeOps(["add svc AuthService at:100,100"]);
  });

  it("moves a shape to absolute position", async () => {
    const results = await layer.executeOps(["move AuthService to:300,400"]);
    expect(results[0].success).toBe(true);
    const shape = [...layer.model.getActivePage().shapes.values()][0];
    expect(shape.bounds.x).toBe(300);
    expect(shape.bounds.y).toBe(400);
  });

  it("resizes a shape", async () => {
    const results = await layer.executeOps(["resize AuthService to:200x100"]);
    expect(results[0].success).toBe(true);
    const shape = [...layer.model.getActivePage().shapes.values()][0];
    expect(shape.bounds.width).toBe(200);
    expect(shape.bounds.height).toBe(100);
  });
});

describe("IntentLayer — swap", async () => {
  it("swaps positions of two shapes", async () => {
    await layer.executeOps([
      "add svc A at:100,100",
      "add svc B at:300,300",
    ]);

    const results = await layer.executeOps(["swap A B"]);
    expect(results[0].success).toBe(true);

    const page = layer.model.getActivePage();
    const shapes = [...page.shapes.values()];
    const a = shapes.find((s) => s.label === "A")!;
    const b = shapes.find((s) => s.label === "B")!;

    expect(a.bounds.x).toBe(300);
    expect(a.bounds.y).toBe(300);
    expect(b.bounds.x).toBe(100);
    expect(b.bounds.y).toBe(100);
  });
});

describe("IntentLayer — disconnect", async () => {
  it("disconnects two shapes", async () => {
    await layer.executeOps([
      "add svc A",
      "add svc B",
      "connect A -> B",
    ]);

    expect(layer.model.getActivePage().edges.size).toBe(1);

    const results = await layer.executeOps(["disconnect A -> B"]);
    expect(results[0].success).toBe(true);
    expect(layer.model.getActivePage().edges.size).toBe(0);
  });
});

describe("IntentLayer — title and checkpoint ops", async () => {
  it("sets the diagram title", async () => {
    const results = await layer.executeOps(['title "My Architecture"']);
    expect(results[0].success).toBe(true);
    expect(layer.model.diagram.title).toBe("My Architecture");
  });

  it("creates a checkpoint via ops", async () => {
    const results = await layer.executeOps(["checkpoint v1"]);
    expect(results[0].success).toBe(true);
    expect(results[0].message).toContain("v1");
  });
});

describe("IntentLayer — repair suggestions", async () => {
  it("suggests corrected ref for typos", async () => {
    layer.executeSession('new "Test"');
    await layer.executeOps(["add svc AuthService theme:blue"]);
    const results = await layer.executeOps(["style AthService fill:red"]);
    expect(results[0].success).toBe(false);
    expect(results[0].suggestion).toBeDefined();
    expect(results[0].suggestion).toContain("AuthService");
  });

  it("suggests type-qualified ref for ambiguous labels", async () => {
    layer.executeSession('new "Test"');
    await layer.executeOps([
      "add svc Service theme:blue",
      "add db Service theme:green",
    ]);
    const results = await layer.executeOps(["style Service fill:red"]);
    expect(results[0].success).toBe(false);
    expect(results[0].suggestion).toBeDefined();
    expect(results[0].suggestion).toContain(":");
  });

  it("no suggestion when ref is completely unknown", async () => {
    layer.executeSession('new "Test"');
    const results = await layer.executeOps(["style CompletelyRandom fill:red"]);
    expect(results[0].success).toBe(false);
    // May or may not have suggestion depending on whether there are any shapes
  });

  it("suggests corrected ref for typos in connect", async () => {
    layer.executeSession('new "Test"');
    await layer.executeOps([
      "add svc AuthService theme:blue",
      "add db UserDB theme:green",
    ]);
    const results = await layer.executeOps(["connect AthService -> UserDB"]);
    expect(results[0].success).toBe(false);
    expect(results[0].suggestion).toBeDefined();
    expect(results[0].suggestion).toContain("AuthService");
  });

  it("suggests corrected ref for typos in remove", async () => {
    layer.executeSession('new "Test"');
    await layer.executeOps(["add svc AuthService theme:blue"]);
    const results = await layer.executeOps(["remove AthService"]);
    expect(results[0].success).toBe(false);
    expect(results[0].suggestion).toBeDefined();
    expect(results[0].suggestion).toContain("AuthService");
  });
});

describe("IntentLayer — layout", () => {
  it("repositions shapes after layout", async () => {
    await layer.executeOps([
      "add svc A at:0,0",
      "add svc B at:0,0",
      "add svc C at:0,0",
      "connect A -> B",
      "connect B -> C",
    ]);

    // All shapes start at same position
    const page = layer.model.getActivePage();
    const shapesBefore = [...page.shapes.values()];
    expect(shapesBefore.every((s) => s.bounds.x === 0 && s.bounds.y === 0)).toBe(true);

    const results = await layer.executeOps(["layout @all algo:layered dir:TB"]);
    expect(results[0].success).toBe(true);
    expect(results[0].message).toContain("repositioned");
    expect(results[0].message).toContain("3 shapes");

    // Shapes should now have distinct positions
    const shapesAfter = [...page.shapes.values()];
    const positions = new Set(shapesAfter.map((s) => `${s.bounds.x},${s.bounds.y}`));
    expect(positions.size).toBe(3);
  });

  it("supports LR direction", async () => {
    await layer.executeOps([
      "add svc A at:0,0",
      "add svc B at:0,0",
      "connect A -> B",
    ]);

    const results = await layer.executeOps(["layout @all algo:layered dir:LR"]);
    expect(results[0].success).toBe(true);

    const page = layer.model.getActivePage();
    const a = [...page.shapes.values()].find((s) => s.label === "A")!;
    const b = [...page.shapes.values()].find((s) => s.label === "B")!;
    expect(b.bounds.x).toBeGreaterThan(a.bounds.x);
  });

  it("returns error for invalid algorithm", async () => {
    await layer.executeOps(["add svc A"]);
    const results = await layer.executeOps(["layout @all algo:bogus dir:TB"]);
    expect(results[0].success).toBe(false);
    expect(results[0].message).toContain("Unknown algorithm");
  });

  it("returns error for invalid direction", async () => {
    await layer.executeOps(["add svc A"]);
    const results = await layer.executeOps(["layout @all algo:layered dir:XX"]);
    expect(results[0].success).toBe(false);
    expect(results[0].message).toContain("Unknown direction");
  });

  it("undo restores original positions after layout", async () => {
    await layer.executeOps([
      "add svc A at:100,200",
      "add svc B at:300,400",
      "connect A -> B",
    ]);

    const page = layer.model.getActivePage();
    const aBefore = [...page.shapes.values()].find((s) => s.label === "A")!;
    expect(aBefore.bounds.x).toBe(100);
    expect(aBefore.bounds.y).toBe(200);

    await layer.executeOps(["layout @all algo:layered dir:TB"]);

    // Positions changed
    const aAfterLayout = [...page.shapes.values()].find((s) => s.label === "A")!;
    const posChanged = aAfterLayout.bounds.x !== 100 || aAfterLayout.bounds.y !== 200;
    expect(posChanged).toBe(true);

    // Undo all layout events (one per shape repositioned + flow direction change)
    layer.executeSession("undo");
    layer.executeSession("undo");
    layer.executeSession("undo");

    const aAfterUndo = [...page.shapes.values()].find((s) => s.label === "A")!;
    expect(aAfterUndo.bounds.x).toBe(100);
    expect(aAfterUndo.bounds.y).toBe(200);
  });
});

// ── Map query ────────────────────────────────────────────────

describe("IntentLayer — map query", () => {
  it("returns empty map for new diagram", () => {
    const result = layer.executeQuery("map");
    expect(result).toBe("map: empty diagram");
  });

  it("returns spatial summary with shapes", async () => {
    await layer.executeOps([
      "add svc AuthService theme:blue at:100,200",
      "add db UserDB theme:green at:300,400",
    ]);
    const result = layer.executeQuery("map");
    expect(result).toContain("map:");
    expect(result).toContain("flow:TB");
    expect(result).toContain("2s 0e 0g");
    expect(result).toContain("AuthService(svc)");
    expect(result).toContain("UserDB(db)");
    expect(result).toContain("ungrouped");
  });

  it("shows groups with member positions", async () => {
    await layer.executeOps([
      "add svc A theme:blue at:100,100",
      "add svc B theme:blue at:300,100",
      "group A B as:Backend",
    ]);
    const result = layer.executeQuery("map");
    expect(result).toContain("[Backend]");
    expect(result).toContain("A(svc)");
    expect(result).toContain("B(svc)");
    expect(result).not.toContain("ungrouped");
  });

  it("includes edge count and flow direction", async () => {
    await layer.executeOps([
      "add svc A theme:blue at:100,100",
      "add svc B theme:blue at:100,300",
      "connect A -> B",
    ]);
    const result = layer.executeQuery("map");
    expect(result).toContain("2s 1e 0g");
    expect(result).toContain("flow:TB"); // inferred from A above B
  });

  it("uses explicit flowDirection when set", async () => {
    await layer.executeOps([
      "add svc A theme:blue at:100,100",
      "add svc B theme:blue at:300,100",
      "orient LR",
    ]);
    const result = layer.executeQuery("map");
    expect(result).toContain("flow:LR");
  });
});

// ── Orient ───────────────────────────────────────────────────

describe("IntentLayer — orient", () => {
  it("sets flow direction on the page", async () => {
    const results = await layer.executeOps(["orient TB"]);
    expect(results[0].success).toBe(true);
    expect(results[0].message).toBe("@orient TB");
    expect(layer.model.getActivePage().flowDirection).toBe("TB");
  });

  it("accepts all four directions", async () => {
    for (const dir of ["TB", "LR", "BT", "RL"]) {
      const results = await layer.executeOps([`orient ${dir}`]);
      expect(results[0].success).toBe(true);
      expect(layer.model.getActivePage().flowDirection).toBe(dir);
    }
  });

  it("rejects invalid directions", async () => {
    const results = await layer.executeOps(["orient XY"]);
    expect(results[0].success).toBe(false);
    expect(results[0].message).toContain("Unknown direction");
  });

  it("is case-insensitive", async () => {
    const results = await layer.executeOps(["orient lr"]);
    expect(results[0].success).toBe(true);
    expect(layer.model.getActivePage().flowDirection).toBe("LR");
  });
});

// ── Canvas bounds in digest ──────────────────────────────────

describe("IntentLayer — canvas bounds in digest", () => {
  it("includes canvas size in digest when shapes exist", async () => {
    await layer.executeOps([
      "add svc A theme:blue at:100,200",
    ]);
    const digest = layer.model.getDigest();
    expect(digest).toMatch(/\[1s 0e 0g \d+x\d+ p:1\/1\]/);
  });

  it("omits canvas size for empty diagram", () => {
    const digest = layer.model.getDigest();
    expect(digest).toBe("[0s 0e 0g p:1/1]");
  });
});

// ── Layout auto-sets flowDirection ───────────────────────────

describe("IntentLayer — layout sets flowDirection", () => {
  it("sets flowDirection after layout", async () => {
    await layer.executeOps([
      "add svc A theme:blue",
      "add svc B theme:blue",
      "connect A -> B",
    ]);
    await layer.executeOps(["layout @all algo:layered dir:LR"]);
    expect(layer.model.getActivePage().flowDirection).toBe("LR");
  });
});

// ── Canvas-relative positioning ──────────────────────────────

describe("IntentLayer — canvas-relative positioning", () => {
  it("moves a shape to a named region", async () => {
    await layer.executeOps([
      "add svc A theme:blue at:100,100",
      "add svc B theme:blue at:500,500",
    ]);
    const results = await layer.executeOps(["move A to:top-left"]);
    expect(results[0].success).toBe(true);
    expect(results[0].message).toContain("@moved A");

    const page = layer.model.getActivePage();
    const shapeA = [...page.shapes.values()].find((s) => s.label === "A")!;
    // A should be in the top-left region, which means smaller x,y than center
    expect(shapeA.bounds.x).toBeLessThan(300);
    expect(shapeA.bounds.y).toBeLessThan(300);
  });

  it("adds a shape at a named region", async () => {
    await layer.executeOps([
      "add svc Existing theme:blue at:100,100",
      "add svc New theme:green at:center",
    ]);
    const page = layer.model.getActivePage();
    const newShape = [...page.shapes.values()].find((s) => s.label === "New")!;
    // center of canvas region (with margin around 100,100 shape)
    expect(newShape).toBeDefined();
  });

  it("falls back to X,Y when not a valid region", async () => {
    await layer.executeOps(["add svc A theme:blue at:100,100"]);
    const results = await layer.executeOps(["move A to:300,400"]);
    expect(results[0].success).toBe(true);

    const page = layer.model.getActivePage();
    const shapeA = [...page.shapes.values()].find((s) => s.label === "A")!;
    expect(shapeA.bounds.x).toBe(300);
    expect(shapeA.bounds.y).toBe(400);
  });
});

// ── Group move ───────────────────────────────────────────────

describe("IntentLayer — group move", () => {
  it("moves all members of a group", async () => {
    await layer.executeOps([
      "add svc A theme:blue at:100,100",
      "add svc B theme:blue at:300,100",
      "group A B as:Backend",
    ]);

    const page = layer.model.getActivePage();
    const aBefore = [...page.shapes.values()].find((s) => s.label === "A")!.bounds.x;

    const results = await layer.executeOps(["move @group:Backend to:500,500 strict:true"]);
    expect(results[0].success).toBe(true);
    expect(results[0].message).toContain("@moved group Backend");
    expect(results[0].message).toContain("2 shapes");

    const aAfter = [...page.shapes.values()].find((s) => s.label === "A")!;
    // A should have moved from the original position
    expect(aAfter.bounds.x).not.toBe(aBefore);
  });

  it("rejects unknown group", async () => {
    const results = await layer.executeOps(["move @group:Unknown to:100,100"]);
    expect(results[0].success).toBe(false);
    expect(results[0].message).toContain("Unknown group");
  });
});

// ── Collision detection ──────────────────────────────────────

describe("IntentLayer — collision prevention", () => {
  it("pushes downstream shapes after move", async () => {
    await layer.executeOps([
      "orient TB",
      "add svc A theme:blue at:100,100",
      "add svc B theme:blue at:100,250",
    ]);

    // Move A to overlap B's position
    const results = await layer.executeOps(["move A to:100,230"]);
    expect(results[0].success).toBe(true);
    expect(results[0].message).toContain("shifted");

    // B should have been pushed downstream
    const page = layer.model.getActivePage();
    const shapeB = [...page.shapes.values()].find((s) => s.label === "B")!;
    expect(shapeB.bounds.y).toBeGreaterThan(250);
  });

  it("does not push with strict:true", async () => {
    await layer.executeOps([
      "orient TB",
      "add svc A theme:blue at:100,100",
      "add svc B theme:blue at:100,250",
    ]);

    const results = await layer.executeOps(["move A to:100,230 strict:true"]);
    expect(results[0].success).toBe(true);
    expect(results[0].message).not.toContain("shifted");

    // B should NOT have moved
    const page = layer.model.getActivePage();
    const shapeB = [...page.shapes.values()].find((s) => s.label === "B")!;
    expect(shapeB.bounds.y).toBe(250);
  });

  it("ripples through multiple shapes", async () => {
    await layer.executeOps([
      "orient TB",
      "add svc A theme:blue at:100,100",
      "add svc B theme:blue at:100,220",
      "add svc C theme:blue at:100,340",
    ]);

    // Move A down to overlap B, which should cascade to C
    const results = await layer.executeOps(["move A to:100,200"]);
    expect(results[0].success).toBe(true);

    const page = layer.model.getActivePage();
    const shapes = [...page.shapes.values()].sort((a, b) => a.bounds.y - b.bounds.y);
    // Each shape should be at least 30px gap apart
    expect(shapes[1].bounds.y).toBeGreaterThanOrEqual(shapes[0].bounds.y + shapes[0].bounds.height + 30);
    expect(shapes[2].bounds.y).toBeGreaterThanOrEqual(shapes[1].bounds.y + shapes[1].bounds.height + 30);
  });

  it("only pushes downstream, not upstream", async () => {
    await layer.executeOps([
      "orient TB",
      "add svc A theme:blue at:100,100",
      "add svc B theme:blue at:100,300",
    ]);

    // Move B up to overlap A's area — A is upstream so should NOT move
    const results = await layer.executeOps(["move B to:100,120"]);
    expect(results[0].success).toBe(true);

    const page = layer.model.getActivePage();
    const shapeA = [...page.shapes.values()].find((s) => s.label === "A")!;
    expect(shapeA.bounds.y).toBe(100); // A unchanged
  });
});

// ── Style @group: targets container, not members ────────────

describe("IntentLayer — style text formatting", () => {
  beforeEach(async () => {
    await layer.executeOps(["add svc Title theme:blue"]);
  });

  it("bold flag sets fontStyle bit 1", async () => {
    const results = await layer.executeOps(["style Title bold"]);
    expect(results[0].success).toBe(true);

    const page = layer.model.getActivePage();
    const shape = [...page.shapes.values()][0];
    expect(shape.style.fontStyle).toBe(1);
  });

  it("italic flag sets fontStyle bit 2", async () => {
    const results = await layer.executeOps(["style Title italic"]);
    expect(results[0].success).toBe(true);

    const page = layer.model.getActivePage();
    const shape = [...page.shapes.values()][0];
    expect(shape.style.fontStyle).toBe(2);
  });

  it("underline flag sets fontStyle bit 4", async () => {
    const results = await layer.executeOps(["style Title underline"]);
    expect(results[0].success).toBe(true);

    const page = layer.model.getActivePage();
    const shape = [...page.shapes.values()][0];
    expect(shape.style.fontStyle).toBe(4);
  });

  it("bold italic combined sets fontStyle to 3", async () => {
    const results = await layer.executeOps(["style Title bold italic"]);
    expect(results[0].success).toBe(true);

    const page = layer.model.getActivePage();
    const shape = [...page.shapes.values()][0];
    expect(shape.style.fontStyle).toBe(3);
  });

  it("no-bold clears bit 1 without affecting others", async () => {
    // First set bold+italic (3)
    await layer.executeOps(["style Title bold italic"]);
    // Then clear bold
    const results = await layer.executeOps(["style Title no-bold"]);
    expect(results[0].success).toBe(true);

    const page = layer.model.getActivePage();
    const shape = [...page.shapes.values()][0];
    expect(shape.style.fontStyle).toBe(2); // only italic remains
  });

  it("no-italic clears bit 2 without affecting others", async () => {
    await layer.executeOps(["style Title bold italic underline"]);
    const results = await layer.executeOps(["style Title no-italic"]);
    expect(results[0].success).toBe(true);

    const page = layer.model.getActivePage();
    const shape = [...page.shapes.values()][0];
    expect(shape.style.fontStyle).toBe(5); // bold + underline
  });

  it("font-family:Helvetica sets fontFamily", async () => {
    const results = await layer.executeOps(["style Title font-family:Helvetica"]);
    expect(results[0].success).toBe(true);

    const page = layer.model.getActivePage();
    const shape = [...page.shapes.values()][0];
    expect(shape.style.fontFamily).toBe("Helvetica");
  });

  it("align:left sets align", async () => {
    const results = await layer.executeOps(["style Title align:left"]);
    expect(results[0].success).toBe(true);

    const page = layer.model.getActivePage();
    const shape = [...page.shapes.values()][0];
    expect(shape.style.align).toBe("left");
  });

  it("valign:top sets verticalAlign", async () => {
    const results = await layer.executeOps(["style Title valign:top"]);
    expect(results[0].success).toBe(true);

    const page = layer.model.getActivePage();
    const shape = [...page.shapes.values()][0];
    expect(shape.style.verticalAlign).toBe("top");
  });

  it("combines text styling with fill and fontSize", async () => {
    const results = await layer.executeOps([
      "style Title fill:#1E293B font:#FFF bold fontSize:24 align:center",
    ]);
    expect(results[0].success).toBe(true);

    const page = layer.model.getActivePage();
    const shape = [...page.shapes.values()][0];
    expect(shape.style.fillColor).toBe("#1E293B");
    expect(shape.style.fontColor).toBe("#FFF");
    expect(shape.style.fontStyle).toBe(1);
    expect(shape.style.fontSize).toBe(24);
    expect(shape.style.align).toBe("center");
  });

  it("response message shows bare flags without :true", async () => {
    const results = await layer.executeOps(["style Title bold italic"]);
    expect(results[0].message).toContain("bold");
    expect(results[0].message).toContain("italic");
    expect(results[0].message).not.toContain(":true");
  });
});

describe("IntentLayer — style @group: targets container", () => {
  it("applies fill to group container, not member shapes", async () => {
    await layer.executeOps([
      "add svc Auth theme:blue",
      "add svc Users theme:blue",
      "group Auth Users as:Backend",
    ]);

    const page = layer.model.getActivePage();
    const authBefore = [...page.shapes.values()].find((s) => s.label === "Auth")!;
    const originalFill = authBefore.style.fillColor;

    const results = await layer.executeOps(["style @group:Backend fill:#dae8fc stroke:#6c8ebf"]);
    expect(results[0].success).toBe(true);
    expect(results[0].message).toContain("group Backend");

    // Group container should have the new fill
    const group = layer.model.getGroupByName("Backend")!;
    expect(group.style.fillColor).toBe("#dae8fc");
    expect(group.style.strokeColor).toBe("#6c8ebf");

    // Member shapes should be unchanged
    const authAfter = [...page.shapes.values()].find((s) => s.label === "Auth")!;
    expect(authAfter.style.fillColor).toBe(originalFill);
  });

  it("returns error for unknown group", async () => {
    const results = await layer.executeOps(["style @group:NonExistent fill:#fff"]);
    expect(results[0].success).toBe(false);
    expect(results[0].message).toContain("Unknown group");
  });
});

// ── Fix 2: Export verb via mutation tool ────────────────────

describe("IntentLayer — export via mutation tool", () => {
  it("export on empty diagram returns error", async () => {
    const fresh = new IntentLayer();
    const result = await fresh.executeSingleOp("export");
    expect(result.success).toBe(false);
    expect(result.message).toContain("empty");
  });
});

// ── Fix 3: Empty label rejection ───────────────────────────

describe("IntentLayer — empty label", () => {
  it("rejects add with empty label", async () => {
    const results = await layer.executeOps(['add svc ""']);
    expect(results[0].success).toBe(false);
    expect(results[0].message).toContain("empty label");
  });
});

// ── Fix 4: Newline label canonicalization ───────────────────

describe("IntentLayer — newline label matching", () => {
  it("resolves shape with \\n in label via &#10; reference", async () => {
    await layer.executeOps(['add svc "Container\nRegistry"']);
    const page = layer.model.getActivePage();
    const shape = [...page.shapes.values()][0];
    expect(shape.label).toBe("Container\nRegistry");

    // Reference using &#10; form
    const results = await layer.executeOps(['style "Container&#10;Registry" fill:#ff0000']);
    expect(results[0].success).toBe(true);
  });
});

// ── Fix 5: Label alias ─────────────────────────────────────

describe("IntentLayer — label alias", () => {
  it("sets alias when label: override is used", async () => {
    await layer.executeOps(['add svc Ref label:"Display Name"']);
    const page = layer.model.getActivePage();
    const shape = [...page.shapes.values()][0];
    expect(shape.label).toBe("Display Name");
    expect(shape.alias).toBe("Ref");
  });

  it("resolves shape by alias", async () => {
    await layer.executeOps(['add svc Ref label:"Display Name"']);
    // Style by alias
    const results = await layer.executeOps(["style Ref fill:#ff0000"]);
    expect(results[0].success).toBe(true);
  });

  it("resolves shape by display name too", async () => {
    await layer.executeOps(['add svc Ref label:"Display Name"']);
    const results = await layer.executeOps(['style "Display Name" fill:#00ff00']);
    expect(results[0].success).toBe(true);
  });
});

// ── Fix 6: Connect improvements ────────────────────────────

describe("IntentLayer — fractional port positions", () => {
  beforeEach(async () => {
    await layer.executeOps(["add svc A", "add svc B"]);
  });

  it("connects with fractional exit port", async () => {
    const results = await layer.executeOps([
      "connect A -> B exit:bottom@0.25 entry:top@0.75",
    ]);
    expect(results[0].success).toBe(true);

    const page = layer.model.getActivePage();
    const edge = [...page.edges.values()][0];
    const style = edge.style as Record<string, unknown>;
    expect(style["exitX"]).toBe(0.25);
    expect(style["exitY"]).toBe(1);
    expect(style["entryX"]).toBe(0.75);
    expect(style["entryY"]).toBe(0);
  });

  it("uses default 0.5 fraction when no @ specified", async () => {
    const results = await layer.executeOps(["connect A -> B exit:bottom entry:top"]);
    expect(results[0].success).toBe(true);

    const page = layer.model.getActivePage();
    const edge = [...page.edges.values()][0];
    const style = edge.style as Record<string, unknown>;
    expect(style["exitX"]).toBe(0.5);
    expect(style["exitY"]).toBe(1);
  });
});

// ── Fix 6: Edge style improvements ─────────────────────────

describe("IntentLayer — edge style improvements", () => {
  beforeEach(async () => {
    await layer.executeOps(["add svc A", "add svc B"]);
  });

  it("edge style includes jumpStyle=arc and jumpSize=13", async () => {
    await layer.executeOps(["connect A -> B"]);

    const { serializeDiagram } = await import("../serialization/serialize.js");
    const xml = serializeDiagram(layer.model.diagram);
    expect(xml).toContain("jumpStyle=arc");
    expect(xml).toContain("jumpSize=13");
  });

  it("labeled edge includes labelBackgroundColor", async () => {
    await layer.executeOps(["connect A -> B label:queries"]);

    const { serializeDiagram } = await import("../serialization/serialize.js");
    const xml = serializeDiagram(layer.model.diagram);
    expect(xml).toContain("labelBackgroundColor=#FFFFFF");
  });
});

// ── Fix 7: Style passthrough ───────────────────────────────

describe("IntentLayer — style passthrough", () => {
  it("passes through recognized draw.io properties", async () => {
    await layer.executeOps(["add svc MyShape"]);
    const results = await layer.executeOps(["style MyShape spacingTop:10"]);
    expect(results[0].success).toBe(true);

    const page = layer.model.getActivePage();
    const shape = [...page.shapes.values()][0];
    expect((shape.style as Record<string, unknown>)["spacingTop"]).toBe("10");
  });

  it("passes through container property", async () => {
    await layer.executeOps(["add svc MyShape"]);
    const results = await layer.executeOps(["style MyShape container:1"]);
    expect(results[0].success).toBe(true);

    const page = layer.model.getActivePage();
    const shape = [...page.shapes.values()][0];
    expect((shape.style as Record<string, unknown>)["container"]).toBe("1");
  });

  it("silently ignores properties not in allowlist", async () => {
    await layer.executeOps(["add svc MyShape"]);
    const results = await layer.executeOps(["style MyShape fil:#ff0000"]);
    expect(results[0].success).toBe(true);

    const page = layer.model.getActivePage();
    const shape = [...page.shapes.values()][0];
    // "fil" is a typo — not in FCP known keys or passthrough list, so ignored
    expect((shape.style as Record<string, unknown>)["fil"]).toBeUndefined();
  });
});

// ── Colon in shape references ─────────────────────────────

describe("IntentLayer — colon in shape labels", () => {
  it("style resolves shape with colon in label", async () => {
    await layer.executeOps(['add svc "threshold: 5 seconds"']);
    const results = await layer.executeOps(['style "threshold: 5 seconds" bold']);
    expect(results[0].success).toBe(true);
  });

  it("connect resolves shapes with colons in labels", async () => {
    await layer.executeOps([
      'add svc "Service: Auth"',
      'add db "Service: DB"',
    ]);
    const results = await layer.executeOps(['connect "Service: Auth" -> "Service: DB"']);
    expect(results[0].success).toBe(true);
  });

  it("remove resolves shape with colon in label", async () => {
    await layer.executeOps(['add svc "threshold: 5 seconds"']);
    const results = await layer.executeOps(['remove "threshold: 5 seconds"']);
    expect(results[0].success).toBe(true);
  });

  it("move resolves shape with colon in label", async () => {
    await layer.executeOps(['add svc "Config: Redis"']);
    const results = await layer.executeOps(['move "Config: Redis" to:200,200']);
    expect(results[0].success).toBe(true);
  });
});
