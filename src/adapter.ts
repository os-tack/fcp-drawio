import type { FcpDomainAdapter, OpResult, QueryResult } from "@ostk-ai/fcp-core";
import type { EventLog } from "@ostk-ai/fcp-core";
import type { ParsedOp } from "@ostk-ai/fcp-core";
import type { DiagramEvent } from "./types/index.js";
import { DiagramModel } from "./model/diagram-model.js";
import { IntentLayer } from "./server/intent-layer.js";
import { serializeDiagram } from "./serialization/serialize.js";
import { deserializeDiagram } from "./serialization/deserialize.js";
import { reverseEventOnModel, replayEventOnModel } from "./model/apply-event.js";

/**
 * Bridge between the generic fcp-core ParsedOp (Record<string, string> params,
 * positionals array) and drawio's domain-specific ParsedOp (Map<string, string>
 * params, verb-specific fields like type, target, targets, arrows).
 *
 * The existing IntentLayer already has a full string-based dispatch pipeline
 * (string -> local parseOp -> domain ParsedOp -> handler). Rather than
 * rewriting the entire IntentLayer, this adapter delegates to it via the
 * original string-based path while satisfying the FcpDomainAdapter interface.
 *
 * Undo/redo/checkpoint seam: fcp-core's createFcpServer() owns its own
 * EventLog<DiagramEvent> and drives `drawio_session undo/redo/checkpoint`
 * against it via SessionDispatcher, calling dispatchOp(op, model, log) with
 * that log on every mutating op. DiagramModel keeps its own EventLog
 * (model.eventLog) for every mutation it makes (used by the `checkpoint`
 * verb and the `diff`/`history`/`status` queries). dispatchOp mirrors the
 * events IntentLayer just produced in model.eventLog into the log fcp-core
 * passed in, so both logs stay in lockstep and `drawio_session` undo/redo
 * actually works against real mutations instead of an always-empty log.
 *
 * There are two ways to create a named checkpoint: `drawio_session
 * checkpoint NAME` (a session action, handled entirely by SessionDispatcher
 * against its own log) and `drawio checkpoint NAME` (an op, handled by
 * IntentLayer/DiagramModel against model.eventLog, documented as "for
 * undo"). dispatchOp also registers the latter on fcp-core's log, at the
 * same cursor position the mirrored events land at, so `drawio_session
 * undo to:NAME` finds checkpoints created either way.
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
   *
   * IntentLayer mutates `model` and appends whatever events it produced to
   * `model.eventLog` (DiagramModel's own log). fcp-core's SessionDispatcher
   * only ever sees `log` (the EventLog passed in here) when computing undo/
   * redo, so we mirror the delta over after the op runs — regardless of
   * success, since a partially-applied op still leaves real mutations in
   * model.eventLog that undo needs to be able to reverse.
   *
   * The op-level `checkpoint NAME` verb doesn't mutate the model (no events
   * to mirror), it just marks a name in model.eventLog for the `diff`/`history`
   * queries. We additionally register that same name in `log` so `drawio_session
   * undo to:NAME` can find checkpoints created via either `drawio checkpoint`
   * or `drawio_session checkpoint`.
   */
  async dispatchOp(op: ParsedOp, model: DiagramModel, log: EventLog<DiagramEvent>): Promise<OpResult> {
    const cursorBefore = model.eventLog.cursor;
    const result = await this.intent.executeSingleOp(op.raw);
    for (const event of model.eventLog.eventsSince(cursorBefore)) {
      log.append(event);
    }
    if (op.verb === "checkpoint" && result.success) {
      const name = op.positionals[0];
      if (name) log.checkpoint(name);
    }
    return result;
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
