// ── Shape Types ──────────────────────────────────────────────

export type ShapeType =
  | "box"
  | "svc"
  | "circle"
  | "decision"
  | "db"
  | "api"
  | "cloud"
  | "actor"
  | "doc"
  | "queue"
  | "triangle"
  | "process";

export type ArrowType =
  | "arrow"
  | "open-arrow"
  | "diamond"
  | "circle"
  | "crow-foot"
  | "none";

export type EdgeStyleType =
  | "solid"
  | "dashed"
  | "dotted"
  | "animated"
  | "thick"
  | "curved"
  | "orthogonal";

export type ArrowOperator = "->" | "<->" | "--";

export type Direction =
  | "above"
  | "below"
  | "left"
  | "right"
  | "above-left"
  | "above-right"
  | "below-left"
  | "below-right";

export type FlowDirection = "TB" | "LR" | "BT" | "RL";

export type ThemeName =
  | "blue"
  | "green"
  | "red"
  | "yellow"
  | "orange"
  | "purple"
  | "gray"
  | "dark"
  | "white";

// ── Geometry ─────────────────────────────────────────────────

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

// ── Styles ───────────────────────────────────────────────────

export interface StyleSet {
  fillColor: string | null;
  strokeColor: string | null;
  fontColor: string | null;
  fontSize: number | null;
  fontFamily: string | null;
  fontStyle: number | null; // bitmask: 1=bold, 2=italic, 4=underline
  rounded: boolean;
  dashed: boolean;
  shadow: boolean;
  opacity: number; // 0-100
  align: string | null; // left, center, right
  verticalAlign: string | null; // top, middle, bottom
  [key: string]: unknown;
}

export interface EdgeStyleSet extends StyleSet {
  edgeStyle: string;
  curved: boolean;
  flowAnimation: boolean;
  dotted: boolean;
}

// ── Theme ────────────────────────────────────────────────────

export interface ThemeColors {
  fill: string;
  stroke: string;
  fontColor?: string;
}

// ── Entities ─────────────────────────────────────────────────

export interface ShapeMetadata {
  tooltip?: string;
  badges?: Badge[];
  custom?: Record<string, unknown>;
}

export interface Badge {
  text: string;
  position: "top-left" | "top-right" | "bottom-left" | "bottom-right";
}

export interface Shape {
  id: string;
  label: string;
  type: ShapeType;
  bounds: Bounds;
  style: StyleSet;
  parentGroup: string | null;
  layer: string;
  metadata: ShapeMetadata;
  baseStyleOverride?: string;  // full draw.io style string from stencil packs
  alias?: string;  // Original target when label: override was used
  createdAt: number;
  modifiedAt: number;
}

export interface Edge {
  id: string;
  sourceId: string;
  targetId: string;
  label: string | null;
  style: EdgeStyleSet;
  waypoints: Point[];
  sourceArrow: ArrowType;
  targetArrow: ArrowType;
  createdAt: number;
  modifiedAt: number;
}

export interface Group {
  id: string;
  name: string;
  memberIds: Set<string>;
  isContainer: boolean;
  collapsed: boolean;
  bounds: Bounds;
  style: StyleSet;
}

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  order: number;
}

export interface Page {
  id: string;
  name: string;
  shapes: Map<string, Shape>;
  edges: Map<string, Edge>;
  groups: Map<string, Group>;
  layers: Layer[];
  defaultLayer: string;
  flowDirection?: FlowDirection;
}

export interface DiagramMetadata {
  host: string;
  modified: string;
  version: string;
}

export interface CustomType {
  name: string;
  base: ShapeType;
  theme?: ThemeName;
  badge?: string;
  defaultSize?: { width: number; height: number };
}

export interface CustomTheme {
  name: string;
  fill: string;
  stroke: string;
  fontColor?: string;
}

export interface Diagram {
  id: string;
  title: string;
  filePath: string | null;
  pages: Page[];
  activePage: string; // page ID
  customTypes: Map<string, CustomType>;
  customThemes: Map<string, CustomTheme>;
  loadedStencilPacks: Set<string>;
  metadata: DiagramMetadata;
}

// ── Events ───────────────────────────────────────────────────

// `pageId` records which page a shape/edge/group event happened on, so undo/
// redo can resolve the right page even if the active page has since changed
// (page switch itself emits no event). Optional for backward compatibility
// with hand-constructed events (e.g. in tests); reverseEvent/replayEvent fall
// back to the active page when absent.
export type DiagramEvent =
  | { type: "shape_created"; shape: Shape; pageId?: string }
  | { type: "shape_modified"; id: string; before: Partial<Shape>; after: Partial<Shape>; pageId?: string }
  | { type: "shape_deleted"; shape: Shape; pageId?: string }
  | { type: "edge_created"; edge: Edge; pageId?: string }
  | { type: "edge_modified"; id: string; before: Partial<Edge>; after: Partial<Edge>; pageId?: string }
  | { type: "edge_deleted"; edge: Edge; pageId?: string }
  | { type: "group_created"; group: Group; pageId?: string }
  | { type: "group_modified"; id: string; before: Partial<Group>; after: Partial<Group>; pageId?: string }
  | { type: "group_dissolved"; group: Group; pageId?: string }
  | { type: "page_added"; page: Page }
  | { type: "page_removed"; page: Page }
  | { type: "layer_created"; layer: Layer; pageId: string }
  | { type: "layer_modified"; pageId: string; layerId: string; before: Partial<Layer>; after: Partial<Layer> }
  | { type: "flow_direction_changed"; pageId: string; before: string | undefined; after: string }
  | { type: "title_changed"; before: string; after: string };

// ── Parser ───────────────────────────────────────────────────

export type Verb =
  | "add"
  | "remove"
  | "define"
  | "connect"
  | "disconnect"
  | "style"
  | "label"
  | "badge"
  | "move"
  | "resize"
  | "swap"
  | "layout"
  | "orient"
  | "group"
  | "ungroup"
  | "layer"
  | "page"
  | "checkpoint"
  | "title"
  | "load";

export interface KeyValue {
  key: string;
  value: string;
}

export interface ParsedOp {
  verb: Verb;
  raw: string;
  type?: string;        // node type for "add"
  target?: string;      // primary target label/ref
  targets?: string[];   // multiple targets (group, connect chain)
  arrows?: ArrowOperator[];  // for connect ops
  params: Map<string, string>;
  selector?: string;    // @type:X, @group:X, etc.
  subcommand?: string;  // for page/layer: "add", "switch", etc.
}

// ── Selectors ────────────────────────────────────────────────

export type SelectorType =
  | "type"
  | "group"
  | "connected"
  | "page"
  | "layer"
  | "recent"
  | "all"
  | "orphan";

export interface Selector {
  kind: SelectorType;
  value?: string; // e.g., "db" for @type:db, "3" for @recent:3
}

// ── Responses ────────────────────────────────────────────────

export interface OpResult {
  success: boolean;
  message: string;
  warnings?: string[];
  suggestion?: string;  // corrected operation string the LLM can retry
  image?: { base64: string; mimeType: string };
}

// ── Node Type Definition ─────────────────────────────────────

export interface NodeTypeDefinition {
  shorthand: ShapeType;
  drawioShape: string;        // the draw.io style "shape" value or base style
  baseStyle: string;          // full draw.io style string template
  defaultWidth: number;
  defaultHeight: number;
  description: string;
}
