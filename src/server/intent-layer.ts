import type {
  OpResult, ParsedOp, Shape, Edge, ArrowType, EdgeStyleSet,
  ShapeType, ThemeName, Badge,
} from "../types/index.js";
import { DiagramModel } from "../model/diagram-model.js";
import { parseOp, isParseError } from "../parser/parse-op.js";
import { resolveRef } from "../parser/resolve-ref.js";
import { isShapeType, inferTypeFromLabel, computeDefaultSize } from "../lib/node-types.js";
import { isThemeName, resolveColor, THEMES } from "../lib/themes.js";
import {
  formatShapeCreated, formatEdgeCreated, formatShapeModified,
  formatShapeDeleted, formatGroupCreated,
} from "./response-formatter.js";
import { runElkLayout } from "../layout/elk-layout.js";
import type { LayoutOptions } from "../layout/elk-layout.js";
import { QueryHandler } from "./query-handler.js";
import type { QueryResult } from "./query-handler.js";
import { SessionHandler } from "./session-handler.js";
import { getStencilPack, listStencilPacks } from "../lib/stencils/index.js";
import type { StencilEntry } from "../lib/stencils/index.js";
import { renderExport } from "../lib/drawio-cli.js";
import type { ExportFormat } from "../lib/drawio-cli.js";
import { serializeDiagram } from "../serialization/serialize.js";
import { tokenize, isKeyValue, parseKeyValue } from "../parser/tokenizer.js";
import { resolve, dirname } from "node:path";

/** draw.io style properties that pass through when not handled by FCP's own keys. */
const DRAWIO_PASSTHROUGH = new Set([
  "spacingTop", "spacingBottom", "spacingLeft", "spacingRight", "spacing",
  "container", "collapsible", "horizontal", "whiteSpace", "overflow",
  "labelPosition", "verticalLabelPosition", "labelBorderColor", "labelBackgroundColor",
  "swimlaneLine", "startSize", "arcSize", "perimeterSpacing", "strokeWidth",
  "exitDx", "exitDy", "entryDx", "entryDy", "fillOpacity",
  "gradientColor", "gradientDirection", "glass", "aspect",
]);

/**
 * Parse a port hint like "bottom", "bottom@0.25", "top@0.75".
 * Returns [x, y] for draw.io exit/entry coordinates, or null if invalid.
 *
 * The face determines the fixed axis (e.g., bottom → y=1),
 * and the optional @fraction controls position along the face (default 0.5).
 */
function parsePortHint(hint: string): [number, number] | null {
  const atIdx = hint.indexOf("@");
  const face = atIdx >= 0 ? hint.slice(0, atIdx) : hint;
  const fraction = atIdx >= 0 ? parseFloat(hint.slice(atIdx + 1)) : 0.5;

  if (isNaN(fraction) || fraction < 0 || fraction > 1) return null;

  switch (face) {
    case "top":    return [fraction, 0];
    case "bottom": return [fraction, 1];
    case "left":   return [0, fraction];
    case "right":  return [1, fraction];
    default:       return null;
  }
}

export class IntentLayer {
  model: DiagramModel;
  private queryHandler: QueryHandler;
  private sessionHandler: SessionHandler;
  /** O(1) lookup for loaded stencil entries by their short ID (e.g., "lambda", "s3"). */
  loadedStencilEntries: Map<string, StencilEntry> = new Map();
  readonly drawioCliPath: string | null;

  constructor(options?: { drawioCliPath?: string | null }) {
    this.model = new DiagramModel();
    this.drawioCliPath = options?.drawioCliPath ?? null;
    this.queryHandler = new QueryHandler(this.model);
    this.sessionHandler = new SessionHandler(this.model);
  }

  /** Rebuild the stencil entry lookup from loaded packs (e.g., after deserialization). */
  restoreStencilPacks(): void {
    this.loadedStencilEntries.clear();
    for (const packId of this.model.diagram.loadedStencilPacks) {
      const pack = getStencilPack(packId);
      if (!pack) continue;
      for (const entry of pack.entries) {
        if (!this.loadedStencilEntries.has(entry.id)) {
          this.loadedStencilEntries.set(entry.id, entry);
        }
      }
    }
  }

  // ── Suggestion helpers ──────────────────────────────────

  /** Build a suggestion by replacing a bad ref with the suggested label in the raw op string. */
  private buildTypoSuggestion(raw: string, badRef: string, suggestedLabel: string): string {
    return raw.replace(badRef, suggestedLabel);
  }

  /** Build a type-qualified suggestion for ambiguous references. */
  private buildAmbiguousSuggestion(raw: string, badRef: string, shapes: Shape[]): string {
    const first = shapes[0];
    const qualified = `${first.type}:${badRef}`;
    return raw.replace(badRef, qualified);
  }

  // ── Main entry points ──────────────────────────────────

  async executeOps(ops: string[]): Promise<OpResult[]> {
    const results: OpResult[] = [];
    for (const op of ops) {
      results.push(await this.executeSingleOp(op));
    }
    return results;
  }

