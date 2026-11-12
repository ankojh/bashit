import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessEvent, ProviderRun, ProviderRunOptions } from "../events.js";
import { bashMcpCommand } from "../mcp-config.js";
import { systemPrompt } from "../system-prompt.js";

const TOOL_NAME = "mcp__bashit__bash";

const BUILTIN_TOOLS = [
  "Bash",
  "BashOutput",
  "KillShell",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "Task",
  "Agent",
  "Skill",
  "SlashCommand",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
];

const BILLING_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "AWS_BEARER_TOKEN_BEDROCK",
];

/** Environment shared by the SDK and the bash MCP server, with billing knobs removed. */
export function subscriptionEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (BILLING_ENV.includes(key)) continue;
    env[key] = value;
  }
  return env;
}

function childEnv(): Record<string, string> {
  const env = subscriptionEnv();
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "bashit/0.1.0";
  // Defense in depth: strictMcpConfig already keeps claude.ai connectors out.
  env.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
  return env;
}

export function claudeQueryOptions(
  options: ProviderRunOptions,
  abortController: AbortController,
): NonNullable<Parameters<typeof query>[0]["options"]> {
  const mcp = bashMcpCommand();
  const serverEnv = subscriptionEnv();
  serverEnv.BASHIT_CWD = options.workspace;

  return {
    abortController,
    cwd: options.workspace,
    model: options.model,
    tools: [],
    disallowedTools: BUILTIN_TOOLS,
    mcpServers: {
      bashit: {
        type: "stdio",
        command: mcp.command,
        args: mcp.args,
        env: serverEnv,
      },
    },
    allowedTools: [TOOL_NAME],
    // dontAsk denies anything not explicitly allowed; the bash MCP tool is.
    permissionMode: "dontAsk",
    systemPrompt: systemPrompt(options.workspace),
    settingSources: [],
    strictMcpConfig: true,
    env: childEnv(),
    resume: options.resume,
  };
}

function blockText(content: unknown): string {
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
  if (content === null || content === undefined) return "";
  return JSON.stringify(content);
}

function exitCodeFromOutput(output: string): number | null {
  const match = /\[exit code: (-?\d+|null)\]\s*$/.exec(output);
  if (!match) return null;
  return match[1] === "null" ? null : Number(match[1]);
}

function logInit(message: Extract<SDKMessage, { type: "system" }>): void {
  if (message.subtype !== "init") return;
  console.log(
    "[claude] init",
    JSON.stringify({
      model: message.model,
      tools: message.tools,
      mcp_servers: message.mcp_servers,
      permissionMode: message.permissionMode,
      apiKeySource: message.apiKeySource,
    }),
  );
}

export interface ClaudeMapperState {
  seenToolCalls: Set<string>;
}

export function createClaudeMapperState(): ClaudeMapperState {
  return { seenToolCalls: new Set() };
}

/**
 * Pure SDK-message to harness-event mapper. Exported so the mapping can be
 * tested against recorded fixtures without spawning Claude.
 */
export function mapClaudeMessage(message: SDKMessage, state: ClaudeMapperState): HarnessEvent[] {
  const events: HarnessEvent[] = [];

  switch (message.type) {
    case "system": {
      logInit(message);
      break;
    }
    case "assistant": {
      if (message.parent_tool_use_id) break;
      for (const block of message.message.content) {
        if (block.type === "text") {
          if (block.text.trim().length > 0) {
            events.push({ type: "text", text: block.text });
          }
        } else if (block.type === "tool_use") {
          if (block.name !== TOOL_NAME) {
            console.error(`[claude] unexpected tool use: ${block.name}`);
            events.push({
              type: "error",
              message: `Model called a non-bash tool: ${block.name}`,
            });
            continue;
          }
          if (state.seenToolCalls.has(block.id)) continue;
          state.seenToolCalls.add(block.id);
          const input = (block.input ?? {}) as {
            command?: unknown;
            timeout_sec?: unknown;
          };
          events.push({
            type: "tool_call",
            id: block.id,
            command: typeof input.command === "string" ? input.command : JSON.stringify(input),
            timeoutSec: typeof input.timeout_sec === "number" ? input.timeout_sec : undefined,
          });
        }
      }
      break;
    }
    case "user": {
      if (message.parent_tool_use_id) break;
      const content = message.message.content;
      if (!Array.isArray(content)) break;
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        const output = blockText(block.content);
        events.push({
          type: "tool_result",
          id: block.tool_use_id,
          output,
          exitCode: exitCodeFromOutput(output),
        });
      }
      break;
    }
    case "result": {
      if (message.subtype === "success") {
        events.push({
          type: "done",
          usage: {
            inputTokens: message.usage.input_tokens,
            outputTokens: message.usage.output_tokens,
            costUsd: message.total_cost_usd,
          },
        });
      } else {
        events.push({
          type: "error",
          message:
            message.errors.length > 0
              ? message.errors.join("; ")
              : `Claude run failed: ${message.subtype}`,
        });
      }
      break;
    }
    default:
      break;
  }

  return events;
}

export const runClaude: ProviderRun = async function* (
  options: ProviderRunOptions,
): AsyncGenerator<HarnessEvent> {
  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  options.signal.addEventListener("abort", onAbort, { once: true });
  if (options.signal.aborted) abortController.abort();

  let emittedDone = false;
  const mapperState = createClaudeMapperState();

  try {
    const q = query({
      prompt: options.prompt,
      options: claudeQueryOptions(options, abortController),
    });

    for await (const message of q) {
      if (message.session_id) options.onSessionId?.(message.session_id);

      if (message.type === "system" && message.subtype === "init") {
        const unexpected = message.tools.filter((tool) => tool !== TOOL_NAME);
        if (unexpected.length > 0) {
          abortController.abort();
          emittedDone = true;
          yield {
            type: "error",
            message: `Claude exposed tools other than bash: ${unexpected.join(", ")}`,
          };
          return;
        }
        if (message.apiKeySource !== "none" && message.apiKeySource !== "oauth") {
          abortController.abort();
          emittedDone = true;
          yield {
            type: "error",
            message: `Claude would bill ${message.apiKeySource}, not the subscription. Log in to claude with a Claude subscription.`,
          };
          return;
        }
      }

      for (const event of mapClaudeMessage(message, mapperState)) {
        if (event.type === "done" || event.type === "error") emittedDone = true;
        yield event;
      }
    }
  } catch (error) {
    if (abortController.signal.aborted || options.signal.aborted) {
      if (!emittedDone) yield { type: "done" };
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    yield { type: "error", message };
  } finally {
    options.signal.removeEventListener("abort", onAbort);
    if (abortController.signal.aborted && !emittedDone) {
      // The consumer may have stopped reading after an abort; nothing to do.
    }
  }
};
