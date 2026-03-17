import type {
  Diagram, Page, Shape, Edge, Group, Layer, Bounds, Point,
  StyleSet, EdgeStyleSet, ShapeType, ArrowType, ThemeName,
  DiagramEvent, CustomType, CustomTheme, Badge, FlowDirection,
} from "../types/index.js";
import { EventLog } from "@os-tack/fcp-core";
import { nextShapeId, nextEdgeId, nextGroupId, nextPageId, nextLayerId, nextSequence } from "./id.js";
import { createDefaultStyle, createDefaultEdgeStyle } from "./defaults.js";
import { ReferenceRegistry } from "./reference-registry.js";
import { NODE_TYPES, inferTypeFromLabel, computeDefaultSize } from "../lib/node-types.js";
import { THEMES, isThemeName } from "../lib/themes.js";
import { boundsOverlap, computePushVector, isDownstream } from "./spatial.js";

const DEFAULT_GAP = 60;
const FIRST_SHAPE_POS = { x: 200, y: 200 };

export class DiagramModel {
  diagram: Diagram;
  eventLog: EventLog<DiagramEvent>;
  registry: ReferenceRegistry;

  constructor() {
    this.eventLog = new EventLog<DiagramEvent>();
    this.registry = new ReferenceRegistry();
    this.diagram = this.createEmptyDiagram("Untitled");
  }

  // ── Diagram lifecycle ────────────────────────────────────

  createNew(title: string): void {
    this.diagram = this.createEmptyDiagram(title);
    this.eventLog = new EventLog<DiagramEvent>();
    this.rebuildRegistry();
  }

  private createEmptyDiagram(title: string): Diagram {
    const pageId = nextPageId();
    const layerId = nextLayerId();
    const page: Page = {
      id: pageId,
      name: "Page-1",
      shapes: new Map(),
      edges: new Map(),
      groups: new Map(),
      layers: [{ id: layerId, name: "Default", visible: true, locked: false, order: 0 }],
      defaultLayer: layerId,
    };
    return {
      id: crypto.randomUUID(),
      title,
      filePath: null,
      pages: [page],
      activePage: pageId,
      customTypes: new Map(),
      customThemes: new Map(),
      loadedStencilPacks: new Set(),
      metadata: {
        host: "fcp-drawio",
        modified: new Date().toISOString(),
        version: "0.2.0",
      },
    };
  }

  // ── Page access ──────────────────────────────────────────

  getActivePage(): Page {
    const page = this.diagram.pages.find((p) => p.id === this.diagram.activePage);
    if (!page) throw new Error("No active page");
    return page;
  }

  getPageByName(name: string): Page | undefined {
    return this.diagram.pages.find((p) => p.name === name);
  }

  switchPage(name: string): Page | null {
    const page = this.getPageByName(name);
    if (!page) return null;
    this.diagram.activePage = page.id;
    this.rebuildRegistry();
    return page;
  }

  addPage(name: string): Page {
    const layerId = nextLayerId();
    const page: Page = {
      id: nextPageId(),
      name,
      shapes: new Map(),
      edges: new Map(),
      groups: new Map(),
      layers: [{ id: layerId, name: "Default", visible: true, locked: false, order: 0 }],
      defaultLayer: layerId,
    };
    this.diagram.pages.push(page);
    this.emit({ type: "page_added", page });
    this.diagram.activePage = page.id;
    this.rebuildRegistry();
    return page;
  }

  removePage(name: string): boolean {
    if (this.diagram.pages.length <= 1) return false;
    const idx = this.diagram.pages.findIndex((p) => p.name === name);
    if (idx === -1) return false;
    const [removed] = this.diagram.pages.splice(idx, 1);
    this.emit({ type: "page_removed", page: removed });
    if (this.diagram.activePage === removed.id) {
      this.diagram.activePage = this.diagram.pages[0].id;
      this.rebuildRegistry();
    }
    return true;
  }

  // ── Shape CRUD ───────────────────────────────────────────

