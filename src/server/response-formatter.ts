import type { Shape, Edge, Group, Bounds, ThemeName } from "../types/index.js";
import type { DiagramModel } from "../model/diagram-model.js";
import { THEMES } from "../lib/themes.js";

/**
 * Reverse-lookup a theme name from a fill color.
 */
function reverseThemeLookup(fillColor: string | null): string | null {
  if (!fillColor) return null;
  for (const [name, colors] of Object.entries(THEMES)) {
    if (colors.fill === fillColor) return name;
  }
  return null;
}

/**
 * Format a shape creation confirmation.
 * Example: "+svc AuthService @(120,200 140x60) blue"
 */
export function formatShapeCreated(shape: Shape): string {
  const theme = reverseThemeLookup(shape.style.fillColor);
  const pos = `@(${shape.bounds.x},${shape.bounds.y} ${shape.bounds.width}x${shape.bounds.height})`;
  const parts = [`+${shape.type}`, shape.label, pos];
  if (theme) parts.push(theme);
  return parts.join(" ");
}

/**
 * Format an edge creation confirmation.
 * Example: '~AuthService->UserDB "queries" dashed'
 */
export function formatEdgeCreated(edge: Edge, sourceLabel: string, targetLabel: string): string {
  const parts = [`~${sourceLabel}->${targetLabel}`];
  if (edge.label) parts.push(`"${edge.label}"`);
  if (edge.style.dotted) parts.push("dotted");
  else if (edge.style.dashed) parts.push("dashed");
  if (edge.style.curved) parts.push("curved");
  if (edge.style.flowAnimation) parts.push("animated");
  return parts.join(" ");
}

/**
 * Format a shape modification confirmation.
 * Example: "*styled AuthService fill:red (1 shape)"
 */
export function formatShapeModified(shape: Shape, what: string): string {
  return `*${what} ${shape.label}`;
}

/**
 * Format a shape deletion confirmation.
 * Example: "-AuthService"
 */
export function formatShapeDeleted(shape: Shape): string {
  return `-${shape.label}`;
}

/**
 * Format a group creation confirmation.
 * Example: "!group Backend (3 shapes)"
 */
export function formatGroupCreated(group: Group): string {
  return `!group ${group.name} (${group.memberIds.size} shapes)`;
}

/**
 * Format a full status output (Tier 3).
 */
export function formatStatus(model: DiagramModel): string {
  const d = model.diagram;
  const page = model.getActivePage();
  const shapeCount = page.shapes.size;
  const edgeCount = page.edges.size;
  const groupCount = page.groups.size;
  const opCount = model.eventLog.length;
  const checkpointCount = model.eventLog.checkpointCount;
  const savedState = d.filePath ? `saved: ${d.filePath}` : "unsaved";

  const lines: string[] = [];
  lines.push(`status: "${d.title}" (${savedState}, ${opCount} ops, ${checkpointCount} checkpoints)`);
  lines.push(`  page: ${page.name} (${shapeCount} shapes, ${edgeCount} edges, ${groupCount} groups)`);

  // Group shapes by their group membership
  const grouped = new Map<string, Shape[]>();
  const ungrouped: Shape[] = [];
  for (const shape of page.shapes.values()) {
    if (shape.parentGroup) {
      const group = page.groups.get(shape.parentGroup);
      const groupName = group?.name ?? "Unknown";
      const list = grouped.get(groupName) ?? [];
      list.push(shape);
      grouped.set(groupName, list);
    } else {
      ungrouped.push(shape);
    }
  }

  for (const [groupName, shapes] of grouped) {
    const shapeList = shapes.map((s) => `${s.label}(${s.type})`).join(", ");
    lines.push(`    ${groupName}: ${shapeList}`);
  }

  if (ungrouped.length > 0) {
    const shapeList = ungrouped.map((s) => `${s.label}(${s.type})`).join(", ");
    lines.push(`    Ungrouped: ${shapeList}`);
  }

  // Checkpoints
  if (checkpointCount > 0) {
    const cpEntries: string[] = [];
    for (const [name, idx] of model.eventLog.getCheckpoints()) {
      cpEntries.push(`"${name}" @op:${idx}`);
    }
    lines.push(`  checkpoints: ${cpEntries.join(", ")}`);
  }

  return lines.join("\n");
}

/**
 * Format a list of shapes.
 */
export function formatList(shapes: Shape[]): string {
  if (shapes.length === 0) return "No shapes on this page.";
  return shapes.map((s) => `${s.label}(${s.type})`).join("\n");
}

/**
 * Format connections for a shape.
 */
