import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { HarnessEvent, ProviderRun, ProviderRunOptions } from "../events.js";
import { bashMcpCommand, REPO_ROOT } from "../mcp-config.js";
import { systemPrompt } from "../system-prompt.js";

const CODEX_HOME = path.join(REPO_ROOT, ".bashit", "codex-home");
const CATALOG_VERSION = 5;
const execFileAsync = promisify(execFile);

/** Native tool-bearing features this Codex build knows about. */
export const DISABLED_FEATURES = [
  "shell_tool",
  "unified_exec",
  "shell_snapshot",
  "apps",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "image_generation",
  "view_image",
  "multi_agent",
  "hooks",
  "plugins",
  "plugin_sharing",
  "skill_search",
  "tool_suggest",
  "sleep_tool",
  "goals",
  "memories",
  "code_mode",
  "in_app_browser",
  "realtime_conversation",
];

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Codex 0.158 ships Code Mode models: their metadata puts every tool behind a
 * `functions.exec` JavaScript wrapper and defers MCP tools behind a tool search
 * that this build cannot enable (`tool_search` is removed, while
 * `tool_search_always_defer_mcp_tools` is locked on). The practical effect is
 * that a configured MCP server is connected but never exposed to the model.
 *
 * Direct tool mode is not a way out either: in this build Codex's router
 * concatenates `namespace` and `name` without a separator, so a direct
 * `mcp__bashit` call fails as `unsupported call: mcp__bashitbash`
 * (openai/codex#31748). Code Mode is the working path: the model calls
 * `functions.exec`, whose only command tool is nested `mcp__bashit__bash`.
 *
 * We therefore derive a local model catalog from `codex debug models` and
 * remove native apply_patch, web search, clock and multi-agent metadata. The
 * model keeps Code Mode's `exec` wrapper (indistinguishable from Codex's own
 * design) but every command it runs goes through bashit's bash. Everything is
 * local to `.bashit/codex-home`; the user's own Codex configuration is
 * untouched.
 */
async function ensureModelCatalog(): Promise<string | undefined> {
  const catalogPath = path.join(CODEX_HOME, "models.json");
  const metaPath = path.join(CODEX_HOME, "models.meta.json");

  let version = "";
  try {
    const { stdout } = await execFileAsync("codex", ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    version = stdout.trim();
  } catch {
    return existsSync(catalogPath) ? catalogPath : undefined;
  }

  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
      version?: string;
      catalogVersion?: number;
    };
    if (
      meta.version === version &&
      meta.catalogVersion === CATALOG_VERSION &&
      existsSync(catalogPath)
    ) {
      return catalogPath;
    }
  } catch {
    // Regenerate.
  }

  try {
    const { stdout: raw } = await execFileAsync("codex", ["debug", "models"], {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, CODEX_HOME },
    });
    const parsed = JSON.parse(raw) as { models?: Array<Record<string, unknown>> };
    if (!Array.isArray(parsed.models)) throw new Error("codex debug models returned no models");
    for (const model of parsed.models) {
      delete model.apply_patch_tool_type;
      delete model.web_search_tool_type;
      delete model.multi_agent_version;
      model.supports_search_tool = false;
      model.experimental_supported_tools = [];
    }
    writeFileSync(catalogPath, JSON.stringify(parsed), "utf8");
    writeFileSync(metaPath, JSON.stringify({ version, catalogVersion: CATALOG_VERSION }), "utf8");
    return catalogPath;
  } catch (error) {
    console.error("[bashit] could not build the Codex model catalog:", error);
    return existsSync(catalogPath) ? catalogPath : undefined;
  }
}

/**
 * Codex's config and session store live in an isolated home so the user's own
 * MCP servers, AGENTS.md, hooks, skills and plugins never load. auth.json is a
 * symlink, because Codex refreshes the token in place and that refresh should
 * stay shared with the real CLI login.
 */
export async function ensureCodexHome(): Promise<string> {
  mkdirSync(CODEX_HOME, { recursive: true });

  const authSource = path.join(homedir(), ".codex", "auth.json");
  const authDest = path.join(CODEX_HOME, "auth.json");
  if (!existsSync(authSource)) {
    throw new Error(
      "Codex is not logged in: ~/.codex/auth.json is missing. Run `codex login` first.",
    );
  }
  const auth = JSON.parse(readFileSync(authSource, "utf8")) as {
    auth_mode?: string;
    tokens?: unknown;
  };
  if (!auth.tokens || (auth.auth_mode !== undefined && auth.auth_mode !== "chatgpt")) {
    throw new Error(
      "Codex is logged in with an API key, which bills the API. Run `codex login` with ChatGPT first.",
    );
  }
  let needsLink = true;
  try {
    const stat = lstatSync(authDest);
    if (stat.isSymbolicLink() && readlinkSync(authDest) === authSource) {
      needsLink = false;
    } else {
      unlinkSync(authDest);
    }
  } catch {
    // Nothing there yet.
  }
  if (needsLink) {
    symlinkSync(authSource, authDest);
  }

  const mcp = bashMcpCommand();
  const catalog = await ensureModelCatalog();
  const config = `# Generated by bashit. Do not edit; it is rewritten on each run.
web_search = "disabled"
mcp_optional_startup_grace_ms = 10000
${catalog ? `model_catalog_json = ${tomlString(catalog)}\n` : ""}
[skills]
include_instructions = false

[mcp_servers.bashit]
command = ${tomlString(mcp.command)}
args = [${mcp.args.map(tomlString).join(", ")}]
startup_timeout_sec = 30
tool_timeout_sec = 660

[mcp_servers.bashit.tools.bash]
approval_mode = "approve"

[tools]
web_search = false

[tools.update_plan]
enabled = false

[tools.experimental_request_user_input]
enabled = false
`;
  writeFileSync(path.join(CODEX_HOME, "config.toml"), config, "utf8");
  return CODEX_HOME;
}

