import type { FcpDomainAdapter, OpResult, QueryResult } from "@ostk-ai/fcp-core";
import { EventLog } from "@ostk-ai/fcp-core";
import type { ParsedOp } from "@ostk-ai/fcp-core";
import type { Diagram, DiagramEvent } from "./types/index.js";
import { DiagramModel } from "./model/diagram-model.js";
import { IntentLayer } from "./server/intent-layer.js";
import { serializeDiagram } from "./serialization/serialize.js";
import { deserializeDiagram } from "./serialization/deserialize.js";

/**
 * Bridge between the generic fcp-core ParsedOp (Record<string, string> params,
 * positionals array) and drawio's domain-specific ParsedOp (Map<string, string>
 * params, verb-specific fields like type, target, targets, arrows).
 *
 * The existing IntentLayer already has a full string-based dispatch pipeline
 * (string -> local parseOp -> domain ParsedOp -> handler). Rather than
 * rewriting the entire IntentLayer, this adapter delegates to it via the
 * original string-based path while satisfying the FcpDomainAdapter interface.
 */
export class DrawioAdapter implements FcpDomainAdapter<DiagramModel, DiagramEvent> {
  private intent: IntentLayer;

  constructor(options?: { drawioCliPath?: string | null }) {
    this.intent = new IntentLayer(options);
  }

  /** Access the intent layer (for direct interaction if needed). */
  get intentLayer(): IntentLayer {
    return this.intent;
  }

  createEmpty(title: string, _params: Record<string, string>): DiagramModel {
    // Use the intent layer's session handler to create the new diagram
    // This ensures the QueryHandler's model reference stays consistent
    this.intent.executeSession(`new "${title}"`);
    return this.intent.model;
  }

  serialize(model: DiagramModel): string {
    return serializeDiagram(model.diagram);
  }

  deserialize(data: Buffer | string): DiagramModel {
    const xml = typeof data === "string" ? data : data.toString("utf-8");
    const diagram = deserializeDiagram(xml);
    // Update the intent layer's model in-place to preserve QueryHandler reference
    this.intent.model.diagram = diagram;
    if (diagram.pages.length > 0) {
      this.intent.model.diagram.activePage = diagram.pages[0].id;
    }
    this.intent.model.rebuildRegistry();
    this.intent.restoreStencilPacks();
    return this.intent.model;
  }

  rebuildIndices(model: DiagramModel): void {
    model.rebuildRegistry();
  }

  getDigest(model: DiagramModel): string {
    return model.getDigest();
  }

  /**
   * Dispatch an operation. We use the raw string from the ParsedOp to feed
   * back through the existing IntentLayer pipeline, which has its own parser.
   * This avoids rewriting the entire IntentLayer to accept generic ParsedOps.
   */
  async dispatchOp(op: ParsedOp, _model: DiagramModel, _log: EventLog<DiagramEvent>): Promise<OpResult> {
    return this.intent.executeSingleOp(op.raw);
  }

  async dispatchQuery(query: string, _model: DiagramModel): Promise<string | QueryResult> {
    const result = this.intent.executeQuery(query);
    if (typeof result === "string") return result;
    return result as { text: string; image?: { base64: string; mimeType: string } };
  }

  reverseEvent(event: DiagramEvent, model: DiagramModel): void {
    reverseEventOnModel(event, model);
  }

  replayEvent(event: DiagramEvent, model: DiagramModel): void {
    replayEventOnModel(event, model);
  }
}

/**
 * Reverse a single event on the model (undo).
 * Extracted from DiagramModel.reverseEvent for use by the adapter.
 */
function reverseEventOnModel(event: DiagramEvent, model: DiagramModel): void {
  const page = model.getActivePage();
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
      const idx = model.diagram.pages.findIndex((p) => p.id === event.page.id);
      if (idx !== -1) model.diagram.pages.splice(idx, 1);
      break;
    }
    case "page_removed":
      model.diagram.pages.push(event.page);
      break;
    case "layer_created": {
      const p = model.diagram.pages.find((pg) => pg.id === event.pageId);
      if (p) {
        const idx = p.layers.findIndex((l) => l.id === event.layer.id);
        if (idx !== -1) p.layers.splice(idx, 1);
      }
      break;
    }
    case "layer_modified": {
      const p = model.diagram.pages.find((pg) => pg.id === event.pageId);
      if (p) {
        const layer = p.layers.find((l) => l.id === event.layerId);
        if (layer) Object.assign(layer, event.before);
      }
      break;
    }
    case "flow_direction_changed": {
      const p = model.diagram.pages.find((pg) => pg.id === event.pageId);
      if (p) p.flowDirection = event.before as import("./types/index.js").FlowDirection | undefined;
      break;
    }
    case "title_changed":
      model.diagram.title = event.before;
      break;
    case "checkpoint":
      break;
  }
}

/**
 * Replay a single event on the model (redo).
 * Extracted from DiagramModel.replayEvent for use by the adapter.
 */
function replayEventOnModel(event: DiagramEvent, model: DiagramModel): void {
  const page = model.getActivePage();
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
      model.diagram.pages.push(event.page);
      break;
    case "page_removed": {
      const idx = model.diagram.pages.findIndex((p) => p.id === event.page.id);
      if (idx !== -1) model.diagram.pages.splice(idx, 1);
      break;
    }
    case "layer_created": {
      const p = model.diagram.pages.find((pg) => pg.id === event.pageId);
      if (p) p.layers.push({ ...event.layer });
      break;
    }
    case "layer_modified": {
      const p = model.diagram.pages.find((pg) => pg.id === event.pageId);
      if (p) {
        const layer = p.layers.find((l) => l.id === event.layerId);
        if (layer) Object.assign(layer, event.after);
      }
      break;
    }
    case "flow_direction_changed": {
      const p = model.diagram.pages.find((pg) => pg.id === event.pageId);
      if (p) p.flowDirection = event.after as import("./types/index.js").FlowDirection;
      break;
    }
    case "title_changed":
      model.diagram.title = event.after;
      break;
    case "checkpoint":
      break;
  }
}