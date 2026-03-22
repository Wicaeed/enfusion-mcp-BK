import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import type { Config } from "../config.js";
import { validateProjectPath } from "../utils/safe-path.js";
import { PakVirtualFS } from "../pak/vfs.js";
import {
  parseAgrToStruct, parseAgfToStruct, parseAstToStruct,
  parseAsiToStruct, parseAwToStruct,
} from "../animation/parser.js";
import {
  formatAgrSummary, formatAgfTree, formatAstSummary,
  formatAsiSummary, formatAwSummary, formatValidationReport,
} from "../animation/formatter.js";

// ── File reading helper ──────────────────────────────────────────────────────

function readFileForTool(
  filePath: string,
  source: "mod" | "game",
  projectPath: string | undefined,
  config: Config,
): string | null {
  try {
    if (source === "mod") {
      const basePath = projectPath || config.projectPath;
      if (!basePath) return null;
      const fullPath = validateProjectPath(basePath, filePath);
      if (!existsSync(fullPath)) return null;
      return readFileSync(fullPath, "utf-8");
    } else {
      const dataPath = join(config.gamePath, "addons", "data");
      const loosePath = validateProjectPath(dataPath, filePath);
      if (existsSync(loosePath)) {
        return readFileSync(loosePath, "utf-8");
      }
      const pakVfs = PakVirtualFS.get(config.gamePath);
      if (pakVfs && pakVfs.exists(filePath)) {
        return pakVfs.readFile(filePath).toString("utf-8");
      }
      return null;
    }
  } catch {
    return null;
  }
}

// ── Tool registration ─────────────────────────────────────────────────────────

export function registerAnimationGraphInspect(
  server: McpServer,
  config: Config
): void {
  server.registerTool(
    "animation_graph_inspect",
    {
      description:
        "Read and summarize an Arma Reforger animation graph file (.agr, .agf, .ast, .asi, or .aw). " +
        "Returns structured info: variables with ranges, IK chains, bone masks, commands, node types, or workspace references. " +
        "Use action='inspect' (default) for structured summary, action='validate' for pitfall checks on .agf files. " +
        "Trigger phrases: 'what variables does X use', 'inspect animation graph', 'read AGR/AGF/AST/ASI/AW', " +
        "'what nodes are in the graph', 'validate animation graph', 'check animation graph for issues'. " +
        "For new vehicle setup, use animation_graph_setup instead.",
      inputSchema: {
        path: z.string().describe(
          "File path to .agr, .agf, .ast, .asi, or .aw. Relative to mod project (source=mod) or game data root (source=game). " +
            "Example: 'Assets/Vehicles/MyTruck/workspaces/MyTruck.agr'"
        ),
        action: z.enum(["inspect", "validate"]).default("inspect")
          .describe("Action: inspect (default) returns structured summary; validate runs pitfall checks (requires .agf)"),
        source: z
          .enum(["mod", "game"])
          .default("mod")
          .describe(
            "Read from the mod project directory (mod) or base game data (game)."
          ),
        projectPath: z
          .string()
          .optional()
          .describe(
            "Mod project root path. Uses ENFUSION_PROJECT_PATH default if omitted."
          ),
        agrPath: z.string().optional()
          .describe("AGR file path for cross-reference during validate. Same source/projectPath resolution as path."),
        asiPath: z.string().optional()
          .describe("ASI file path for cross-reference during validate. Same source/projectPath resolution as path."),
      },
    },
    async ({ path: filePath, action, source, projectPath, agrPath, asiPath }) => {
      const ext = extname(filePath).toLowerCase();
      if (![".agr", ".agf", ".ast", ".asi", ".aw"].includes(ext)) {
        return {
          content: [
            {
              type: "text",
              text: `Unsupported file type: ${ext}. Supported: .agr, .agf, .ast, .asi, .aw`,
            },
          ],
        };
      }

      // Read main file
      let content: string;
      try {
        if (source === "mod") {
          const basePath = projectPath || config.projectPath;
          if (!basePath) {
            return {
              content: [
                {
                  type: "text",
                  text: "No project path configured. Set ENFUSION_PROJECT_PATH or provide projectPath.",
                },
              ],
              isError: true,
            };
          }
          const fullPath = validateProjectPath(basePath, filePath);
          if (!existsSync(fullPath)) {
            return {
              content: [{ type: "text", text: `File not found: ${filePath}` }],
              isError: true,
            };
          }
          content = readFileSync(fullPath, "utf-8");
        } else {
          const dataPath = join(config.gamePath, "addons", "data");
          const loosePath = validateProjectPath(dataPath, filePath);
          if (existsSync(loosePath)) {
            content = readFileSync(loosePath, "utf-8");
          } else {
            const pakVfs = PakVirtualFS.get(config.gamePath);
            if (pakVfs && pakVfs.exists(filePath)) {
              const buf = pakVfs.readFile(filePath);
              content = buf.toString("utf-8");
            } else {
              return {
                content: [
                  {
                    type: "text",
                    text: `File not found in game data: ${filePath}`,
                  },
                ],
                isError: true,
              };
            }
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [
            { type: "text", text: `Error reading file: ${msg}` },
          ],
          isError: true,
        };
      }

      // Handle validate action
      if (action === "validate") {
        if (ext !== ".agf") {
          return {
            content: [{ type: "text", text: "Validate action requires an .agf file as the primary path." }],
            isError: true,
          };
        }

        // Dynamic import to avoid circular deps — validator is implemented in Task 7
        const { validateGraph } = await import("../animation/validator.js");
        const agf = parseAgfToStruct(content);

        let agr;
        if (agrPath) {
          const agrContent = readFileForTool(agrPath, source, projectPath, config);
          if (agrContent) agr = parseAgrToStruct(agrContent);
        }

        let asi;
        if (asiPath) {
          const asiContent = readFileForTool(asiPath, source, projectPath, config);
          if (asiContent) asi = parseAsiToStruct(asiContent);
        }

        const result = validateGraph(agf, agr, asi, filePath);
        const report = formatValidationReport(result.issues, result.errorCount, result.warningCount);
        return { content: [{ type: "text", text: report }] };
      }

      // Handle inspect action
      let summary: string;
      if (ext === ".agr") summary = formatAgrSummary(parseAgrToStruct(content));
      else if (ext === ".agf") summary = formatAgfTree(parseAgfToStruct(content));
      else if (ext === ".ast") summary = formatAstSummary(parseAstToStruct(content));
      else if (ext === ".asi") summary = formatAsiSummary(parseAsiToStruct(content));
      else summary = formatAwSummary(parseAwToStruct(content));

      return { content: [{ type: "text", text: summary }] };
    }
  );
}
