import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to the repository root (src/..). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const BASH_MCP_PATH = path.join(REPO_ROOT, "src", "bash-mcp.ts");

/**
 * The MCP server is written in TypeScript and run with tsx, so both providers
 * spawn the exact same process. The CLI shim works no matter what cwd the
 * provider gives the child.
 */
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");

export function bashMcpCommand(): { command: string; args: string[] } {
  if (existsSync(TSX_BIN)) {
    return { command: TSX_BIN, args: [BASH_MCP_PATH] };
  }
  // Fallback for unusual installs: node --import tsx, with an absolute path.
  return {
    command: process.execPath,
    args: ["--import", path.join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs"), BASH_MCP_PATH],
  };
}
