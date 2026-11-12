import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessEvent } from "../src/events.js";
import {
  claudeQueryOptions,
  createClaudeMapperState,
  mapClaudeMessage,
  subscriptionEnv,
} from "../src/providers/claude.js";

const messages = JSON.parse(
  readFileSync(new URL("./fixtures/claude-messages.json", import.meta.url), "utf8"),
) as Array<Record<string, unknown>>;

function replay(msgs: Array<Record<string, unknown>>): HarnessEvent[] {
  const state = createClaudeMapperState();
  return msgs.flatMap((m) => mapClaudeMessage(m as unknown as SDKMessage, state));
}

describe("mapClaudeMessage fixture replay", () => {
  it("init exposes only the bashit tool", () => {
    const init = messages.find((m) => m.type === "system" && m.subtype === "init");
    assert.ok(init);
    assert.deepEqual(init.tools, ["mcp__bashit__bash"]);
  });

  it("maps the recorded turn", () => {
    assert.deepEqual(replay(messages), [
      {
        type: "tool_call",
        id: "toolu_016TXgGe6oG4cG4YxiyXZmJp",
        command: "echo fixture-hello",
        timeoutSec: undefined,
      },
      {
        type: "tool_result",
        id: "toolu_016TXgGe6oG4cG4YxiyXZmJp",
        output: "fixture-hello\n[exit code: 0]",
        exitCode: 0,
      },
      { type: "text", text: "done" },
      {
        type: "done",
        usage: { inputTokens: 4, outputTokens: 64, costUsd: 0.0034195200000000005 },
      },
    ]);
  });

  it("dedupes repeated tool_use ids", () => {
    const toolUse = messages.find(
      (m) =>
        m.type === "assistant" &&
        (m.message as { content: Array<{ type: string }> }).content[0].type === "tool_use",
    );
    assert.ok(toolUse);
    const events = replay([toolUse, toolUse]);
    assert.equal(events.filter((e) => e.type === "tool_call").length, 1);
  });

  it("ignores subagent (parent_tool_use_id) messages", () => {
    const toolUse = messages.find((m) => m.type === "assistant")!;
    assert.deepEqual(replay([{ ...toolUse, parent_tool_use_id: "toolu_parent" }]), []);
  });

  it("reports tool uses other than the bashit tool as errors", () => {
    const events = replay([
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "ls" } }] },
      },
    ]);
    assert.deepEqual(events, [
      { type: "error", message: "Model called a non-bash tool: Bash" },
    ]);
  });

  it("maps an error result to error, not done", () => {
    const events = replay([
      { type: "result", subtype: "error_during_execution", errors: [], is_error: true },
    ]);
    assert.deepEqual(events, [
      { type: "error", message: "Claude run failed: error_during_execution" },
    ]);
  });

  it("joins error messages from an error result", () => {
    const events = replay([
      { type: "result", subtype: "error_max_turns", errors: ["a", "b"], is_error: true },
    ]);
    assert.deepEqual(events, [{ type: "error", message: "a; b" }]);
  });
});

describe("claudeQueryOptions", () => {
  it("locks the tool surface to bash and disables connector billing", () => {
    const abortController = new AbortController();
    const options = claudeQueryOptions(
      {
        model: "claude-haiku-5-5",
        prompt: "hi",
        workspace: process.cwd(),
        signal: abortController.signal,
      },
      abortController,
    );

    assert.deepEqual(options.tools, []);
    assert.deepEqual(options.settingSources, []);
    assert.equal(options.strictMcpConfig, true);
    assert.notEqual(options.permissionMode, "bypassPermissions");
    assert.deepEqual(options.allowedTools, ["mcp__bashit__bash"]);
    assert.equal(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
    assert.equal(options.env?.ANTHROPIC_API_KEY, undefined);
    const mcp = options.mcpServers?.bashit as { type?: string } | undefined;
    assert.equal(mcp?.type, "stdio");
  });
});

describe("subscriptionEnv", () => {
  it("strips subscription-bypassing billing variables", () => {
    const keys = [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
      "AWS_BEARER_TOKEN_BEDROCK",
    ] as const;
    const saved = new Map(keys.map((key) => [key, process.env[key]]));
    try {
      for (const key of keys) process.env[key] = "test-value";
      const env = subscriptionEnv();
      for (const key of keys) assert.equal(env[key], undefined);
    } finally {
      for (const key of keys) {
        const value = saved.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