  addShape(
    label: string,
    type: ShapeType,
    options: {
      theme?: ThemeName;
      near?: string;      // shape ID to position near
      dir?: string;
      at?: Point;
      inGroup?: string;   // group ID
      size?: { width: number; height: number };
      baseStyleOverride?: string;   // full draw.io style from stencil
      skipDefaultTheme?: boolean;   // skip default "blue" theme (stencil colors)
    } = {},
  ): Shape {
    const page = this.getActivePage();
    const now = nextSequence();

    // Compute size
    const computedSize = options.size ?? computeDefaultSize(type, label);

    // Compute position
    const position = this.computePosition(page, options, computedSize);

    // Build style — skip default theme if stencil provides its own colors
    const effectiveTheme = options.skipDefaultTheme ? undefined : options.theme;
    const style = this.buildShapeStyle(type, effectiveTheme, options.skipDefaultTheme);

    const shape: Shape = {
      id: nextShapeId(),
      label,
      type,
      bounds: { x: position.x, y: position.y, width: computedSize.width, height: computedSize.height },
      style,
      parentGroup: options.inGroup ?? null,
      layer: page.defaultLayer,
      metadata: {},
      baseStyleOverride: options.baseStyleOverride,
      createdAt: now,
      modifiedAt: now,
    };

    page.shapes.set(shape.id, shape);

    // If placed in a group, add to group membership
    if (options.inGroup) {
      const group = page.groups.get(options.inGroup);
      if (group) {
        group.memberIds.add(shape.id);
        this.recomputeGroupBounds(group, page);
      }
    }

    this.emit({ type: "shape_created", shape });
    this.rebuildRegistry();
    return shape;
  }

  modifyShape(id: string, changes: Partial<Pick<Shape, "label" | "type" | "bounds" | "style" | "parentGroup" | "metadata" | "alias">>): Shape | null {
    const page = this.getActivePage();
    const shape = page.shapes.get(id);
    if (!shape) return null;

    const before: Partial<Shape> = {};
    const after: Partial<Shape> = {};

    for (const [key, value] of Object.entries(changes)) {
      if (value !== undefined) {
        (before as any)[key] = (shape as any)[key];
        (after as any)[key] = value;
        (shape as any)[key] = value;
      }
    }

    shape.modifiedAt = nextSequence();
    this.emit({ type: "shape_modified", id, before, after });
    this.rebuildRegistry();
    return shape;
  }

  removeShape(id: string): Shape | null {
    const page = this.getActivePage();
    const shape = page.shapes.get(id);
    if (!shape) return null;

    // Remove connected edges
    const edgesToRemove: string[] = [];
    for (const [edgeId, edge] of page.edges) {
      if (edge.sourceId === id || edge.targetId === id) {
        edgesToRemove.push(edgeId);
      }
    }
    for (const edgeId of edgesToRemove) {
      this.removeEdge(edgeId);
    }

    // Remove from group
    if (shape.parentGroup) {
      const group = page.groups.get(shape.parentGroup);
      if (group) {
        group.memberIds.delete(id);
        this.recomputeGroupBounds(group, page);
      }
    }

    page.shapes.delete(id);
    this.emit({ type: "shape_deleted", shape });
    this.rebuildRegistry();
    return shape;
  }

  // ── Edge CRUD ────────────────────────────────────────────

  addEdge(
    sourceId: string,
    targetId: string,
    options: {
      label?: string;
      style?: Partial<EdgeStyleSet>;
      sourceArrow?: ArrowType;
      targetArrow?: ArrowType;
    } = {},
  ): Edge | null {
    const page = this.getActivePage();
    if (!page.shapes.has(sourceId) || !page.shapes.has(targetId)) return null;

    const now = nextSequence();
    const edgeStyle = { ...createDefaultEdgeStyle(), ...options.style };

    const edge: Edge = {
      id: nextEdgeId(),
      sourceId,
      targetId,
      label: options.label ?? null,
      style: edgeStyle,
      waypoints: [],
      sourceArrow: options.sourceArrow ?? "none",
      targetArrow: options.targetArrow ?? "arrow",
      createdAt: now,
      modifiedAt: now,
    };

    page.edges.set(edge.id, edge);
    this.emit({ type: "edge_created", edge });
    this.rebuildRegistry();
    return edge;
  }