export function formatConnections(
  shape: Shape,
  incoming: Edge[],
  outgoing: Edge[],
  model: DiagramModel,
): string {
  const page = model.getActivePage();
  const lines: string[] = [];
  lines.push(`connections for ${shape.label}:`);

  if (outgoing.length > 0) {
    const targets = outgoing.map((e) => {
      const target = page.shapes.get(e.targetId);
      const label = target?.label ?? e.targetId;
      return e.label ? `${label}("${e.label}")` : label;
    });
    lines.push(`  out: ${targets.join(", ")}`);
  } else {
    lines.push("  out: (none)");
  }

  if (incoming.length > 0) {
    const sources = incoming.map((e) => {
      const source = page.shapes.get(e.sourceId);
      const label = source?.label ?? e.sourceId;
      return e.label ? `${label}("${e.label}")` : label;
    });
    lines.push(`  in: ${sources.join(", ")}`);
  } else {
    lines.push("  in: (none)");
  }

  return lines.join("\n");
}

/**
 * Format a shape description (full details).
 */
export function formatDescribe(shape: Shape, model: DiagramModel): string {
  const page = model.getActivePage();
  const theme = reverseThemeLookup(shape.style.fillColor);
  const lines: string[] = [];
  lines.push(`${shape.label} (${shape.type})`);
  lines.push(`  position: (${shape.bounds.x}, ${shape.bounds.y})`);
  lines.push(`  size: ${shape.bounds.width}x${shape.bounds.height}`);
  if (theme) lines.push(`  theme: ${theme}`);
  if (shape.style.fillColor) lines.push(`  fill: ${shape.style.fillColor}`);
  if (shape.style.strokeColor) lines.push(`  stroke: ${shape.style.strokeColor}`);
  if (shape.parentGroup) {
    const group = page.groups.get(shape.parentGroup);
    if (group) lines.push(`  group: ${group.name}`);
  }
  if (shape.metadata.badges && shape.metadata.badges.length > 0) {
    lines.push(`  badges: ${shape.metadata.badges.map((b) => b.text).join(", ")}`);
  }
  const layer = page.layers.find((l) => l.id === shape.layer);
  if (layer) lines.push(`  layer: ${layer.name}`);
  return lines.join("\n");
}

/**
 * Format stats summary.
 */
export function formatStats(model: DiagramModel): string {
  const page = model.getActivePage();
  const lines: string[] = [];
  lines.push(`shapes: ${page.shapes.size}`);
  lines.push(`edges: ${page.edges.size}`);
  lines.push(`groups: ${page.groups.size}`);
  lines.push(`pages: ${model.diagram.pages.length}`);
  return lines.join(", ");
}

/**
 * Format history events.
 */
export function formatHistory(events: import("../types/index.js").DiagramEvent[]): string {
  if (events.length === 0) return "No history.";
  return events.map((e) => {
    switch (e.type) {
      case "shape_created": return `+${e.shape.type} ${e.shape.label}`;
      case "shape_modified": return `*modified ${e.id}`;
      case "shape_deleted": return `-${e.shape.label}`;
      case "edge_created": return `~edge ${e.edge.sourceId}->${e.edge.targetId}`;
      case "edge_modified": return `~modified edge ${e.id}`;
      case "edge_deleted": return `-edge ${e.edge.sourceId}->${e.edge.targetId}`;
      case "group_created": return `!group ${e.group.name}`;
      case "group_modified": return `!modified group ${e.id}`;
      case "group_dissolved": return `!ungroup ${e.group.name}`;
      case "page_added": return `+page ${e.page.name}`;
      case "page_removed": return `-page ${e.page.name}`;
    }
  }).join("\n");
}

// ── Spatial region classification ────────────────────────────

type RegionRow = "top" | "middle" | "bottom";
type RegionCol = "left" | "center" | "right";
type Region = `${RegionRow}-${RegionCol}`;

function classifyRegion(cx: number, cy: number, canvas: Bounds): Region {
  const thirdW = canvas.width / 3;
  const thirdH = canvas.height / 3;
  const rx = cx - canvas.x;
  const ry = cy - canvas.y;

  const col: RegionCol = rx < thirdW ? "left" : rx < thirdW * 2 ? "center" : "right";
  const row: RegionRow = ry < thirdH ? "top" : ry < thirdH * 2 ? "middle" : "bottom";
  return `${row}-${col}`;
}

/**
 * Infer the dominant flow direction from edge source→target positions.
 * Returns TB/LR/BT/RL or null if undetermined.
 */
