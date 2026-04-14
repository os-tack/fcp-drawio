import type { VerbSpec } from "@ostk-ai/fcp-core";

/**
 * All verb specifications for the drawio FCP domain.
 * Used for reference card generation and verb validation.
 */
export const DRAWIO_VERB_SPECS: VerbSpec[] = [
  // ── Shapes ────────────────────────────────────────────────
  {
    verb: "add",
    syntax: "add TYPE LABEL [theme:T] [near:REF dir:DIR] [at:X,Y] [size:WxH] [label:\"Display Name\"]",
    category: "shapes",
    params: ["theme", "near", "dir", "at", "size", "label", "in", "count"],
    description: "Add a shape to the diagram",
  },
  {
    verb: "remove",
    syntax: "remove REF | remove @SELECTOR",
    category: "shapes",
    description: "Remove a shape or shapes matching a selector",
  },
  {
    verb: "define",
    syntax: "define NAME base:TYPE [theme:T] [badge:\"text\"] [size:WxH]",
    category: "shapes",
    params: ["base", "theme", "badge", "size", "name", "fill", "stroke", "font-color"],
    description: "Define a custom type or theme",
  },

  // ── Connections ────────────────────────────────────────────
  {
    verb: "connect",
    syntax: "connect SRC ARROW TGT [label:\"text\"] [style:STYLE] [exit:FACE entry:FACE]",
    category: "connections",
    params: ["label", "style", "exit", "entry", "source-arrow", "target-arrow"],
    description: "Connect two shapes with an edge",
  },
  {
    verb: "disconnect",
    syntax: "disconnect SRC -> TGT",
    category: "connections",
    description: "Remove an edge between two shapes",
  },

  // ── Appearance ─────────────────────────────────────────────
  {
    verb: "style",
    syntax: "style REF [fill:#HEX] [stroke:#HEX] [font:#HEX] [fontSize:N] [bold] [italic]",
    category: "appearance",
    params: ["fill", "stroke", "font", "font-color", "fontSize", "font-size", "opacity", "rounded", "dashed", "shadow", "font-family", "align", "valign", "theme"],
    description: "Change style properties of a shape or selector",
  },
  {
    verb: "label",
    syntax: "label REF \"new text\" | label SRC -> TGT \"new text\"",
    category: "appearance",
    description: "Rename a shape or relabel an edge",
  },
  {
    verb: "badge",
    syntax: "badge REF \"text\" [pos:POSITION]",
    category: "appearance",
    params: ["pos"],
    description: "Add a badge to a shape",
  },

  // ── Position ───────────────────────────────────────────────
  {
    verb: "move",
    syntax: "move REF to:X,Y | to:REGION | near:REF dir:DIR",
    category: "position",
    params: ["to", "near", "dir", "strict"],
    description: "Move a shape or group",
  },
  {
    verb: "resize",
    syntax: "resize REF to:WxH",
    category: "position",
    params: ["to"],
    description: "Resize a shape",
  },
  {
    verb: "swap",
    syntax: "swap REF REF",
    category: "position",
    description: "Exchange positions of two shapes",
  },
  {
    verb: "layout",
    syntax: "layout @all algo:layered|force|tree dir:TB|LR|BT|RL [spacing:N]",
    category: "position",
    params: ["algo", "dir", "spacing"],
    description: "Apply automatic layout to the diagram",
  },
  {
    verb: "orient",
    syntax: "orient TB|LR|BT|RL",
    category: "position",
    description: "Set the page flow direction",
  },

  // ── Organization ───────────────────────────────────────────
  {
    verb: "group",
    syntax: "group REF REF ... as:\"Group Name\"",
    category: "organization",
    params: ["as", "label", "theme"],
    description: "Group shapes together",
  },
  {
    verb: "ungroup",
    syntax: "ungroup \"Group Name\"",
    category: "organization",
    description: "Dissolve a group",
  },

  // ── Pages & Layers ─────────────────────────────────────────
  {
    verb: "page",
    syntax: "page add|switch|remove|list \"Name\"",
    category: "structure",
    description: "Manage diagram pages",
  },
  {
    verb: "layer",
    syntax: "layer create|switch|show|hide|list \"Name\"",
    category: "structure",
    description: "Manage diagram layers",
  },

  // ── Meta ───────────────────────────────────────────────────
  {
    verb: "checkpoint",
    syntax: "checkpoint NAME",
    category: "meta",
    description: "Create a named snapshot for undo",
  },
  {
    verb: "title",
    syntax: "title \"Diagram Title\"",
    category: "meta",
    description: "Set the diagram title",
  },
  {
    verb: "load",
    syntax: "load list | load PACK",
    category: "meta",
    params: [],
    description: "Load a stencil pack (aws, azure, gcp, k8s, cisco, ibm)",
  },

  // ── Visual ──────────────────────────────────────────────────
  {
    verb: "export",
    syntax: "export [inline|file] [fmt:png|svg|pdf] [width:N] [height:N] [page:N] [as:PATH]",
    category: "visual",
    params: ["fmt", "width", "height", "page", "as"],
    description: "Export diagram to PNG/SVG/PDF, inline or to file",
  },
];