  removeEdge(id: string): Edge | null {
    const page = this.getActivePage();
    const edge = page.edges.get(id);
    if (!edge) return null;

    page.edges.delete(id);
    this.emit({ type: "edge_deleted", edge });
    this.rebuildRegistry();
    return edge;
  }

  modifyEdge(id: string, changes: Partial<Pick<Edge, "label" | "style" | "sourceArrow" | "targetArrow">>): Edge | null {
    const page = this.getActivePage();
    const edge = page.edges.get(id);
    if (!edge) return null;

    const before: Partial<Edge> = {};
    const after: Partial<Edge> = {};

    for (const [key, value] of Object.entries(changes)) {
      if (value !== undefined) {
        (before as any)[key] = (edge as any)[key];
        (after as any)[key] = value;
        (edge as any)[key] = value;
      }
    }

    edge.modifiedAt = nextSequence();
    this.emit({ type: "edge_modified", id, before, after });
    return edge;
  }

  findEdge(sourceId: string, targetId: string): Edge | undefined {
    const page = this.getActivePage();
    for (const edge of page.edges.values()) {
      if (edge.sourceId === sourceId && edge.targetId === targetId) return edge;
    }
    return undefined;
  }

  // ── Group operations ─────────────────────────────────────

  createGroup(name: string, memberIds: string[]): Group | null {
    const page = this.getActivePage();

    // Validate all members exist
    for (const id of memberIds) {
      if (!page.shapes.has(id)) return null;
    }

    const group: Group = {
      id: nextGroupId(),
      name,
      memberIds: new Set(memberIds),
      isContainer: true,
      collapsed: false,
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      style: createDefaultStyle(),
    };

    // Set parent group on each member
    for (const id of memberIds) {
      const shape = page.shapes.get(id)!;
      shape.parentGroup = group.id;
    }

    this.recomputeGroupBounds(group, page);
    page.groups.set(group.id, group);
    this.emit({ type: "group_created", group });
    this.rebuildRegistry();
    return group;
  }

  dissolveGroup(groupId: string): Group | null {
    const page = this.getActivePage();
    const group = page.groups.get(groupId);
    if (!group) return null;

    // Clear parent group from members
    for (const id of group.memberIds) {
      const shape = page.shapes.get(id);
      if (shape) shape.parentGroup = null;
    }

    page.groups.delete(groupId);
    this.emit({ type: "group_dissolved", group });
    this.rebuildRegistry();
    return group;
  }

  getGroupByName(name: string): Group | undefined {
    const page = this.getActivePage();
    for (const group of page.groups.values()) {
      if (group.name === name) return group;
    }
    return undefined;
  }

  // ── Layer CRUD ─────────────────────────────────────────

  addLayer(name: string): Layer {
    const page = this.getActivePage();
    const layer: Layer = {
      id: nextLayerId(),
      name,
      visible: true,
      locked: false,
      order: page.layers.length,
    };
    page.layers.push(layer);
    this.emit({ type: "layer_created", layer, pageId: page.id });
    return layer;
  }

  modifyLayer(layerId: string, changes: Partial<Pick<Layer, "visible" | "locked" | "name">>): Layer | null {
    const page = this.getActivePage();
    const layer = page.layers.find((l) => l.id === layerId);
    if (!layer) return null;

    const before: Partial<Layer> = {};
    const after: Partial<Layer> = {};

    for (const [key, value] of Object.entries(changes)) {
      if (value !== undefined) {
        (before as any)[key] = (layer as any)[key];
        (after as any)[key] = value;
        (layer as any)[key] = value;
      }
    }

    this.emit({ type: "layer_modified", pageId: page.id, layerId, before, after });
    return layer;
  }

  // ── Flow direction ─────────────────────────────────────

