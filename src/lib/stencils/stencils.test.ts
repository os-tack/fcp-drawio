import { describe, it, expect } from "vitest";
import { parseOp, isParseError } from "../../parser/parse-op.js";
import { IntentLayer } from "../../server/intent-layer.js";
import { buildShapeStyleString } from "../../serialization/serialize.js";
import { serializeDiagram } from "../../serialization/serialize.js";
import { deserializeDiagram } from "../../serialization/deserialize.js";
import { listStencilPacks, getStencilPack } from "./index.js";

// ── Stencil Registry ─────────────────────────────────────

describe("stencil registry", () => {
  it("listStencilPacks returns all 6 packs", () => {
    const packs = listStencilPacks();
    expect(packs.length).toBe(6);
    const ids = packs.map(p => p.id);
    expect(ids).toContain("aws");
    expect(ids).toContain("azure");
    expect(ids).toContain("gcp");
    expect(ids).toContain("k8s");
    expect(ids).toContain("cisco");
    expect(ids).toContain("ibm");
  });

  it("getStencilPack returns aws pack with entries", () => {
    const pack = getStencilPack("aws");
    expect(pack).toBeDefined();
    expect(pack!.name).toBe("Amazon Web Services");
    expect(pack!.prefix).toBe("mxgraph.aws4");
    expect(pack!.entries.length).toBeGreaterThan(20);
  });

  it("getStencilPack returns undefined for unknown pack", () => {
    expect(getStencilPack("unknown")).toBeUndefined();
  });

  it("all packs have valid entries", () => {
    const packs = listStencilPacks();
    for (const { id } of packs) {
      const pack = getStencilPack(id)!;
      expect(pack.entries.length).toBeGreaterThan(0);
      for (const entry of pack.entries) {
        expect(entry.id).toBeTruthy();
        expect(entry.label).toBeTruthy();
        expect(entry.category).toBeTruthy();
        expect(entry.baseStyle).toContain("shape=mxgraph.");
        expect(entry.defaultWidth).toBeGreaterThan(0);
        expect(entry.defaultHeight).toBeGreaterThan(0);
      }
    }
  });
});

// ── Parser ───────────────────────────────────────────────

describe("parse load verb", () => {
  it("parses 'load aws'", () => {
    const result = parseOp("load aws");
    expect(isParseError(result)).toBe(false);
    if (!isParseError(result)) {
      expect(result.verb).toBe("load");
      expect(result.target).toBe("aws");
    }
  });

  it("parses 'load list'", () => {
    const result = parseOp("load list");
    expect(isParseError(result)).toBe(false);
    if (!isParseError(result)) {
      expect(result.verb).toBe("load");
      expect(result.target).toBe("list");
    }
  });

  it("errors on bare 'load'", () => {
    const result = parseOp("load");
    expect(isParseError(result)).toBe(true);
  });
});

// ── Intent Layer: handleLoad ─────────────────────────────

describe("handleLoad", () => {
  it("load list returns all packs", async () => {
    const intent = new IntentLayer();
    const results = await intent.executeOps(["load list"]);
    expect(results[0].success).toBe(true);
    expect(results[0].message).toContain("aws");
    expect(results[0].message).toContain("azure");
    expect(results[0].message).toContain("gcp");
  });

  it("load aws activates AWS pack", async () => {
    const intent = new IntentLayer();
    const results = await intent.executeOps(["load aws"]);
    expect(results[0].success).toBe(true);
    expect(results[0].message).toContain("Amazon Web Services");
    expect(intent.model.diagram.loadedStencilPacks.has("aws")).toBe(true);
    expect(intent.loadedStencilEntries.has("lambda")).toBe(true);
    expect(intent.loadedStencilEntries.has("s3")).toBe(true);
  });

  it("load unknown-pack errors", async () => {
    const intent = new IntentLayer();
    const results = await intent.executeOps(["load unknown-pack"]);
    expect(results[0].success).toBe(false);
    expect(results[0].message).toContain("Unknown stencil pack");
  });

  it("loading same pack twice is idempotent", async () => {
    const intent = new IntentLayer();
    await intent.executeOps(["load aws"]);
    const results = await intent.executeOps(["load aws"]);
    expect(results[0].success).toBe(true);
    expect(results[0].message).toContain("already loaded");
  });

  it("multiple packs can be loaded", async () => {
    const intent = new IntentLayer();
    await intent.executeOps(["load aws"]);
    await intent.executeOps(["load gcp"]);
    expect(intent.model.diagram.loadedStencilPacks.has("aws")).toBe(true);
    expect(intent.model.diagram.loadedStencilPacks.has("gcp")).toBe(true);
    expect(intent.loadedStencilEntries.has("lambda")).toBe(true);
    expect(intent.loadedStencilEntries.has("cloud-run")).toBe(true);
  });
});