function codexEnv(workspace: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  env.BASHIT_CWD = workspace;
  return env;
}

export interface CodexArgsOptions {
  model: string;
  workspace: string;
  resume?: string;
}

export function codexArgs(options: CodexArgsOptions): string[] {
  const args: string[] = ["exec"];
  if (options.resume) args.push("resume", options.resume);
  args.push("--json", "--skip-git-repo-check");
  if (!options.resume) {
    // exec mode never prompts for approvals; the MCP tool itself is
    // pre-approved in config.toml. The sandbox only matters to Codex's own
    // (disabled) shell tools, but danger-full-access keeps its file handling
    // out of the way too.
    args.push("-C", options.workspace, "-s", "danger-full-access");
  } else {
    // `exec resume` does not accept -s in this version.
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }
  args.push("-m", options.model);
  for (const feature of DISABLED_FEATURES) {
    args.push("--disable", feature);
  }
  args.push(
    "-c",
    `developer_instructions=${tomlString(systemPrompt(options.workspace))}`,
    "-c",
    `mcp_servers.bashit.env.BASHIT_CWD=${tomlString(options.workspace)}`,
    "-",
  );
  return args;
}

function contentText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return result === undefined ? "" : String(result);
  const record = result as Record<string, unknown>;
  const content = record.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object" && "text" in block) {
          return String((block as { text: unknown }).text);
        }
        return JSON.stringify(block);
      })
      .join("\n");
  }
  return JSON.stringify(result);
}

function exitCodeFromOutput(output: string): number | null {
  const match = /\[exit code: (-?\d+|null)\]\s*$/.exec(output);
  if (!match) return null;
  return match[1] === "null" ? null : Number(match[1]);
}

export interface ToolState {
  command: string;
  timeoutSec?: number;
  emitted: boolean;
}

export interface CodexMapperState {
  tools: Map<string, ToolState>;
  sawDone: boolean;
  sawError: boolean;
  lastTopLevelError?: string;
}

export function createCodexMapperState(): CodexMapperState {
  return { tools: new Map(), sawDone: false, sawError: false };
}

export interface CodexMappedEvent {
  events: HarnessEvent[];
  threadId?: string;
}

function emitToolCall(
  item: Record<string, unknown>,
  id: string,
  state: CodexMapperState,
): HarnessEvent | undefined {
  const existing = state.tools.get(id);
  if (existing?.emitted) return undefined;
  const argsValue = item.arguments;
  const args =
    argsValue && typeof argsValue === "object" ? (argsValue as Record<string, unknown>) : {};
  const command = typeof args.command === "string" ? args.command : JSON.stringify(argsValue ?? {});
  const timeoutSec = typeof args.timeout_sec === "number" ? args.timeout_sec : undefined;
  state.tools.set(id, { command, timeoutSec, emitted: true });
  return { type: "tool_call", id, command, timeoutSec };
}

/**
 * Pure Codex JSONL-event to harness-event mapper. Exported so tests can replay
 * recorded `codex exec --json` fixtures without spawning Codex.
 */