  setFlowDirection(dir: FlowDirection): void {
    const page = this.getActivePage();
    const before = page.flowDirection;
    page.flowDirection = dir;
    this.emit({ type: "flow_direction_changed", pageId: page.id, before, after: dir });
  }

  // ── Title ──────────────────────────────────────────────

  setTitle(title: string): void {
    const before = this.diagram.title;
    this.diagram.title = title;
    this.emit({ type: "title_changed", before, after: title });
  }

  // ── Custom types ─────────────────────────────────────────

  defineCustomType(name: string, base: ShapeType, options: { theme?: ThemeName; badge?: string; size?: { width: number; height: number } } = {}): CustomType {
    const ct: CustomType = {
      name,
      base,
      theme: options.theme,
      badge: options.badge,
      defaultSize: options.size,
    };
    this.diagram.customTypes.set(name, ct);
    return ct;
  }

  defineCustomTheme(name: string, fill: string, stroke: string, fontColor?: string): CustomTheme {
    const ct: CustomTheme = { name, fill, stroke, fontColor };
    this.diagram.customThemes.set(name, ct);
    return ct;
  }

  // ── Checkpoints and undo ─────────────────────────────────

  checkpoint(name: string): void {
    this.eventLog.checkpoint(name);
  }

  undo(count: number = 1): DiagramEvent[] {
    const events = this.eventLog.undo(count);
    for (const event of events) {
      this.reverseEvent(event);
    }
    this.rebuildRegistry();
    return events;
  }

  undoTo(checkpointName: string): DiagramEvent[] | null {
    const events = this.eventLog.undoTo(checkpointName);
    if (!events) return null;
    for (const event of events) {
      this.reverseEvent(event);
    }
    this.rebuildRegistry();
    return events;
  }

  redo(count: number = 1): DiagramEvent[] {
    const events = this.eventLog.redo(count);
    for (const event of events) {
      this.replayEvent(event);
    }
    this.rebuildRegistry();
    return events;
  }

  getHistory(count: number): DiagramEvent[] {
    return this.eventLog.recent(count);
  }

  canUndo(): boolean {
    return this.eventLog.canUndo();
  }

  canRedo(): boolean {
    return this.eventLog.canRedo();
  }

  /** Compact state digest for drift detection. */
  getDigest(): string {
    const page = this.getActivePage();
    const pageIdx = this.diagram.pages.findIndex(p => p.id === this.diagram.activePage) + 1;
    const totalPages = this.diagram.pages.length;
    const bounds = this.computeCanvasBounds();
    const canvasStr = bounds ? `${Math.round(bounds.width)}x${Math.round(bounds.height)} ` : "";
    return `[${page.shapes.size}s ${page.edges.size}e ${page.groups.size}g ${canvasStr}p:${pageIdx}/${totalPages}]`;
  }