// ── Intent Layer: stencil types in add ────────────────────

describe("add with stencil types", () => {
  it("add lambda creates shape with baseStyleOverride", async () => {
    const intent = new IntentLayer();
    await intent.executeOps(["load aws"]);
    const results = await intent.executeOps(["add lambda MyFunc"]);
    expect(results[0].success).toBe(true);

    const page = intent.model.getActivePage();
    const shape = [...page.shapes.values()].find(s => s.label === "MyFunc");
    expect(shape).toBeDefined();
    expect(shape!.baseStyleOverride).toContain("mxgraph.aws4");
    expect(shape!.bounds.width).toBe(60);
    expect(shape!.bounds.height).toBe(60);
  });

  it("add lambda with theme:red applies theme colors on top", async () => {
    const intent = new IntentLayer();
    await intent.executeOps(["load aws"]);
    const results = await intent.executeOps(["add lambda MyFunc theme:red"]);
    expect(results[0].success).toBe(true);

    const page = intent.model.getActivePage();
    const shape = [...page.shapes.values()].find(s => s.label === "MyFunc");
    expect(shape).toBeDefined();
    expect(shape!.baseStyleOverride).toContain("mxgraph.aws4");
    // Red theme should set fill/stroke colors
    expect(shape!.style.fillColor).toBe("#f8cecc");
    expect(shape!.style.strokeColor).toBe("#b85450");
  });

  it("stencil type without explicit theme skips default blue", async () => {
    const intent = new IntentLayer();
    await intent.executeOps(["load aws"]);
    const results = await intent.executeOps(["add lambda MyFunc"]);
    expect(results[0].success).toBe(true);

    const page = intent.model.getActivePage();
    const shape = [...page.shapes.values()].find(s => s.label === "MyFunc");
    // No theme override means style should NOT have blue theme colors
    expect(shape!.style.fillColor).toBeNull();
    expect(shape!.style.strokeColor).toBeNull();
  });

  it("built-in types still win over stencil types", async () => {
    const intent = new IntentLayer();
    await intent.executeOps(["load aws"]);
    const results = await intent.executeOps(["add svc MyService"]);
    expect(results[0].success).toBe(true);

    const page = intent.model.getActivePage();
    const shape = [...page.shapes.values()].find(s => s.label === "MyService");
    expect(shape).toBeDefined();
    expect(shape!.type).toBe("svc");
    expect(shape!.baseStyleOverride).toBeUndefined();
  });

  it("stencil type not recognized without loading pack", async () => {
    const intent = new IntentLayer();
    // Don't load aws
    const results = await intent.executeOps(["add lambda MyFunc"]);
    expect(results[0].success).toBe(true);

    const page = intent.model.getActivePage();
    const shape = [...page.shapes.values()].find(s => s.label === "MyFunc");
    expect(shape).toBeDefined();
    // Without aws pack, "lambda" is treated as unknown → fallback svc, no override
    expect(shape!.baseStyleOverride).toBeUndefined();
  });
});

// ── Serialization ────────────────────────────────────────

describe("stencil serialization", () => {
  it("baseStyleOverride emitted in mxCell style", async () => {
    const intent = new IntentLayer();
    await intent.executeOps(["load aws"]);
    await intent.executeOps(["add lambda MyFunc"]);

    const styleStr = buildShapeStyleString(
      [...intent.model.getActivePage().shapes.values()].find(s => s.label === "MyFunc")!
    );
    expect(styleStr).toContain("mxgraph.aws4");
    // Should NOT contain default svc base style
    expect(styleStr).not.toContain("rounded=1;whiteSpace=wrap");
  });

  it("loadedStencilPacks persisted in fcp-meta", async () => {
    const intent = new IntentLayer();
    await intent.executeOps(["load aws"]);
    await intent.executeOps(["add lambda MyFunc"]);

    const xml = serializeDiagram(intent.model.diagram);
    expect(xml).toContain("fcp-meta");
    expect(xml).toContain("loadedStencilPacks");
    expect(xml).toContain("aws");
  });

  it("round-trip preserves baseStyleOverride and loadedStencilPacks", async () => {
    const intent = new IntentLayer();
    await intent.executeOps(["load aws"]);
    await intent.executeOps(["add lambda MyFunc"]);

    const xml = serializeDiagram(intent.model.diagram);
    const diagram = deserializeDiagram(xml);

    expect(diagram.loadedStencilPacks.has("aws")).toBe(true);

    const page = diagram.pages[0];
    const shape = [...page.shapes.values()].find(s => s.label === "MyFunc");
    expect(shape).toBeDefined();
    expect(shape!.baseStyleOverride).toContain("mxgraph.aws4");
  });
});
