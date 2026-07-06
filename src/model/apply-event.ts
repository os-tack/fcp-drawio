import type { DiagramEvent, Page } from "../types/index.js";
import type { DiagramModel } from "./diagram-model.js";

/**
 * Resolve the page a shape/edge/group event happened on. Falls back to the
 * current active page when the event carries no pageId (e.g. hand-constructed
 * events in tests, or events emitted before this field existed) — but for
 * events produced by DiagramModel itself, pageId is always set, so undo/redo
 * still targets the right page even if the user has since switched pages
 * (switchPage() itself emits no event to track that transition).
 */
function resolvePage(model: DiagramModel, pageId: string | undefined): Page {
  if (pageId) {
    const page = model.diagram.pages.find((p) => p.id === pageId);
    if (page) return page;
  }
  return model.getActivePage();
}

/**
 * Reverse a single event on the model (undo).
 *
 * Shared by DrawioAdapter (fcp-core's FcpDomainAdapter contract, drives
 * `drawio_session undo`) and DiagramModel's own undo()/undoTo() so there is
 * exactly one implementation of "what does undoing this event mean".
 */
export function reverseEventOnModel(event: DiagramEvent, model: DiagramModel): void {
  switch (event.type) {
    case "shape_created":
      resolvePage(model, event.pageId).shapes.delete(event.shape.id);
      break;
    case "shape_deleted":
      resolvePage(model, event.pageId).shapes.set(event.shape.id, { ...event.shape });
      break;
    case "shape_modified": {
      const shape = resolvePage(model, event.pageId).shapes.get(event.id);
      if (shape) Object.assign(shape, event.before);
      break;
    }
    case "edge_created":
      resolvePage(model, event.pageId).edges.delete(event.edge.id);
      break;
    case "edge_deleted":
      resolvePage(model, event.pageId).edges.set(event.edge.id, { ...event.edge });
      break;
    case "edge_modified": {
      const edge = resolvePage(model, event.pageId).edges.get(event.id);
      if (edge) Object.assign(edge, event.before);
      break;
    }
    case "group_created": {
      const page = resolvePage(model, event.pageId);
      page.groups.delete(event.group.id);
      for (const id of event.group.memberIds) {
        const shape = page.shapes.get(id);
        if (shape) shape.parentGroup = null;
      }
      break;
    }
    case "group_dissolved": {
      const page = resolvePage(model, event.pageId);
      page.groups.set(event.group.id, {
        ...event.group,
        memberIds: new Set(event.group.memberIds),
      });
      for (const id of event.group.memberIds) {
        const shape = page.shapes.get(id);
        if (shape) shape.parentGroup = event.group.id;
      }
      break;
    }
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
      if (p) p.flowDirection = event.before as import("../types/index.js").FlowDirection | undefined;
      break;
    }
    case "title_changed":
      model.diagram.title = event.before;
      break;
  }
}

/**
 * Replay a single event on the model (redo).
 */
export function replayEventOnModel(event: DiagramEvent, model: DiagramModel): void {
  switch (event.type) {
    case "shape_created":
      resolvePage(model, event.pageId).shapes.set(event.shape.id, { ...event.shape });
      break;
    case "shape_deleted":
      resolvePage(model, event.pageId).shapes.delete(event.shape.id);
      break;
    case "shape_modified": {
      const shape = resolvePage(model, event.pageId).shapes.get(event.id);
      if (shape) Object.assign(shape, event.after);
      break;
    }
    case "edge_created":
      resolvePage(model, event.pageId).edges.set(event.edge.id, { ...event.edge });
      break;
    case "edge_deleted":
      resolvePage(model, event.pageId).edges.delete(event.edge.id);
      break;
    case "edge_modified": {
      const edge = resolvePage(model, event.pageId).edges.get(event.id);
      if (edge) Object.assign(edge, event.after);
      break;
    }
    case "group_created": {
      const page = resolvePage(model, event.pageId);
      page.groups.set(event.group.id, {
        ...event.group,
        memberIds: new Set(event.group.memberIds),
      });
      for (const id of event.group.memberIds) {
        const shape = page.shapes.get(id);
        if (shape) shape.parentGroup = event.group.id;
      }
      break;
    }
    case "group_dissolved": {
      const page = resolvePage(model, event.pageId);
      page.groups.delete(event.group.id);
      for (const id of event.group.memberIds) {
        const shape = page.shapes.get(id);
        if (shape) shape.parentGroup = null;
      }
      break;
    }
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
      if (p) p.flowDirection = event.after as import("../types/index.js").FlowDirection;
      break;
    }
    case "title_changed":
      model.diagram.title = event.after;
      break;
  }
}
