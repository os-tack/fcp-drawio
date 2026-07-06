import { NODE_TYPES } from "../lib/node-types.js";
import { THEMES } from "../lib/themes.js";
import type { ShapeType, ThemeName } from "../types/index.js";

/**
 * Generate the NODE TYPES section from the runtime registry.
 * Matches the existing compact format: "  shorthand    description"
 */
function generateNodeTypesSection(): string {
  const lines: string[] = [];
  for (const [name, def] of Object.entries(NODE_TYPES) as [ShapeType, typeof NODE_TYPES[ShapeType]][]) {
    lines.push(`  ${name.padEnd(10)} ${def.description.toLowerCase()}`);
  }
  return lines.join("\n");
}

/**
 * Generate the THEMES section from the runtime registry.
 * Pairs themes on the same line for compactness.
 */
function generateThemesSection(): string {
  const entries = Object.entries(THEMES) as [ThemeName, typeof THEMES[ThemeName]][];
  const lines: string[] = [];

  for (let i = 0; i < entries.length; i += 2) {
    const [name1, colors1] = entries[i];
    let line = `  ${name1.padEnd(10)} ${colors1.fill} / ${colors1.stroke}`;
    if (colors1.fontColor) line += ` (light text)`;

    if (i + 1 < entries.length) {
      const [name2, colors2] = entries[i + 1];
      line += `    ${name2.padEnd(8)} ${colors2.fill} / ${colors2.stroke}`;
      if (colors2.fontColor) line += ` (light text)`;
    }

    lines.push(line);
  }
  return lines.join("\n");
}

/**
 * Build domain-specific sections for the VerbRegistry reference card.
 * Used by createFcpServer() to append drawio-specific reference material
 * after the verb listing. This is the reference text the production
 * `drawio_help` MCP tool actually serves (generated once at server startup).
 */
export function buildReferenceCardSections(): Record<string, string> {
  const sections: Record<string, string> = {};

  sections["Node Types"] = generateNodeTypesSection();

  sections["Themes (fill / stroke)"] = generateThemesSection();

  sections["Edge Styles"] = `  solid, dashed (- - -), dotted (· · ·), animated, thick, curved, orthogonal
  Arrows: -> (directed), <-> (bidirectional), -- (undirected)
  Arrow heads: arrow, open-arrow, diamond, circle, crow-foot, none`;

  sections["Selectors"] = `  @type:TYPE, @group:NAME, @connected:REF, @recent, @recent:N,
  @all, @orphan, @page:NAME, @layer:NAME`;

  sections["Response Prefixes"] = `  +  shape created       ~  edge created/modified
  *  shape modified      -  shape/edge removed
  !  group operation     @  layout/position change`;

  sections["Conventions"] = `  - Labels are unique identifiers - no ID management needed
  - Position auto-computed if omitted (near last created shape)
  - near:REF dir:DIRECTION places relative to existing shape
  - All XML structure, IDs, and geometry handled by the tool
  - Call drawio_help for full reference with examples`;

  return sections;
}
