import { describe, it, expect } from "vitest";
import { detectDrawioCLI } from "../lib/drawio-cli.js";
import { IntentLayer } from "./intent-layer.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";

const cliPath = detectDrawioCLI();

describe("export verb", () => {
  it("returns error when diagram is empty", async () => {
    const intent = new IntentLayer();
    const [result] = await intent.executeOps(["export"]);
    expect(result.success).toBe(false);
    expect(result.message).toContain("empty");
  });

  it("returns error when CLI not available", async () => {
    const intent = new IntentLayer({ drawioCliPath: null });
    await intent.executeOps(["add svc Foo"]);
    const [result] = await intent.executeOps(["export"]);
    expect(result.success).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("returns error for invalid format", async () => {
    const intent = new IntentLayer({ drawioCliPath: cliPath });
    await intent.executeOps(["add svc Foo"]);
    const [result] = await intent.executeOps(["export fmt:bmp"]);
    expect(result.success).toBe(false);
    expect(result.message).toContain("unsupported format");
  });

  it("returns error for out-of-range page number", async () => {
    const intent = new IntentLayer();
    await intent.executeOps(["add svc Foo"]);
    const [result] = await intent.executeOps(["export page:5"]);
    expect(result.success).toBe(false);
    expect(result.message).toContain("invalid page 5");
  });

  it.skipIf(!cliPath)("returns inline PNG by default", async () => {
    const intent = new IntentLayer({ drawioCliPath: cliPath });
    await intent.executeOps(["add svc Foo", "add db Bar"]);
    const [result] = await intent.executeOps(["export"]);
    expect(result.success).toBe(true);
    expect(result.image).toBeDefined();
    expect(result.image!.base64.length).toBeGreaterThan(100);
    expect(result.image!.mimeType).toBe("image/png");
    expect(result.message).toContain("export:");
  });

  it.skipIf(!cliPath)("passes width param", async () => {
    const intent = new IntentLayer({ drawioCliPath: cliPath });
    await intent.executeOps(["add svc Foo"]);
    const [result] = await intent.executeOps(["export width:600"]);
    expect(result.success).toBe(true);
    expect(result.image).toBeDefined();
    expect(result.message).toContain("600px");
  });

  it.skipIf(!cliPath)("passes height param", async () => {
    const intent = new IntentLayer({ drawioCliPath: cliPath });
    await intent.executeOps(["add svc Foo"]);
    const [result] = await intent.executeOps(["export height:400"]);
    expect(result.success).toBe(true);
    expect(result.image).toBeDefined();
  });

  it.skipIf(!cliPath)("returns inline SVG as text", async () => {
    const intent = new IntentLayer({ drawioCliPath: cliPath });
    await intent.executeOps(["add svc Foo"]);
    const [result] = await intent.executeOps(["export fmt:svg"]);
    expect(result.success).toBe(true);
    expect(result.message).toContain("<svg");
    expect(result.image).toBeUndefined();
  });

  it.skipIf(!cliPath)("writes file to disk", async () => {
    const intent = new IntentLayer({ drawioCliPath: cliPath });
    await intent.executeOps(["add svc Foo"]);
    const outPath = join(tmpdir(), `export-test-${randomBytes(4).toString("hex")}.png`);
    try {
      const [result] = await intent.executeOps([`export file as:${outPath}`]);
      expect(result.success).toBe(true);
      expect(result.message).toContain("exported");
      expect(result.message).toContain(outPath);
      expect(existsSync(outPath)).toBe(true);
    } finally {
      try { unlinkSync(outPath); } catch { /* ok */ }
    }
  });

  it.skipIf(!cliPath)("renders specific page", async () => {
    const intent = new IntentLayer({ drawioCliPath: cliPath });
    await intent.executeOps(["add svc Foo"]);
    await intent.executeOps(['page add "Page2"']);
    await intent.executeOps(["add db Bar", "add api Baz"]);

    const [r1] = await intent.executeOps(["export page:1"]);
    expect(r1.success).toBe(true);
    expect(r1.message).toContain("p:1/2");
    expect(r1.message).toContain("1s");

    const [r2] = await intent.executeOps(["export page:2"]);
    expect(r2.success).toBe(true);
    expect(r2.message).toContain("p:2/2");
    expect(r2.message).toContain("2s");
  }, 20_000);

  it("empty page on different page returns error for that page", async () => {
    const intent = new IntentLayer({ drawioCliPath: null });
    await intent.executeOps(["add svc Foo"]);
    await intent.executeOps(['page add "Page2"']);
    await intent.executeOps(['page switch "Page-1"']);
    // page 2 is empty
    const [result] = await intent.executeOps(["export page:2"]);
    expect(result.success).toBe(false);
    expect(result.message).toContain("empty");
  });
});

describe("snapshot query removed", () => {
  it("snapshot via query returns unknown command", () => {
    const intent = new IntentLayer();
    const result = intent.executeQuery("snapshot");
    expect(typeof result).toBe("string");
    expect(result as string).toContain("Unknown query command");
  });

  it("export via query returns unknown command", () => {
    const intent = new IntentLayer();
    const result = intent.executeQuery("export");
    expect(typeof result).toBe("string");
    expect(result as string).toContain("Unknown query command");
  });
});