export function mapCodexEvent(
  event: Record<string, unknown>,
  state: CodexMapperState,
): CodexMappedEvent {
  const events: HarnessEvent[] = [];
  const type = event.type;

  if (type === "thread.started") {
    return {
      events,
      threadId: typeof event.thread_id === "string" ? event.thread_id : undefined,
    };
  }

  if (type === "error") {
    if (typeof event.message === "string") state.lastTopLevelError = event.message;
    return { events };
  }

  if (type === "turn.failed") {
    const error = event.error;
    const message =
      error && typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : (state.lastTopLevelError ?? "Codex turn failed");
    state.sawError = true;
    events.push({ type: "error", message });
    return { events };
  }

  if (type === "turn.completed") {
    state.sawDone = true;
    const usage = event.usage as Record<string, unknown> | undefined;
    events.push({
      type: "done",
      usage:
        usage && typeof usage.input_tokens === "number"
          ? {
              inputTokens: usage.input_tokens,
              outputTokens:
                typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
            }
          : undefined,
    });
    return { events };
  }

  if (type !== "item.started" && type !== "item.updated" && type !== "item.completed") {
    return { events };
  }

  const item = event.item;
  if (!item || typeof item !== "object") return { events };
  const record = item as Record<string, unknown>;
  const itemType = record.type;
  const id = typeof record.id === "string" ? record.id : `codex-${Math.random()}`;

  if (itemType === "agent_message") {
    if (type === "item.completed" && typeof record.text === "string" && record.text.trim()) {
      events.push({ type: "text", text: record.text });
    }
    return { events };
  }

  if (itemType === "mcp_tool_call") {
    const server = typeof record.server === "string" ? record.server : "";
    const tool = typeof record.tool === "string" ? record.tool : "";
    if (server !== "bashit" || tool !== "bash") {
      console.error(`[codex] unexpected MCP tool: ${server}.${tool}`);
      return { events };
    }
    if (type === "item.started" || type === "item.updated") {
      const call = emitToolCall(record, id, state);
      if (call) events.push(call);
    } else if (type === "item.completed") {
      const call = emitToolCall(record, id, state);
      if (call) events.push(call);
      const errorText =
        typeof record.error === "string"
          ? record.error
          : record.error && typeof record.error === "object"
            ? JSON.stringify(record.error)
            : undefined;
      const output = errorText ?? contentText(record.result);
      events.push({
        type: "tool_result",
        id,
        output,
        exitCode: exitCodeFromOutput(output),
      });
    }
    return { events };
  }

  // Fallback for Codex's native shell: only appears if the feature disables
  // above stop working. Mapped so the UI still shows the call.
  if (itemType === "command_execution") {
    if (type === "item.started" || type === "item.updated") {
      if (!state.tools.get(id)) {
        const command = typeof record.command === "string" ? record.command : "";
        state.tools.set(id, { command, emitted: true });
        events.push({ type: "tool_call", id, command });
      }
    } else if (type === "item.completed") {
      const existing = state.tools.get(id);
      if (!existing?.emitted) {
        const command = typeof record.command === "string" ? record.command : "";
        state.tools.set(id, { command, emitted: true });
        events.push({ type: "tool_call", id, command });
      }
      const output =
        typeof record.aggregated_output === "string"
          ? record.aggregated_output
          : typeof record.output === "string"
            ? record.output
            : "";
      const exitCode =
        typeof record.exit_code === "number" ? record.exit_code : exitCodeFromOutput(output);
      events.push({ type: "tool_result", id, output, exitCode });
    }
    return { events };
  }

  if (itemType === "error") {
    console.error(`[codex] item error: ${String(record.message ?? "")}`);
    return { events };
  }

  // Any other item type is a native tool we did not expect. Surface it in the
  // server log so a dev run can catch a feature that stopped accepting
  // --disable.
  if (type === "item.completed") {
    console.error(`[codex] unexpected item type: ${String(itemType)}`);
  }
  return { events };
}

export const runCodex: ProviderRun = async function* (
  options: ProviderRunOptions,
): AsyncGenerator<HarnessEvent> {
  await ensureCodexHome();

  const args = codexArgs({
    model: options.model,
    workspace: options.workspace,
    resume: options.resume,
  });

  if (options.signal.aborted) {
    yield { type: "done" };
    return;
  }

  const child = spawn("codex", args, {
    cwd: options.workspace,
    env: codexEnv(options.workspace),
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  const mapperState = createCodexMapperState();
  let aborted = false;

  const kill = () => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
  };

  const onAbort = () => {
    aborted = true;
    kill();
  };
  options.signal.addEventListener("abort", onAbort, { once: true });

  // A prompt is passed on stdin: it avoids argv size limits and quoting issues.
  child.stdin?.on("error", () => {
    // The process may exit before the prompt is written (e.g. auth failure).
  });
  child.stdin?.end(options.prompt);

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
    if (stderr.length > 8000) stderr = stderr.slice(-8000);
  });

  const closed = new Promise<number | null>((resolve) => {
    child.on("error", (error) => {
      stderr += `\n[failed to start codex: ${error.message}]`;
    });
    child.on("close", (code) => resolve(code));
  });

  try {
    if (child.stdout) {
      const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          console.error(`[codex] non-JSON output: ${trimmed.slice(0, 500)}`);
          continue;
        }

        const mapped = mapCodexEvent(event, mapperState);
        if (mapped.threadId) options.onSessionId?.(mapped.threadId);
        for (const mappedEvent of mapped.events) yield mappedEvent;
      }
    }

    const exitCode = await closed;

    if (aborted || options.signal.aborted) {
      if (!mapperState.sawDone && !mapperState.sawError) yield { type: "done" };
      return;
    }
    if (!mapperState.sawDone && !mapperState.sawError) {
      const detail = stderr.trim();
      mapperState.sawError = true;
      yield {
        type: "error",
        message:
          detail.length > 0
            ? detail
            : `Codex exited with code ${exitCode === null ? "null" : exitCode} without a result.`,
      };
    }
  } catch (error) {
    if (!aborted && !options.signal.aborted) {
      const message = error instanceof Error ? error.message : String(error);
      yield { type: "error", message };
    } else if (!mapperState.sawDone) {
      yield { type: "done" };
    }
  } finally {
    options.signal.removeEventListener("abort", onAbort);
    if (child.exitCode === null && child.signalCode === null) {
      kill();
    }
  }
};