  /** Compute the bounding box of all shapes and groups on the active page. */
  computeCanvasBounds(): Bounds | null {
    const page = this.getActivePage();
    if (page.shapes.size === 0) return null;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (const shape of page.shapes.values()) {
      minX = Math.min(minX, shape.bounds.x);
      minY = Math.min(minY, shape.bounds.y);
      maxX = Math.max(maxX, shape.bounds.x + shape.bounds.width);
      maxY = Math.max(maxY, shape.bounds.y + shape.bounds.height);
    }

    for (const group of page.groups.values()) {
      minX = Math.min(minX, group.bounds.x);
      minY = Math.min(minY, group.bounds.y);
      maxX = Math.max(maxX, group.bounds.x + group.bounds.width);
      maxY = Math.max(maxY, group.bounds.y + group.bounds.height);
    }

    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  /**
   * Resolve a named canvas region to absolute coordinates.
   * Regions: top-left, top-center, top-right, middle-left, center, middle-right,
   *          bottom-left, bottom-center, bottom-right
   * Centers the entity of given size within the region.
   */
  resolveCanvasRegion(
    region: string,
    entitySize: { width: number; height: number },
  ): Point | null {
    const canvas = this.computeCanvasBounds();
    if (!canvas) {
      // No shapes yet — place in a default 800x600 canvas
      return this.resolveRegionInBounds(
        { x: 0, y: 0, width: 800, height: 600 },
        region,
        entitySize,
      );
    }

    // Add margin around existing content
    const margin = 60;
    const expanded: Bounds = {
      x: canvas.x - margin,
      y: canvas.y - margin,
      width: canvas.width + margin * 2,
      height: canvas.height + margin * 2,
    };

    return this.resolveRegionInBounds(expanded, region, entitySize);
  }

  private resolveRegionInBounds(
    bounds: Bounds,
    region: string,
    entitySize: { width: number; height: number },
  ): Point | null {
    const thirdW = bounds.width / 3;
    const thirdH = bounds.height / 3;

    let col: number; // 0=left, 1=center, 2=right
    let row: number; // 0=top, 1=middle, 2=bottom

    switch (region) {
      case "top-left":      row = 0; col = 0; break;
      case "top-center":    row = 0; col = 1; break;
      case "top-right":     row = 0; col = 2; break;
      case "middle-left":   row = 1; col = 0; break;
      case "center":        row = 1; col = 1; break;
      case "middle-right":  row = 1; col = 2; break;
      case "bottom-left":   row = 2; col = 0; break;
      case "bottom-center": row = 2; col = 1; break;
      case "bottom-right":  row = 2; col = 2; break;
      default: return null;
    }

    // Center entity within the region cell
    const cellX = bounds.x + col * thirdW;
    const cellY = bounds.y + row * thirdH;
    return {
      x: Math.round(cellX + (thirdW - entitySize.width) / 2),
      y: Math.round(cellY + (thirdH - entitySize.height) / 2),
    };
  }

  /** Public wrapper for recomputing group bounds. */
  recomputeGroupBoundsPublic(groupId: string): void {
    const page = this.getActivePage();
    const group = page.groups.get(groupId);
    if (group) this.recomputeGroupBounds(group, page);
  }

  /**
   * Detect and resolve collisions after moving an entity.
   * Pushes overlapping downstream items in the flow direction.
   * Returns the number of items shifted.
   */
  detectAndResolveCollisions(
    entityId: string,
    isGroup: boolean,
    maxDepth: number = 5,
  ): number {
    const page = this.getActivePage();
    const flowDir = page.flowDirection ?? "TB";

    // Get the bounds of the moved entity
    let movedBounds: Bounds;
    if (isGroup) {
      const group = page.groups.get(entityId);
      if (!group) return 0;
      movedBounds = group.bounds;
    } else {
      const shape = page.shapes.get(entityId);
      if (!shape) return 0;
      movedBounds = shape.bounds;
    }

    // Collect spatial entities: ungrouped shapes + groups (as units)
    interface SpatialEntity {
      id: string;
      bounds: Bounds;
      isGroup: boolean;
    }

    const groupedShapeIds = new Set<string>();
    for (const group of page.groups.values()) {
      for (const id of group.memberIds) groupedShapeIds.add(id);
    }

    const entities: SpatialEntity[] = [];

    // Add ungrouped shapes (excluding the moved entity)
    for (const shape of page.shapes.values()) {
      if (groupedShapeIds.has(shape.id)) continue;
      if (!isGroup && shape.id === entityId) continue;
      entities.push({ id: shape.id, bounds: shape.bounds, isGroup: false });
    }

    // Add groups (excluding the moved group)
    for (const group of page.groups.values()) {
      if (isGroup && group.id === entityId) continue;
      entities.push({ id: group.id, bounds: group.bounds, isGroup: true });
    }

    // Ripple: push overlapping downstream entities
    let totalShifted = 0;
    const pushed = new Set<string>(); // track already-pushed IDs
    let waveBounds = [movedBounds]; // bounds that may cause ripple

    for (let depth = 0; depth < maxDepth && waveBounds.length > 0; depth++) {
      const nextWave: Bounds[] = [];

      for (const sourceBounds of waveBounds) {
        for (const entity of entities) {
          if (pushed.has(entity.id)) continue;
          if (!isDownstream(sourceBounds, entity.bounds, flowDir)) continue;
          if (!boundsOverlap(sourceBounds, entity.bounds)) continue;

          const push = computePushVector(sourceBounds, entity.bounds, flowDir);
          if (!push) continue;

          // Apply push
          if (entity.isGroup) {
            this.pushGroup(entity.id, push.dx, push.dy);
          } else {
            this.pushShape(entity.id, push.dx, push.dy);
          }

          pushed.add(entity.id);
          totalShifted++;

          // Update entity bounds for future iterations
          entity.bounds = {
            ...entity.bounds,
            x: entity.bounds.x + push.dx,
            y: entity.bounds.y + push.dy,
          };
          nextWave.push(entity.bounds);
        }
      }

      waveBounds = nextWave;
    }

    return totalShifted;
  }

  private pushShape(shapeId: string, dx: number, dy: number): void {
    const page = this.getActivePage();
    const shape = page.shapes.get(shapeId);
    if (!shape) return;

    const before = { bounds: { ...shape.bounds } };
    shape.bounds = { ...shape.bounds, x: shape.bounds.x + dx, y: shape.bounds.y + dy };
    shape.modifiedAt = nextSequence();
    this.emit({
      type: "shape_modified",
      id: shapeId,
      before,
      after: { bounds: { ...shape.bounds } },
    });
  }

  private pushGroup(groupId: string, dx: number, dy: number): void {
    const page = this.getActivePage();
    const group = page.groups.get(groupId);
    if (!group) return;

    // Move all member shapes
    for (const memberId of group.memberIds) {
      this.pushShape(memberId, dx, dy);
    }

    // Recompute group bounds
    this.recomputeGroupBounds(group, page);
  }

  // ── Layout application ──────────────────────────────────────

  /**
   * Apply an ELK layout result: update shape positions, edge waypoints, and recompute group bounds.
   * Emits shape_modified/edge_modified events for undo support.
   */
  applyLayout(result: {
    shapePositions: Map<string, { x: number; y: number }>;
    edgeWaypoints: Map<string, Point[]>;
  }): number {
    const page = this.getActivePage();
    let count = 0;

    // Update shape positions
    for (const [id, pos] of result.shapePositions) {
      const shape = page.shapes.get(id);
      if (shape) {
        const before = { bounds: { ...shape.bounds } };
        shape.bounds = { ...shape.bounds, x: pos.x, y: pos.y };
        shape.modifiedAt = nextSequence();
        this.emit({
          type: "shape_modified",
          id,
          before,
          after: { bounds: { ...shape.bounds } },
        });
        count++;
      }
    }

    // Update edge waypoints
    for (const [id, waypoints] of result.edgeWaypoints) {
      const edge = page.edges.get(id);
      if (edge && waypoints.length > 0) {
        const before = { waypoints: [...edge.waypoints] };
        edge.waypoints = waypoints;
        edge.modifiedAt = nextSequence();
        this.emit({
          type: "edge_modified",
          id,
          before,
          after: { waypoints: [...waypoints] },
        });
      }
    }

    // Recompute group bounds
    for (const [, group] of page.groups) {
      this.recomputeGroupBounds(group, page);
    }

    this.rebuildRegistry();
    return count;
  }

  // ── Position computation ─────────────────────────────────

  private computePosition(
    page: Page,
    options: { near?: string; dir?: string; at?: Point },
    size: { width: number; height: number },
  ): Point {
    // Absolute position
    if (options.at) return options.at;

    // Relative to another shape
    if (options.near) {
      const ref = page.shapes.get(options.near);
      if (ref) {
        return this.positionRelativeTo(ref.bounds, size, options.dir ?? "below");
      }
    }

    // Relative to most recent shape
    const recent = this.registry.getMostRecent(1);
    if (recent.length > 0) {
      return this.positionRelativeTo(recent[0].bounds, { width: size.width, height: size.height }, "below");
    }

    // First shape on empty page
    return FIRST_SHAPE_POS;
  }

  positionRelativeTo(
    ref: Bounds,
    size: { width: number; height: number },
    dir: string,
  ): Point {
    const gap = DEFAULT_GAP;
    const refCx = ref.x + ref.width / 2;
    const refCy = ref.y + ref.height / 2;

    switch (dir) {
      case "below":
        return { x: refCx - size.width / 2, y: ref.y + ref.height + gap };
      case "above":
        return { x: refCx - size.width / 2, y: ref.y - gap - size.height };
      case "right":
        return { x: ref.x + ref.width + gap, y: refCy - size.height / 2 };
      case "left":
        return { x: ref.x - gap - size.width, y: refCy - size.height / 2 };
      case "below-right":
        return { x: ref.x + ref.width + gap, y: ref.y + ref.height + gap };
      case "below-left":
        return { x: ref.x - gap - size.width, y: ref.y + ref.height + gap };
      case "above-right":
        return { x: ref.x + ref.width + gap, y: ref.y - gap - size.height };
      case "above-left":
        return { x: ref.x - gap - size.width, y: ref.y - gap - size.height };
      default:
        return { x: refCx - size.width / 2, y: ref.y + ref.height + gap };
    }
  }

  // ── Style building ───────────────────────────────────────

  private buildShapeStyle(type: ShapeType, theme?: ThemeName, skipDefaultTheme?: boolean): StyleSet {
    const style = createDefaultStyle();
    const typeDef = NODE_TYPES[type];

    if (typeDef && typeDef.baseStyle.includes("rounded=1")) {
      style.rounded = true;
    }

    // When using a stencil with no explicit theme, skip applying default "blue" theme
    // so stencil's embedded colors pass through
    if (skipDefaultTheme && !theme) {
      return style;
    }

    // Apply theme colors
    const themeName = theme ?? "blue";
    if (isThemeName(themeName)) {
      const colors = THEMES[themeName];
      style.fillColor = colors.fill;
      style.strokeColor = colors.stroke;
      if (colors.fontColor) style.fontColor = colors.fontColor;
    }

    return style;
  }

  // ── Group bounds ─────────────────────────────────────────

  private recomputeGroupBounds(group: Group, page: Page): void {
    const paddingX = 40;
    const paddingBottom = 35;
    const paddingTop = 50; // room for bold group label
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (const id of group.memberIds) {
      const shape = page.shapes.get(id);
      if (!shape) continue;
      minX = Math.min(minX, shape.bounds.x);
      minY = Math.min(minY, shape.bounds.y);
      maxX = Math.max(maxX, shape.bounds.x + shape.bounds.width);
      maxY = Math.max(maxY, shape.bounds.y + shape.bounds.height);
    }

    if (minX !== Infinity) {
      let width = maxX - minX + paddingX * 2;
      // Ensure minimum width so group label isn't truncated (~8px per char)
      const minLabelWidth = group.name.length * 9 + paddingX * 2;
      width = Math.max(width, minLabelWidth);

      group.bounds = {
        x: minX - paddingX,
        y: minY - paddingTop,
        width,
        height: maxY - minY + paddingTop + paddingBottom,
      };
    }
  }

  // ── Event handling ───────────────────────────────────────

  private emit(event: DiagramEvent): void {
    this.eventLog.append(event);
    this.diagram.metadata.modified = new Date().toISOString();
  }

  private reverseEvent(event: DiagramEvent): void {
    const page = this.getActivePage();
    switch (event.type) {
      case "shape_created":
        page.shapes.delete(event.shape.id);
        break;
      case "shape_deleted":
        page.shapes.set(event.shape.id, { ...event.shape });
        break;
      case "shape_modified": {
        const shape = page.shapes.get(event.id);
        if (shape) Object.assign(shape, event.before);
        break;
      }
      case "edge_created":
        page.edges.delete(event.edge.id);
        break;
      case "edge_deleted":
        page.edges.set(event.edge.id, { ...event.edge });
        break;
      case "edge_modified": {
        const edge = page.edges.get(event.id);
        if (edge) Object.assign(edge, event.before);
        break;
      }
      case "group_created":
        page.groups.delete(event.group.id);
        for (const id of event.group.memberIds) {
          const shape = page.shapes.get(id);
          if (shape) shape.parentGroup = null;
        }
        break;
      case "group_dissolved":
        page.groups.set(event.group.id, {
          ...event.group,
          memberIds: new Set(event.group.memberIds),
        });
        for (const id of event.group.memberIds) {
          const shape = page.shapes.get(id);
          if (shape) shape.parentGroup = event.group.id;
        }
        break;
      case "page_added": {
        const idx = this.diagram.pages.findIndex((p) => p.id === event.page.id);
        if (idx !== -1) this.diagram.pages.splice(idx, 1);
        break;
      }
      case "page_removed":
        this.diagram.pages.push(event.page);
        break;
      case "layer_created": {
        const p = this.diagram.pages.find((pg) => pg.id === event.pageId);
        if (p) {
          const idx = p.layers.findIndex((l) => l.id === event.layer.id);
          if (idx !== -1) p.layers.splice(idx, 1);
        }
        break;
      }
      case "layer_modified": {
        const p = this.diagram.pages.find((pg) => pg.id === event.pageId);
        if (p) {
          const layer = p.layers.find((l) => l.id === event.layerId);
          if (layer) Object.assign(layer, event.before);
        }
        break;
      }
      case "flow_direction_changed": {
        const p = this.diagram.pages.find((pg) => pg.id === event.pageId);
        if (p) p.flowDirection = event.before as import("../types/index.js").FlowDirection | undefined;
        break;
      }
      case "title_changed":
        this.diagram.title = event.before;
        break;
      case "checkpoint":
        // No-op for undo
        break;
    }
  }

  private replayEvent(event: DiagramEvent): void {
    const page = this.getActivePage();
    switch (event.type) {
      case "shape_created":
        page.shapes.set(event.shape.id, { ...event.shape });
        break;
      case "shape_deleted":
        page.shapes.delete(event.shape.id);
        break;
      case "shape_modified": {
        const shape = page.shapes.get(event.id);
        if (shape) Object.assign(shape, event.after);
        break;
      }
      case "edge_created":
        page.edges.set(event.edge.id, { ...event.edge });
        break;
      case "edge_deleted":
        page.edges.delete(event.edge.id);
        break;
      case "edge_modified": {
        const edge = page.edges.get(event.id);
        if (edge) Object.assign(edge, event.after);
        break;
      }
      case "group_created":
        page.groups.set(event.group.id, {
          ...event.group,
          memberIds: new Set(event.group.memberIds),
        });
        for (const id of event.group.memberIds) {
          const shape = page.shapes.get(id);
          if (shape) shape.parentGroup = event.group.id;
        }
        break;
      case "group_dissolved":
        page.groups.delete(event.group.id);
        for (const id of event.group.memberIds) {
          const shape = page.shapes.get(id);
          if (shape) shape.parentGroup = null;
        }
        break;
      case "page_added":
        this.diagram.pages.push(event.page);
        break;
      case "page_removed": {
        const idx = this.diagram.pages.findIndex((p) => p.id === event.page.id);
        if (idx !== -1) this.diagram.pages.splice(idx, 1);
        break;
      }
      case "layer_created": {
        const p = this.diagram.pages.find((pg) => pg.id === event.pageId);
        if (p) p.layers.push({ ...event.layer });
        break;
      }
      case "layer_modified": {
        const p = this.diagram.pages.find((pg) => pg.id === event.pageId);
        if (p) {
          const layer = p.layers.find((l) => l.id === event.layerId);
          if (layer) Object.assign(layer, event.after);
        }
        break;
      }
      case "flow_direction_changed": {
        const p = this.diagram.pages.find((pg) => pg.id === event.pageId);
        if (p) p.flowDirection = event.after as import("../types/index.js").FlowDirection;
        break;
      }
      case "title_changed":
        this.diagram.title = event.after;
        break;
      case "checkpoint":
        break;
    }
  }

  // ── Registry rebuild ─────────────────────────────────────

  rebuildRegistry(): void {
    this.registry.rebuild(this.getActivePage());
  }
}