  executeQuery(query: string): string | QueryResult {
    try {
      return this.queryHandler.dispatch(query.trim());
    } catch (err: unknown) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  executeSession(action: string): string {
    try {
      const result = this.sessionHandler.dispatch(action.trim());
      // After open/new, restore stencil pack entries from diagram metadata
      this.restoreStencilPacks();
      return result;
    } catch (err: unknown) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // ── Single op execution ────────────────────────────────

  async executeSingleOp(opStr: string): Promise<OpResult> {
    const firstWord = opStr.trim().split(/\s/)[0]?.toLowerCase();
    if (firstWord === "export") {
      return this.executeExport(opStr.trim());
    }

    const parsed = parseOp(opStr);
    if (isParseError(parsed)) {
      return { success: false, message: parsed.error };
    }

    try {
      return await this.dispatchOp(parsed);
    } catch (err: unknown) {
      return {
        success: false,
        message: `Error executing "${parsed.verb}": ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private async executeExport(opStr: string): Promise<OpResult> {
    const tokens = tokenize(opStr);
    // tokens[0] is "export"

    // Parse params
    let format: ExportFormat = "png";
    let width = 1200;
    let height: number | undefined;
    let pageNum = 1;
    let outputPath: string | undefined;
    let fileMode = false;

    for (const token of tokens.slice(1)) {
      const lower = token.toLowerCase();
      if (lower === "file") {
        fileMode = true;
        continue;
      }
      if (lower === "inline") continue; // default, no-op

      if (isKeyValue(token)) {
        const { key, value } = parseKeyValue(token);
        switch (key) {
          case "fmt": {
            const f = value.toLowerCase();
            if (f !== "png" && f !== "svg" && f !== "pdf") {
              return { success: false, message: `export: unsupported format "${value}" — use png, svg, or pdf` };
            }
            format = f;
            break;
          }
          case "width": width = parseInt(value, 10) || 1200; break;
          case "height": height = parseInt(value, 10) || undefined; break;
          case "page": pageNum = parseInt(value, 10) || 1; break;
          case "as":
            outputPath = value;
            fileMode = true; // as: implies file mode
            break;
        }
      }
    }

    // Validate page
    const pages = this.model.diagram.pages;
    if (pageNum < 1 || pageNum > pages.length) {
      return { success: false, message: `export: invalid page ${pageNum} — diagram has ${pages.length} page(s)` };
    }
    const requestedPage = pages[pageNum - 1];

    if (requestedPage.shapes.size === 0) {
      return { success: false, message: "export: empty diagram — add shapes first" };
    }

    if (!this.drawioCliPath) {
      return { success: false, message: "export unavailable: draw.io desktop app not found. Install from https://drawio.com for visual review. Use 'map' query for text-based spatial summary." };
    }

    // Resolve relative outputPath against the session file directory or cwd
    let resolvedOutputPath: string | undefined;
    if (outputPath) {
      const baseDir = this.model.diagram.filePath
        ? dirname(this.model.diagram.filePath)
        : process.cwd();
      resolvedOutputPath = resolve(baseDir, outputPath);
    }

    const xml = serializeDiagram(this.model.diagram);

    try {
      const result = await renderExport({
        cliPath: this.drawioCliPath,
        diagramXml: xml,
        format,
        width,
        height,
        page: pageNum,
        outputPath: resolvedOutputPath,
      });

      const sizeKB = Math.round(result.sizeBytes / 1024);
      const pageCount = pages.length;
      const shapeCount = requestedPage.shapes.size;
      const edgeCount = requestedPage.edges.size;
      const groupCount = requestedPage.groups.size;
      const stats = `[${shapeCount}s ${edgeCount}e ${groupCount}g p:${pageNum}/${pageCount}]`;

      if (fileMode && resolvedOutputPath) {
        return {
          success: true,
          message: `+ exported ${outputPath} (${sizeKB}KB ${format.toUpperCase()} ${width}px ${stats})`,
        };
      }

      // Inline SVG: return text content (SVG is text-based)
      if (format === "svg") {
        const svgText = Buffer.from(result.base64, "base64").toString("utf-8");
        return {
          success: true,
          message: svgText,
        };
      }

      // Inline PNG/PDF: return image
      return {
        success: true,
        message: `export: ${width}px ${sizeKB}KB ${format.toUpperCase()} ${stats}`,
        image: { base64: result.base64, mimeType: result.mimeType },
      };
    } catch (err: unknown) {
      return {
        success: false,
        message: `export failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private async dispatchOp(op: ParsedOp): Promise<OpResult> {
    switch (op.verb) {
      case "add": return this.handleAdd(op);
      case "connect": return this.handleConnect(op);
      case "disconnect": return this.handleDisconnect(op);
      case "style": return this.handleStyle(op);
      case "remove": return this.handleRemove(op);
      case "label": return this.handleLabel(op);
      case "badge": return this.handleBadge(op);
      case "move": return this.handleMove(op);
      case "resize": return this.handleResize(op);
      case "swap": return this.handleSwap(op);
      case "group": return this.handleGroup(op);
      case "ungroup": return this.handleUngroup(op);
      case "define": return this.handleDefine(op);
      case "checkpoint": return this.handleCheckpoint(op);
      case "title": return this.handleTitle(op);
      case "page": return this.handlePage(op);
      case "layer": return this.handleLayer(op);
      case "layout": return this.handleLayout(op);
      case "orient": return this.handleOrient(op);
      case "load": return this.handleLoad(op);
      default:
        return { success: false, message: `Unhandled verb: ${op.verb}` };
    }
  }

  // ── Add ────────────────────────────────────────────────

  private handleAdd(op: ParsedOp): OpResult {
    const count = op.params.get("count") ? parseInt(op.params.get("count")!, 10) : 1;
    if (isNaN(count) || count < 1) {
      return { success: false, message: "Invalid count" };
    }

    // Resolve type
    let resolvedType: ShapeType;
    const customTypes = this.model.diagram.customTypes;
    let theme: ThemeName | undefined = op.params.get("theme") as ThemeName | undefined;
    let badgeText: string | undefined;

    let baseStyleOverride: string | undefined;
    let skipDefaultTheme = false;
    let stencilSize: { width: number; height: number } | undefined;

    if (op.type) {
      // 1. Check custom types first
      const ct = customTypes.get(op.type);
      if (ct) {
        resolvedType = ct.base;
        if (!theme && ct.theme) theme = ct.theme;
        if (ct.badge) badgeText = ct.badge;
      } else if (isShapeType(op.type)) {
        // 2. Built-in types
        resolvedType = op.type;
      } else {
        // 3. Check loaded stencil types
        const stencilEntry = this.loadedStencilEntries.get(op.type);
        if (stencilEntry) {
          resolvedType = "svc";  // fallback base type for the model
          baseStyleOverride = stencilEntry.baseStyle;
          stencilSize = { width: stencilEntry.defaultWidth, height: stencilEntry.defaultHeight };
          skipDefaultTheme = !theme;  // only skip if user didn't explicitly set theme
        } else {
          // 4. Unknown type — treat as label, shift: type becomes part of the label
          const inferred = inferTypeFromLabel(op.type);
          if (inferred) {
            resolvedType = inferred;
          } else {
            resolvedType = "svc";
          }
        }
      }
    } else {
      // No type specified — infer from label
      const target = op.target ?? "Untitled";
      const inferred = inferTypeFromLabel(target);
      resolvedType = inferred ?? "svc";
    }

    // Validate theme (check custom themes too)
    let customThemeColors: { fill: string; stroke: string; fontColor?: string } | undefined;
    if (theme) {
      const ct = this.model.diagram.customThemes.get(theme);
      if (ct) {
        customThemeColors = ct;
      } else if (!isThemeName(theme)) {
        return { success: false, message: `Unknown theme "${theme}"` };
      }
    }

    // Resolve near reference
    let nearId: string | undefined;
    const nearRef = op.params.get("near");
    if (nearRef) {
      const resolved = resolveRef(nearRef, this.model.registry, this.model);
      if (resolved.kind === "single") {
        nearId = resolved.shape.id;
      } else if (resolved.kind === "none") {
        const suggestion = resolved.suggestedLabel
          ? this.buildTypoSuggestion(op.raw, nearRef, resolved.suggestedLabel)
          : undefined;
        return { success: false, message: resolved.message, suggestion };
      } else {
        const suggestion = this.buildAmbiguousSuggestion(op.raw, nearRef, resolved.shapes);
        return { success: false, message: resolved.message, suggestion };
      }
    }

    // Parse size:WxH (before at: since region resolution needs size)
    let size: { width: number; height: number } | undefined;
    const sizeParam = op.params.get("size");
    if (sizeParam) {
      const parts = sizeParam.toLowerCase().split("x");
      if (parts.length === 2) {
        size = { width: parseFloat(parts[0]), height: parseFloat(parts[1]) };
      }
    }

    // Parse at:X,Y or at:region-name
    let at: { x: number; y: number } | undefined;
    const atParam = op.params.get("at");
    if (atParam) {
      // Try region name first
      const computedSize = size ?? computeDefaultSize(resolvedType, op.target ?? "Untitled");
      const regionPos = this.model.resolveCanvasRegion(atParam, computedSize);
      if (regionPos) {
        at = regionPos;
      } else {
        const parts = atParam.split(",");
        if (parts.length === 2) {
          at = { x: parseFloat(parts[0]), y: parseFloat(parts[1]) };
        }
      }
    }

    // Resolve in: group
    let inGroup: string | undefined;
    const inRef = op.params.get("in");
    if (inRef) {
      const group = this.model.getGroupByName(inRef);
      if (group) {
        inGroup = group.id;
      }
    }

    const dir = op.params.get("dir");

    const results: string[] = [];
    const warnings: string[] = [];

    const labelOverride = op.params.get("label");

    for (let i = 0; i < count; i++) {
      const label = labelOverride
        ? (count > 1 ? `${labelOverride}${i + 1}` : labelOverride)
        : (count > 1 ? `${op.target}${i + 1}` : (op.target ?? "Untitled"));

      if (label === "") {
        return { success: false, message: 'add: empty label — provide a name or use @recent' };
      }

      const shape = this.model.addShape(label, resolvedType, {
        theme: customThemeColors ? undefined : theme,
        near: nearId,
        dir: dir ?? undefined,
        at,
        inGroup,
        size: size ?? stencilSize,
        baseStyleOverride,
        skipDefaultTheme,
      });

      // Apply custom theme colors if using a custom theme
      if (customThemeColors) {
        const style = { ...shape.style };
        style.fillColor = customThemeColors.fill;
        style.strokeColor = customThemeColors.stroke;
        if (customThemeColors.fontColor) style.fontColor = customThemeColors.fontColor;
        this.model.modifyShape(shape.id, { style });
      }

      // Set alias when label: overrides the original target
      if (labelOverride && op.target && op.target !== label) {
        this.model.modifyShape(shape.id, { alias: op.target });
      }

      // Apply badge from custom type
      if (badgeText) {
        const badges: Badge[] = [{ text: badgeText, position: "top-right" }];
        this.model.modifyShape(shape.id, { metadata: { ...shape.metadata, badges } });
      }

      results.push(formatShapeCreated(shape));

      // For batch, subsequent shapes position near the previous one
      if (count > 1) {
        nearId = shape.id;
      }
    }

    return {
      success: true,
      message: results.join("\n"),
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  // ── Connect ────────────────────────────────────────────

  private handleConnect(op: ParsedOp): OpResult {
    const targets = op.targets;
    const arrows = op.arrows;
    if (!targets || !arrows || targets.length < 2 || arrows.length < 1) {
      return { success: false, message: "connect requires at least REF ARROW REF" };
    }

    // Parse optional params
    const label = op.params.get("label");
    const styleParam = op.params.get("style");
    const sourceArrowParam = op.params.get("source-arrow");
    const targetArrowParam = op.params.get("target-arrow");

    const results: string[] = [];
    const warnings: string[] = [];

    // Connect consecutive pairs: A -> B -> C creates A->B and B->C
    for (let i = 0; i < arrows.length; i++) {
      const srcRef = targets[i];
      const tgtRef = targets[i + 1];
      if (!srcRef || !tgtRef) break;

      const arrow = arrows[i];

      // Resolve source
      const srcResult = resolveRef(srcRef, this.model.registry, this.model);
      if (srcResult.kind === "none") {
        const suggestion = srcResult.suggestedLabel
          ? this.buildTypoSuggestion(op.raw, srcRef, srcResult.suggestedLabel)
          : undefined;
        return { success: false, message: srcResult.message, suggestion };
      }
      if (srcResult.kind === "multiple") {
        const suggestion = this.buildAmbiguousSuggestion(op.raw, srcRef, srcResult.shapes);
        return { success: false, message: srcResult.message, suggestion };
      }

      // Resolve target
      const tgtResult = resolveRef(tgtRef, this.model.registry, this.model);
      if (tgtResult.kind === "none") {
        const suggestion = tgtResult.suggestedLabel
          ? this.buildTypoSuggestion(op.raw, tgtRef, tgtResult.suggestedLabel)
          : undefined;
        return { success: false, message: tgtResult.message, suggestion };
      }
      if (tgtResult.kind === "multiple") {
        const suggestion = this.buildAmbiguousSuggestion(op.raw, tgtRef, tgtResult.shapes);
        return { success: false, message: tgtResult.message, suggestion };
      }

      // Determine arrow types based on operator
      let sourceArrow: ArrowType = "none";
      let targetArrow: ArrowType = "arrow";

      if (arrow === "<->") {
        sourceArrow = "arrow";
        targetArrow = "arrow";
      } else if (arrow === "--") {
        sourceArrow = "none";
        targetArrow = "none";
      }

      // Override with explicit params
      if (sourceArrowParam) sourceArrow = sourceArrowParam as ArrowType;
      if (targetArrowParam) targetArrow = targetArrowParam as ArrowType;

      // Build edge style
      const edgeStyleOverrides: Partial<EdgeStyleSet> = {};
      if (styleParam) {
        switch (styleParam) {
          case "dashed": edgeStyleOverrides.dashed = true; break;
          case "dotted": edgeStyleOverrides.dashed = true; edgeStyleOverrides.dotted = true; break;
          case "animated": edgeStyleOverrides.flowAnimation = true; break;
          case "curved": edgeStyleOverrides.curved = true; break;
          case "thick": break; // handled at render time
          case "orthogonal": edgeStyleOverrides.edgeStyle = "orthogonalEdgeStyle"; break;
        }
      }

      // Port hints: exit:face[@fraction], entry:face[@fraction]
      // e.g., exit:bottom, exit:bottom@0.25, entry:top@0.75
      const exitHint = op.params.get("exit");
      const entryHint = op.params.get("entry");
      if (exitHint) {
        const port = parsePortHint(exitHint);
        if (port) {
          (edgeStyleOverrides as Record<string, unknown>)["exitX"] = port[0];
          (edgeStyleOverrides as Record<string, unknown>)["exitY"] = port[1];
        }
      }
      if (entryHint) {
        const port = parsePortHint(entryHint);
        if (port) {
          (edgeStyleOverrides as Record<string, unknown>)["entryX"] = port[0];
          (edgeStyleOverrides as Record<string, unknown>)["entryY"] = port[1];
        }
      }

      const edge = this.model.addEdge(srcResult.shape.id, tgtResult.shape.id, {
        label: label ?? undefined,
        style: edgeStyleOverrides,
        sourceArrow,
        targetArrow,
      });

      if (!edge) {
        return { success: false, message: `Failed to create edge ${srcRef}->${tgtRef}` };
      }

      results.push(formatEdgeCreated(edge, srcResult.shape.label, tgtResult.shape.label));
    }

    return {
      success: true,
      message: results.join("\n"),
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  // ── Disconnect ─────────────────────────────────────────

  private handleDisconnect(op: ParsedOp): OpResult {
    const targets = op.targets;
    if (!targets || targets.length < 2) {
      return { success: false, message: "disconnect requires REF ARROW REF" };
    }

    const srcResult = resolveRef(targets[0], this.model.registry, this.model);
    if (srcResult.kind !== "single") {
      if (srcResult.kind === "none") {
        const suggestion = srcResult.suggestedLabel
          ? this.buildTypoSuggestion(op.raw, targets[0], srcResult.suggestedLabel)
          : undefined;
        return { success: false, message: srcResult.message, suggestion };
      }
      const suggestion = this.buildAmbiguousSuggestion(op.raw, targets[0], srcResult.shapes);
      return { success: false, message: srcResult.message, suggestion };
    }

    const tgtResult = resolveRef(targets[1], this.model.registry, this.model);
    if (tgtResult.kind !== "single") {
      if (tgtResult.kind === "none") {
        const suggestion = tgtResult.suggestedLabel
          ? this.buildTypoSuggestion(op.raw, targets[1], tgtResult.suggestedLabel)
          : undefined;
        return { success: false, message: tgtResult.message, suggestion };
      }
      const suggestion = this.buildAmbiguousSuggestion(op.raw, targets[1], tgtResult.shapes);
      return { success: false, message: tgtResult.message, suggestion };
    }

    const edge = this.model.findEdge(srcResult.shape.id, tgtResult.shape.id);
    if (!edge) {
      return { success: false, message: `No edge from ${targets[0]} to ${targets[1]}` };
    }

    this.model.removeEdge(edge.id);
    return { success: true, message: `-edge ${srcResult.shape.label}->${tgtResult.shape.label}` };
  }

  // ── Style ──────────────────────────────────────────────

  private handleStyle(op: ParsedOp): OpResult {
    if (!op.target) {
      return { success: false, message: "style requires a target" };
    }

    // Handle @group:NAME — style the group container, not members
    if (op.target.startsWith("@group:")) {
      const groupName = op.target.slice(7);
      const group = this.model.getGroupByName(groupName);
      if (!group) {
        return { success: false, message: `Unknown group "${groupName}"` };
      }

      // Apply style params to group.style
      let groupFontEnable = 0;
      let groupFontDisable = 0;
      for (const [key, value] of op.params) {
        switch (key) {
          case "fill": {
            const color = resolveColor(value);
            if (color) group.style.fillColor = color;
            break;
          }
          case "stroke": {
            const color = resolveColor(value);
            if (color) group.style.strokeColor = color;
            break;
          }
          case "font":
          case "font-color": {
            const color = resolveColor(value);
            if (color) group.style.fontColor = color;
            break;
          }
          case "font-size":
          case "fontSize":
            group.style.fontSize = parseInt(value, 10);
            break;
          case "opacity":
            group.style.opacity = parseInt(value, 10);
            break;
          case "rounded":
            group.style.rounded = value === "true" || value === "1";
            break;
          case "dashed":
            group.style.dashed = value === "true" || value === "1";
            break;
          case "shadow":
            group.style.shadow = value === "true" || value === "1";
            break;
          case "bold": groupFontEnable |= 1; break;
          case "no-bold": groupFontDisable |= 1; break;
          case "italic": groupFontEnable |= 2; break;
          case "no-italic": groupFontDisable |= 2; break;
          case "underline": groupFontEnable |= 4; break;
          case "no-underline": groupFontDisable |= 4; break;
          case "font-family":
            group.style.fontFamily = value;
            break;
          case "align":
            group.style.align = value;
            break;
          case "valign":
            group.style.verticalAlign = value;
            break;
          default:
            if (DRAWIO_PASSTHROUGH.has(key)) {
              (group.style as Record<string, unknown>)[key] = value;
            }
            break;
        }
      }
      if (groupFontEnable !== 0 || groupFontDisable !== 0) {
        const base = group.style.fontStyle ?? 0;
        group.style.fontStyle = (base | groupFontEnable) & ~groupFontDisable;
      }

      const propList = [...op.params.entries()]
        .filter(([k]) => k !== "theme")
        .map(([k, v]) => v === "true" ? k : `${k}:${v}`)
        .join(" ");

      return {
        success: true,
        message: `*styled group ${groupName} ${propList}`,
      };
    }

    const resolved = resolveRef(op.target, this.model.registry, this.model);
    if (resolved.kind === "none") {
      const suggestion = resolved.suggestedLabel
        ? this.buildTypoSuggestion(op.raw, op.target!, resolved.suggestedLabel)
        : undefined;
      return { success: false, message: resolved.message, suggestion };
    }

    // Ambiguous non-selector reference is an error
    const isSelector = op.target.startsWith("@");
    if (resolved.kind === "multiple" && !isSelector) {
      const suggestion = this.buildAmbiguousSuggestion(op.raw, op.target!, resolved.shapes);
      return { success: false, message: `error: ${resolved.message}`, suggestion };
    }

    const shapes = resolved.kind === "single" ? [resolved.shape] : resolved.shapes;

    // Map style params
    const styleChanges: Partial<import("../types/index.js").StyleSet> = {};

    // Handle theme param (built-in and custom)
    const themeParam = op.params.get("theme");
    if (themeParam) {
      const customTheme = this.model.diagram.customThemes.get(themeParam);
      if (customTheme) {
        styleChanges.fillColor = customTheme.fill;
        styleChanges.strokeColor = customTheme.stroke;
        if (customTheme.fontColor) styleChanges.fontColor = customTheme.fontColor;
      } else if (isThemeName(themeParam)) {
        const colors = resolveColor(themeParam);
        // resolveColor returns fill for theme name — use resolveTheme for full colors
        const themeColors = THEMES[themeParam as ThemeName];
        if (themeColors) {
          styleChanges.fillColor = themeColors.fill;
          styleChanges.strokeColor = themeColors.stroke;
          if (themeColors.fontColor) styleChanges.fontColor = themeColors.fontColor;
        }
      }
    }

    // Track fontStyle bitmask operations separately (applied per-shape)
    let fontStyleEnable = 0;
    let fontStyleDisable = 0;

    for (const [key, value] of op.params) {
      switch (key) {
        case "fill": {
          const color = resolveColor(value);
          if (color) styleChanges.fillColor = color;
          break;
        }
        case "stroke": {
          const color = resolveColor(value);
          if (color) styleChanges.strokeColor = color;
          break;
        }
        case "font":
        case "font-color": {
          const color = resolveColor(value);
          if (color) styleChanges.fontColor = color;
          break;
        }
        case "font-size":
        case "fontSize":
          styleChanges.fontSize = parseInt(value, 10);
          break;
        case "opacity":
          styleChanges.opacity = parseInt(value, 10);
          break;
        case "rounded":
          styleChanges.rounded = value === "true" || value === "1";
          break;
        case "dashed":
          styleChanges.dashed = value === "true" || value === "1";
          break;
        case "shadow":
          styleChanges.shadow = value === "true" || value === "1";
          break;
        // Text styling — bare boolean flags
        case "bold":
          fontStyleEnable |= 1;
          break;
        case "no-bold":
          fontStyleDisable |= 1;
          break;
        case "italic":
          fontStyleEnable |= 2;
          break;
        case "no-italic":
          fontStyleDisable |= 2;
          break;
        case "underline":
          fontStyleEnable |= 4;
          break;
        case "no-underline":
          fontStyleDisable |= 4;
          break;
        // Font family and alignment — key:value params
        case "font-family":
          styleChanges.fontFamily = value;
          break;
        case "align":
          styleChanges.align = value;
          break;
        case "valign":
          styleChanges.verticalAlign = value;
          break;
        default:
          // Passthrough: recognized draw.io properties not handled by FCP
          if (DRAWIO_PASSTHROUGH.has(key)) {
            (styleChanges as Record<string, unknown>)[key] = value;
          }
          break;
      }
    }

    const hasFontStyleOps = fontStyleEnable !== 0 || fontStyleDisable !== 0;

    let modifiedCount = 0;
    for (const shape of shapes) {
      const newStyle = { ...shape.style, ...styleChanges };
      // Apply fontStyle bitmask operations relative to each shape's existing value
      if (hasFontStyleOps) {
        const base = shape.style.fontStyle ?? 0;
        newStyle.fontStyle = (base | fontStyleEnable) & ~fontStyleDisable;
      }
      const result = this.model.modifyShape(shape.id, { style: newStyle });
      if (result) modifiedCount++;
    }

    const propList = [...op.params.entries()]
      .filter(([k]) => k !== "theme")
      .map(([k, v]) => v === "true" ? k : `${k}:${v}`)
      .join(" ");

    return {
      success: true,
      message: `*styled ${op.target} ${propList} (${modifiedCount} shape${modifiedCount !== 1 ? "s" : ""})`,
    };
  }

  // ── Remove ─────────────────────────────────────────────

  private handleRemove(op: ParsedOp): OpResult {
    if (!op.target) {
      return { success: false, message: "remove requires a target" };
    }

    const resolved = resolveRef(op.target, this.model.registry, this.model);
    if (resolved.kind === "none") {
      const suggestion = resolved.suggestedLabel
        ? this.buildTypoSuggestion(op.raw, op.target!, resolved.suggestedLabel)
        : undefined;
      return { success: false, message: resolved.message, suggestion };
    }

    const shapes = resolved.kind === "single" ? [resolved.shape] : resolved.shapes;
    const results: string[] = [];

    for (const shape of shapes) {
      const removed = this.model.removeShape(shape.id);
      if (removed) results.push(formatShapeDeleted(removed));
    }

    return { success: true, message: results.join("\n") };
  }

  // ── Label ──────────────────────────────────────────────

  private handleLabel(op: ParsedOp): OpResult {
    if (!op.target) {
      return { success: false, message: "label requires a target" };
    }

    const newText = op.params.get("text");
    if (!newText) {
      return { success: false, message: "label requires new text" };
    }

    // Edge form: label A -> B "text"
    if (op.targets && op.targets.length >= 2 && op.arrows && op.arrows.length > 0) {
      const srcResolved = resolveRef(op.targets[0], this.model.registry, this.model);
      if (srcResolved.kind !== "single") {
        return { success: false, message: srcResolved.message };
      }
      const tgtResolved = resolveRef(op.targets[1], this.model.registry, this.model);
      if (tgtResolved.kind !== "single") {
        return { success: false, message: tgtResolved.message };
      }

      const edge = this.model.findEdge(srcResolved.shape.id, tgtResolved.shape.id);
      if (!edge) {
        return { success: false, message: `No edge from ${op.targets[0]} to ${op.targets[1]}` };
      }

      const result = this.model.modifyEdge(edge.id, { label: newText });
      if (!result) {
        return { success: false, message: `Failed to relabel edge` };
      }

      return { success: true, message: `~${op.targets[0]}->${op.targets[1]} labeled "${newText}"` };
    }

    // Shape form: label REF "text"
    const resolved = resolveRef(op.target, this.model.registry, this.model);
    if (resolved.kind !== "single") {
      if (resolved.kind === "none") {
        const suggestion = resolved.suggestedLabel
          ? this.buildTypoSuggestion(op.raw, op.target!, resolved.suggestedLabel)
          : undefined;
        return { success: false, message: resolved.message, suggestion };
      }
      const suggestion = this.buildAmbiguousSuggestion(op.raw, op.target!, resolved.shapes);
      return { success: false, message: resolved.message, suggestion };
    }

    const result = this.model.modifyShape(resolved.shape.id, { label: newText });
    if (!result) {
      return { success: false, message: `Failed to relabel ${op.target}` };
    }

    return { success: true, message: formatShapeModified(result, `labeled "${newText}"`) };
  }

  // ── Badge ──────────────────────────────────────────────

  private handleBadge(op: ParsedOp): OpResult {
    if (!op.target) {
      return { success: false, message: "badge requires a target" };
    }

    const text = op.params.get("text");
    if (!text) {
      return { success: false, message: "badge requires text" };
    }

    const position = (op.params.get("pos") ?? "top-right") as Badge["position"];

    const resolved = resolveRef(op.target, this.model.registry, this.model);
    if (resolved.kind !== "single") {
      if (resolved.kind === "none") {
        const suggestion = resolved.suggestedLabel
          ? this.buildTypoSuggestion(op.raw, op.target!, resolved.suggestedLabel)
          : undefined;
        return { success: false, message: resolved.message, suggestion };
      }
      const suggestion = this.buildAmbiguousSuggestion(op.raw, op.target!, resolved.shapes);
      return { success: false, message: resolved.message, suggestion };
    }

    const shape = resolved.shape;
    const existingBadges = shape.metadata.badges ?? [];
    const newBadge: Badge = { text, position };
    const badges = [...existingBadges, newBadge];

    const result = this.model.modifyShape(shape.id, {
      metadata: { ...shape.metadata, badges },
    });

    if (!result) {
      return { success: false, message: `Failed to badge ${op.target}` };
    }

    return { success: true, message: formatShapeModified(result, `badge "${text}"`) };
  }

  // ── Move ───────────────────────────────────────────────

  private handleMove(op: ParsedOp): OpResult {
    if (!op.target) {
      return { success: false, message: "move requires a target" };
    }

    const strict = op.params.get("strict") === "true";

    // Handle @group:Name — move entire group
    if (op.target.startsWith("@group:")) {
      return this.handleMoveGroup(op, strict);
    }

    const resolved = resolveRef(op.target, this.model.registry, this.model);
    if (resolved.kind !== "single") {
      if (resolved.kind === "none") {
        const suggestion = resolved.suggestedLabel
          ? this.buildTypoSuggestion(op.raw, op.target!, resolved.suggestedLabel)
          : undefined;
        return { success: false, message: resolved.message, suggestion };
      }
      const suggestion = this.buildAmbiguousSuggestion(op.raw, op.target!, resolved.shapes);
      return { success: false, message: resolved.message, suggestion };
    }

    const shape = resolved.shape;
    let newX = shape.bounds.x;
    let newY = shape.bounds.y;

    // to:X,Y or to:region-name
    const toParam = op.params.get("to");
    if (toParam) {
      const regionPos = this.model.resolveCanvasRegion(toParam, {
        width: shape.bounds.width,
        height: shape.bounds.height,
      });
      if (regionPos) {
        newX = regionPos.x;
        newY = regionPos.y;
      } else {
        const parts = toParam.split(",");
        if (parts.length === 2) {
          newX = parseFloat(parts[0]);
          newY = parseFloat(parts[1]);
        }
      }
    }

    // near:REF dir:DIR — delegate to model's positioning logic
    const nearRef = op.params.get("near");
    if (nearRef) {
      const nearResolved = resolveRef(nearRef, this.model.registry, this.model);
      if (nearResolved.kind === "single") {
        const dir = op.params.get("dir") ?? "below";
        const pos = this.model.positionRelativeTo(
          nearResolved.shape.bounds,
          { width: shape.bounds.width, height: shape.bounds.height },
          dir,
        );
        newX = pos.x;
        newY = pos.y;
      }
    }

    const result = this.model.modifyShape(shape.id, {
      bounds: { ...shape.bounds, x: newX, y: newY },
    });

    if (!result) {
      return { success: false, message: `Failed to move ${op.target}` };
    }

    // Collision detection (unless strict mode)
    let shifted = 0;
    if (!strict) {
      shifted = this.model.detectAndResolveCollisions(shape.id, false);
    }

    const shiftNote = shifted > 0 ? ` (shifted ${shifted} item${shifted !== 1 ? "s" : ""})` : "";
    return { success: true, message: `@moved ${result.label} to (${newX},${newY})${shiftNote}` };
  }

  private handleMoveGroup(op: ParsedOp, strict: boolean): OpResult {
    const groupName = op.target!.slice(7); // strip "@group:"
    const group = this.model.getGroupByName(groupName);
    if (!group) {
      return { success: false, message: `Unknown group "${groupName}"` };
    }

    const toParam = op.params.get("to");
    if (!toParam) {
      return { success: false, message: "move @group requires to:X,Y or to:region" };
    }

    // Resolve target position for the group
    let targetX: number;
    let targetY: number;
    const regionPos = this.model.resolveCanvasRegion(toParam, {
      width: group.bounds.width,
      height: group.bounds.height,
    });
    if (regionPos) {
      targetX = regionPos.x;
      targetY = regionPos.y;
    } else {
      const parts = toParam.split(",");
      if (parts.length !== 2) {
        return { success: false, message: `Invalid move target: ${toParam}` };
      }
      targetX = parseFloat(parts[0]);
      targetY = parseFloat(parts[1]);
    }

    // Compute delta from current group bounds
    const dx = targetX - group.bounds.x;
    const dy = targetY - group.bounds.y;

    const page = this.model.getActivePage();
    let movedCount = 0;

    // Move all member shapes by the delta
    for (const memberId of group.memberIds) {
      const shape = page.shapes.get(memberId);
      if (shape) {
        this.model.modifyShape(shape.id, {
          bounds: { ...shape.bounds, x: shape.bounds.x + dx, y: shape.bounds.y + dy },
        });
        movedCount++;
      }
    }

    // Recompute group bounds
    this.model.recomputeGroupBoundsPublic(group.id);

    // Collision detection for the group
    let shifted = 0;
    if (!strict) {
      shifted = this.model.detectAndResolveCollisions(group.id, true);
    }

    const shiftNote = shifted > 0 ? ` (shifted ${shifted} item${shifted !== 1 ? "s" : ""})` : "";
    return {
      success: true,
      message: `@moved group ${groupName} (${movedCount} shapes)${shiftNote}`,
    };
  }

  // ── Resize ─────────────────────────────────────────────

  private handleResize(op: ParsedOp): OpResult {
    if (!op.target) {
      return { success: false, message: "resize requires a target" };
    }

    const resolved = resolveRef(op.target, this.model.registry, this.model);
    if (resolved.kind !== "single") {
      if (resolved.kind === "none") {
        const suggestion = resolved.suggestedLabel
          ? this.buildTypoSuggestion(op.raw, op.target!, resolved.suggestedLabel)
          : undefined;
        return { success: false, message: resolved.message, suggestion };
      }
      const suggestion = this.buildAmbiguousSuggestion(op.raw, op.target!, resolved.shapes);
      return { success: false, message: resolved.message, suggestion };
    }

    const shape = resolved.shape;
    const toParam = op.params.get("to");
    if (!toParam) {
      return { success: false, message: "resize requires to:WxH" };
    }

    const parts = toParam.toLowerCase().split("x");
    if (parts.length !== 2) {
      return { success: false, message: `Invalid size format: ${toParam}` };
    }

    const width = parseFloat(parts[0]);
    const height = parseFloat(parts[1]);

    const result = this.model.modifyShape(shape.id, {
      bounds: { ...shape.bounds, width, height },
    });

    if (!result) {
      return { success: false, message: `Failed to resize ${op.target}` };
    }

    return { success: true, message: `*resized ${result.label} to ${width}x${height}` };
  }

  // ── Swap ───────────────────────────────────────────────

  private handleSwap(op: ParsedOp): OpResult {
    const targets = op.targets;
    if (!targets || targets.length < 2) {
      return { success: false, message: "swap requires two targets" };
    }

    const r1 = resolveRef(targets[0], this.model.registry, this.model);
    const r2 = resolveRef(targets[1], this.model.registry, this.model);

    if (r1.kind !== "single") {
      if (r1.kind === "none") {
        const suggestion = r1.suggestedLabel
          ? this.buildTypoSuggestion(op.raw, targets[0], r1.suggestedLabel)
          : undefined;
        return { success: false, message: r1.message, suggestion };
      }
      const suggestion = this.buildAmbiguousSuggestion(op.raw, targets[0], r1.shapes);
      return { success: false, message: r1.message, suggestion };
    }
    if (r2.kind !== "single") {
      if (r2.kind === "none") {
        const suggestion = r2.suggestedLabel
          ? this.buildTypoSuggestion(op.raw, targets[1], r2.suggestedLabel)
          : undefined;
        return { success: false, message: r2.message, suggestion };
      }
      const suggestion = this.buildAmbiguousSuggestion(op.raw, targets[1], r2.shapes);
      return { success: false, message: r2.message, suggestion };
    }

    const bounds1 = { ...r1.shape.bounds };
    const bounds2 = { ...r2.shape.bounds };

    this.model.modifyShape(r1.shape.id, { bounds: bounds2 });
    this.model.modifyShape(r2.shape.id, { bounds: bounds1 });

    return {
      success: true,
      message: `@swapped ${r1.shape.label} <-> ${r2.shape.label}`,
    };
  }

  // ── Group ──────────────────────────────────────────────

  private handleGroup(op: ParsedOp): OpResult {
    const targets = op.targets;
    if (!targets || targets.length === 0) {
      return { success: false, message: "group requires targets" };
    }

    const name = op.params.get("as");
    if (!name) {
      return { success: false, message: "group requires as:NAME" };
    }

    // Resolve all targets to shape IDs
    const memberIds: string[] = [];
    for (const ref of targets) {
      const resolved = resolveRef(ref, this.model.registry, this.model);
      if (resolved.kind === "single") {
        memberIds.push(resolved.shape.id);
      } else if (resolved.kind === "multiple") {
        for (const s of resolved.shapes) {
          memberIds.push(s.id);
        }
      } else {
        const suggestion = resolved.suggestedLabel
          ? this.buildTypoSuggestion(op.raw, ref, resolved.suggestedLabel)
          : undefined;
        return { success: false, message: resolved.message, suggestion };
      }
    }

    const group = this.model.createGroup(name, memberIds);
    if (!group) {
      return { success: false, message: "Failed to create group" };
    }

    // Apply label: param as display name (group.name is used as XML value)
    const labelParam = op.params.get("label");
    if (labelParam) {
      group.name = labelParam.replace(/_/g, " ");
    }

    // Apply theme: param to group style
    const themeParam = op.params.get("theme");
    if (themeParam) {
      const customTheme = this.model.diagram.customThemes.get(themeParam);
      if (customTheme) {
        group.style.fillColor = customTheme.fill;
        group.style.strokeColor = customTheme.stroke;
        if (customTheme.fontColor) group.style.fontColor = customTheme.fontColor;
      } else if (isThemeName(themeParam)) {
        const colors = THEMES[themeParam as ThemeName];
        group.style.fillColor = colors.fill;
        group.style.strokeColor = colors.stroke;
        if (colors.fontColor) group.style.fontColor = colors.fontColor;
      }
    }

    return { success: true, message: formatGroupCreated(group) };
  }

  // ── Ungroup ────────────────────────────────────────────

  private handleUngroup(op: ParsedOp): OpResult {
    if (!op.target) {
      return { success: false, message: "ungroup requires a group name" };
    }

    const group = this.model.getGroupByName(op.target);
    if (!group) {
      return { success: false, message: `Unknown group "${op.target}"` };
    }

    const dissolved = this.model.dissolveGroup(group.id);
    if (!dissolved) {
      return { success: false, message: `Failed to ungroup "${op.target}"` };
    }

    return { success: true, message: `!ungrouped ${dissolved.name} (${dissolved.memberIds.size} shapes)` };
  }

  // ── Define ─────────────────────────────────────────────

  private handleDefine(op: ParsedOp): OpResult {
    if (!op.target) {
      return { success: false, message: "define requires a name" };
    }

    // Handle "define theme NAME fill:# stroke:#"
    if (op.target === "theme") {
      const themeName = op.targets && op.targets.length > 1 ? op.targets[1] : op.params.get("name");
      if (!themeName) {
        return { success: false, message: "define theme requires a name" };
      }
      const fill = op.params.get("fill");
      const stroke = op.params.get("stroke");
      if (!fill || !stroke) {
        return { success: false, message: "define theme requires fill:# and stroke:#" };
      }
      const fontColor = op.params.get("font-color");
      this.model.defineCustomTheme(themeName, fill, stroke, fontColor);
      return {
        success: true,
        message: `defined theme ${themeName} (${fill} / ${stroke}${fontColor ? ` font:${fontColor}` : ""})`,
      };
    }

    const baseName = op.params.get("base");
    if (!baseName || !isShapeType(baseName)) {
      return { success: false, message: `define requires base:TYPE (got "${baseName ?? "none"}")` };
    }

    const theme = op.params.get("theme") as ThemeName | undefined;
    const badge = op.params.get("badge");
    let size: { width: number; height: number } | undefined;
    const sizeParam = op.params.get("size");
    if (sizeParam) {
      const parts = sizeParam.toLowerCase().split("x");
      if (parts.length === 2) {
        size = { width: parseFloat(parts[0]), height: parseFloat(parts[1]) };
      }
    }

    const ct = this.model.defineCustomType(op.target, baseName, { theme, badge, size });
    return {
      success: true,
      message: `defined ${ct.name} (base:${ct.base}${ct.theme ? ` theme:${ct.theme}` : ""}${ct.badge ? ` badge:${ct.badge}` : ""})`,
    };
  }

  // ── Checkpoint ─────────────────────────────────────────

  private handleCheckpoint(op: ParsedOp): OpResult {
    if (!op.target) {
      return { success: false, message: "checkpoint requires a name" };
    }
    this.model.checkpoint(op.target);
    return { success: true, message: `checkpoint "${op.target}" created` };
  }

  // ── Title ──────────────────────────────────────────────

  private handleTitle(op: ParsedOp): OpResult {
    if (!op.target) {
      return { success: false, message: "title requires a name" };
    }
    this.model.setTitle(op.target);
    return { success: true, message: `title set to "${op.target}"` };
  }

  // ── Page ───────────────────────────────────────────────

  private handlePage(op: ParsedOp): OpResult {
    const sub = op.subcommand;
    if (!sub) {
      return { success: false, message: "page requires a subcommand" };
    }

    switch (sub) {
      case "add": {
        const name = op.target;
        if (!name) return { success: false, message: "page add requires a name" };
        const page = this.model.addPage(name);
        return { success: true, message: `+page ${page.name}` };
      }
      case "switch": {
        const name = op.target;
        if (!name) return { success: false, message: "page switch requires a name" };
        const page = this.model.switchPage(name);
        if (!page) return { success: false, message: `Unknown page "${name}"` };
        return { success: true, message: `switched to page ${page.name}` };
      }
      case "remove": {
        const name = op.target;
        if (!name) return { success: false, message: "page remove requires a name" };
        const ok = this.model.removePage(name);
        if (!ok) return { success: false, message: `Cannot remove page "${name}"` };
        return { success: true, message: `-page ${name}` };
      }
      case "list": {
        const activePage = this.model.getActivePage();
        const lines = this.model.diagram.pages.map((p) => {
          const markers: string[] = [];
          if (p.id === activePage.id) markers.push("active");
          markers.push(`${p.shapes.size} shapes`);
          markers.push(`${p.edges.size} edges`);
          const suffix = markers.length > 0 ? ` (${markers.join(", ")})` : "";
          return `  ${p.name}${suffix}`;
        });
        return { success: true, message: `pages:\n${lines.join("\n")}` };
      }
      case "duplicate": {
        // Stub — not implemented in model yet
        return { success: false, message: "page duplicate not yet implemented" };
      }
      default:
        return { success: false, message: `Unknown page subcommand "${sub}"` };
    }
  }

  // ── Layer ──────────────────────────────────────────────

  private handleLayer(op: ParsedOp): OpResult {
    const sub = op.subcommand;
    if (!sub) {
      return { success: false, message: "layer requires a subcommand" };
    }

    const page = this.model.getActivePage();

    switch (sub) {
      case "create": {
        const name = op.target;
        if (!name) return { success: false, message: "layer create requires a name" };
        this.model.addLayer(name);
        return { success: true, message: `+layer ${name}` };
      }
      case "show": {
        const name = op.target;
        if (!name) return { success: false, message: "layer show requires a name" };
        const layer = page.layers.find((l) => l.name === name);
        if (!layer) return { success: false, message: `Unknown layer "${name}"` };
        this.model.modifyLayer(layer.id, { visible: true });
        return { success: true, message: `layer ${name} visible` };
      }
      case "hide": {
        const name = op.target;
        if (!name) return { success: false, message: "layer hide requires a name" };
        const layer = page.layers.find((l) => l.name === name);
        if (!layer) return { success: false, message: `Unknown layer "${name}"` };
        this.model.modifyLayer(layer.id, { visible: false });
        return { success: true, message: `layer ${name} hidden` };
      }
      case "switch": {
        const name = op.target;
        if (!name) return { success: false, message: "layer switch requires a name" };
        const layer = page.layers.find((l) => l.name === name);
        if (!layer) return { success: false, message: `Unknown layer "${name}"` };
        page.defaultLayer = layer.id;
        return { success: true, message: `switched to layer ${name}` };
      }
      case "list": {
        const lines = page.layers.map((l) => {
          const markers: string[] = [];
          if (l.id === page.defaultLayer) markers.push("active");
          if (!l.visible) markers.push("hidden");
          if (l.locked) markers.push("locked");
          const suffix = markers.length > 0 ? ` (${markers.join(", ")})` : "";
          return `  ${l.name}${suffix}`;
        });
        return { success: true, message: `layers:\n${lines.join("\n")}` };
      }
      case "move": {
        // Stub for moving shapes between layers
        return { success: false, message: "layer move not yet implemented" };
      }
      default:
        return { success: false, message: `Unknown layer subcommand "${sub}"` };
    }
  }

  // ── Layout ─────────────────────────────────────────────

  private async handleLayout(op: ParsedOp): Promise<OpResult> {
    // Parse algorithm (default: layered)
    const algoParam = op.params.get("algo") ?? "layered";
    const validAlgos = new Set(["layered", "force", "tree"]);
    if (!validAlgos.has(algoParam)) {
      return { success: false, message: `Unknown algorithm "${algoParam}". Use: layered, force, tree` };
    }

    // Parse direction (default: TB)
    const dirParam = (op.params.get("dir") ?? "TB").toUpperCase();
    const validDirs = new Set(["TB", "LR", "BT", "RL"]);
    if (!validDirs.has(dirParam)) {
      return { success: false, message: `Unknown direction "${dirParam}". Use: TB, LR, BT, RL` };
    }

    // Parse spacing
    const spacing = op.params.has("spacing") ? parseInt(op.params.get("spacing")!, 10) : undefined;

    const options: LayoutOptions = {
      algorithm: algoParam as LayoutOptions["algorithm"],
      direction: dirParam as LayoutOptions["direction"],
      spacing,
    };

    try {
      const page = this.model.getActivePage();
      const result = await runElkLayout(page, options);
      const count = this.model.applyLayout(result);

      // Auto-set flow direction to match layout
      this.model.setFlowDirection(dirParam as import("../types/index.js").FlowDirection);

      return {
        success: true,
        message: `@layout ${algoParam} ${dirParam} — repositioned ${count} shapes`,
      };
    } catch (err: unknown) {
      return {
        success: false,
        message: `Layout failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ── Orient ─────────────────────────────────────────────

  private handleOrient(op: ParsedOp): OpResult {
    if (!op.target) {
      return { success: false, message: "orient requires a direction: TB, LR, BT, RL" };
    }

    const dir = op.target.toUpperCase();
    const validDirs = new Set(["TB", "LR", "BT", "RL"]);
    if (!validDirs.has(dir)) {
      return { success: false, message: `Unknown direction "${op.target}". Use: TB, LR, BT, RL` };
    }

    this.model.setFlowDirection(dir as import("../types/index.js").FlowDirection);
    return { success: true, message: `@orient ${dir}` };
  }

  // ── Load (stencil packs) ────────────────────────────────

  private handleLoad(op: ParsedOp): OpResult {
    const target = op.target?.toLowerCase();
    if (!target) {
      return { success: false, message: "load requires a target: use 'load list' or 'load PACK'" };
    }

    // load list — show available packs
    if (target === "list") {
      const packs = listStencilPacks();
      const lines = packs.map(p => {
        const loaded = this.model.diagram.loadedStencilPacks.has(p.id) ? " (loaded)" : "";
        return `  ${p.id.padEnd(8)} ${p.name} (${p.entryCount} types)${loaded}`;
      });
      return {
        success: true,
        message: "Available stencil packs:\n" + lines.join("\n"),
      };
    }

    // load PACK — activate a stencil pack
    const pack = getStencilPack(target);
    if (!pack) {
      const available = listStencilPacks().map(p => p.id).join(", ");
      return {
        success: false,
        message: `Unknown stencil pack "${target}". Available: ${available}`,
      };
    }

    // Check if already loaded
    if (this.model.diagram.loadedStencilPacks.has(target)) {
      return { success: true, message: `Stencil pack "${pack.name}" is already loaded` };
    }

    // Register entries (first-loaded wins on conflicts)
    let newEntries = 0;
    for (const entry of pack.entries) {
      if (!this.loadedStencilEntries.has(entry.id)) {
        this.loadedStencilEntries.set(entry.id, entry);
        newEntries++;
      }
    }

    this.model.diagram.loadedStencilPacks.add(target);

    // Build category summary
    const categories = new Map<string, string[]>();
    for (const entry of pack.entries) {
      const cat = categories.get(entry.category) ?? [];
      cat.push(entry.id);
      categories.set(entry.category, cat);
    }

    const catLines = [...categories.entries()].map(
      ([cat, ids]) => `  ${cat}: ${ids.join(", ")}`
    );

    return {
      success: true,
      message: `Loaded "${pack.name}" (${newEntries} types)\n${catLines.join("\n")}`,
    };
  }

}

