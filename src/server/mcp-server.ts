import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createFcpServer } from "@os-tack/fcp-core";
import { DrawioAdapter } from "../adapter.js";
import { DRAWIO_VERB_SPECS } from "../verb-specs.js";
import { IntentLayer } from "./intent-layer.js";
import { detectDrawioCLI } from "../lib/drawio-cli.js";
import { buildReferenceCardSections } from "./model-map.js";

export function createServer(): { server: McpServer; intent: IntentLayer } {
  const drawioCliPath = detectDrawioCLI();
  const adapter = new DrawioAdapter({ drawioCliPath });
  const intent = adapter.intentLayer;

  const server = createFcpServer<
    import("../model/diagram-model.js").DiagramModel,
    import("../types/index.js").DiagramEvent
  >({
    domain: "drawio",
    adapter,
    verbs: DRAWIO_VERB_SPECS,
    referenceCard: {
      sections: buildReferenceCardSections(),
    },
    extensions: ["drawio"],
    instructions: "FCP draw.io server for creating and editing draw.io diagrams programmatically. Use drawio_session to create or open a diagram, drawio to add/modify/remove shapes, connections, and layouts, drawio_query to inspect diagram state, and drawio_help for the full verb reference. Start every interaction with drawio_session.",
  });

  return { server, intent };
}

export async function startServer(): Promise<void> {
  const { server } = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