function inferFlowDirection(model: DiagramModel): string | null {
  const page = model.getActivePage();
  if (page.edges.size === 0) return null;

  let downCount = 0, upCount = 0, rightCount = 0, leftCount = 0;

  for (const edge of page.edges.values()) {
    const src = page.shapes.get(edge.sourceId);
    const tgt = page.shapes.get(edge.targetId);
    if (!src || !tgt) continue;

    const srcCy = src.bounds.y + src.bounds.height / 2;
    const tgtCy = tgt.bounds.y + tgt.bounds.height / 2;
    const srcCx = src.bounds.x + src.bounds.width / 2;
    const tgtCx = tgt.bounds.x + tgt.bounds.width / 2;

    const dy = tgtCy - srcCy;
    const dx = tgtCx - srcCx;

    if (Math.abs(dy) > Math.abs(dx)) {
      if (dy > 0) downCount++;
      else upCount++;
    } else {
      if (dx > 0) rightCount++;
      else leftCount++;
    }
  }

  const max = Math.max(downCount, upCount, rightCount, leftCount);
  if (max === 0) return null;
  if (max === downCount) return "TB";
  if (max === rightCount) return "LR";
  if (max === upCount) return "BT";
  return "RL";
}

/**
 * Format a spatial map of the diagram.
 * Compact summary: canvas size, flow direction, groups with positions, ungrouped shapes.
 */
export function formatMap(model: DiagramModel): string {
  const page = model.getActivePage();
  const canvas = model.computeCanvasBounds();

  if (!canvas || page.shapes.size === 0) {
    return "map: empty diagram";
  }

  const flow = page.flowDirection ?? inferFlowDirection(model) ?? "TB";
  const canvasW = Math.round(canvas.width);
  const canvasH = Math.round(canvas.height);

  const lines: string[] = [];
  lines.push(`map: ${canvasW}x${canvasH} flow:${flow} | ${page.shapes.size}s ${page.edges.size}e ${page.groups.size}g`);

  // Collect grouped shapes
  const groupedShapeIds = new Set<string>();
  const groupEntries: { group: Group; shapes: Shape[]; region: Region; sortY: number; sortX: number }[] = [];

  for (const group of page.groups.values()) {
    const members: Shape[] = [];
    for (const id of group.memberIds) {
      const shape = page.shapes.get(id);
      if (shape) {
        members.push(shape);
        groupedShapeIds.add(id);
      }
    }
    const gcx = group.bounds.x + group.bounds.width / 2;
    const gcy = group.bounds.y + group.bounds.height / 2;
    const region = classifyRegion(gcx, gcy, canvas);

    groupEntries.push({
      group,
      shapes: members,
      region,
      sortY: group.bounds.y,
      sortX: group.bounds.x,
    });
  }

  // Collect ungrouped shapes
  const ungrouped: Shape[] = [];
  for (const shape of page.shapes.values()) {
    if (!groupedShapeIds.has(shape.id)) {
      ungrouped.push(shape);
    }
  }

  // Sort: flow-aware (TB = sort by y then x, LR = sort by x then y)
  const isVertical = flow === "TB" || flow === "BT";
  const sortFn = isVertical
    ? (a: { sortY: number; sortX: number }, b: { sortY: number; sortX: number }) => a.sortY - b.sortY || a.sortX - b.sortX
    : (a: { sortY: number; sortX: number }, b: { sortY: number; sortX: number }) => a.sortX - b.sortX || a.sortY - b.sortY;

  groupEntries.sort(sortFn);

  // Format groups
  for (const entry of groupEntries) {
    const g = entry.group;
    const b = g.bounds;
    lines.push("");
    lines.push(`  [${g.name}] ${entry.region} (${Math.round(b.x)},${Math.round(b.y)})-(${Math.round(b.x + b.width)},${Math.round(b.y + b.height)})`);

    // Sort member shapes by position
    const sorted = [...entry.shapes].sort((a, b2) =>
      isVertical
        ? a.bounds.y - b2.bounds.y || a.bounds.x - b2.bounds.x
        : a.bounds.x - b2.bounds.x || a.bounds.y - b2.bounds.y
    );

    // Format members as pipe-separated rows
    const memberStrs = sorted.map(
      (s) => `${s.label}(${s.type}) @(${Math.round(s.bounds.x)},${Math.round(s.bounds.y)})`
    );
    // Group into rows of up to 3 for readability
    for (let i = 0; i < memberStrs.length; i += 3) {
      const row = memberStrs.slice(i, i + 3).join(" | ");
      lines.push(`    ${row}`);
    }
  }

  // Format ungrouped shapes
  if (ungrouped.length > 0) {
    const sortedUngrouped = [...ungrouped].sort((a, b2) =>
      isVertical
        ? a.bounds.y - b2.bounds.y || a.bounds.x - b2.bounds.x
        : a.bounds.x - b2.bounds.x || a.bounds.y - b2.bounds.y
    );

    if (groupEntries.length > 0) lines.push("");
    for (const s of sortedUngrouped) {
      lines.push(`  ${s.label}(${s.type}) @(${Math.round(s.bounds.x)},${Math.round(s.bounds.y)}) — ungrouped`);
    }
  }

  return lines.join("\n");
}
