import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { HarnessEvent } from "../src/events.js";
import {
  codexArgs,
  createCodexMapperState,
  DISABLED_FEATURES,
  mapCodexEvent,
} from "../src/providers/codex.js";

const SPEND_CAP =
  "You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.";

const fixture = readFileSync(new URL("./fixtures/codex-mock-turn.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Record<string, unknown>);

function replay(lines: Array<Record<string, unknown>>) {
  const state = createCodexMapperState();
  const events: HarnessEvent[] = [];
  let threadId: string | undefined;
  for (const line of lines) {
    const mapped = mapCodexEvent(line, state);
    if (mapped.threadId) threadId = mapped.threadId;
    events.push(...mapped.events);
  }
  return { events, threadId, state };
}

const mcpItem = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "mcp_tool_call",
  server: "bashit",
  tool: "bash",
  arguments: { command: "ls" },
  ...extra,
});

describe("mapCodexEvent fixture replay", () => {
  const { events, threadId } = replay(fixture);

  it("extracts the thread id", () => {
    assert.equal(threadId, "01a1cd49-f0c3-72f1-8d54-affa2a13f23f");
  });

  it("maps the whole turn to the expected harness events", () => {
    assert.deepEqual(events, [
      {
        type: "tool_call",
        id: "item_2",
        command: "echo hello-from-mock && pwd && ls",
        timeoutSec: undefined,
      },
      {
        type: "tool_result",
        id: "item_2",
        output: "hello-from-mock\n/Users/ankojh/b12/bashit/.bashit/codex-test\nREADME.txt\n[exit code: 0]",
        exitCode: 0,
      },
      { type: "text", text: "mock turn complete" },
      { type: "done", usage: { inputTokens: 200, outputTokens: 40 } },
    ]);
  });

  it("emits exactly one tool_call and one tool_result", () => {
    assert.equal(events.filter((e) => e.type === "tool_call").length, 1);
    assert.equal(events.filter((e) => e.type === "tool_result").length, 1);
  });

  it("ignores item.error entries (no events, no error)", () => {
    assert.equal(events.some((e) => e.type === "error"), false);
  });
});

describe("mapCodexEvent edge cases", () => {
  it("emits tool_call before tool_result when item.started is missing", () => {
    const { events } = replay([
      {
        type: "item.completed",
        item: mcpItem("x1", {
          result: { content: [{ type: "text", text: "out\n[exit code: 3]" }] },
        }),
      },
    ]);
    assert.deepEqual(
      events.map((e) => e.type),
      ["tool_call", "tool_result"],
    );
    assert.equal((events[1] as { exitCode: number | null }).exitCode, 3);
  });

  it("does not duplicate tool_call across started/updated/completed", () => {
    const { events } = replay([
      { type: "item.started", item: mcpItem("y") },
      { type: "item.updated", item: mcpItem("y") },
      { type: "item.completed", item: mcpItem("y", { result: "done\n[exit code: 0]" }) },
    ]);
    assert.deepEqual(
      events.map((e) => e.type),
      ["tool_call", "tool_result"],
    );
  });

  it("passes through timeout_sec", () => {
    const { events } = replay([
      {
        type: "item.started",
        item: mcpItem("t", { arguments: { command: "sleep 1", timeout_sec: 9 } }),
      },
    ]);
    assert.deepEqual(events, [{ type: "tool_call", id: "t", command: "sleep 1", timeoutSec: 9 }]);
  });

  it("surfaces an MCP error as the tool result", () => {
    const { events } = replay([
      { type: "item.completed", item: mcpItem("e", { error: { message: "boom" } }) },
    ]);
    const result = events[1] as { output: string; exitCode: number | null };
    assert.match(result.output, /boom/);
    assert.equal(result.exitCode, null);
  });

  it("ignores MCP calls to other tools", () => {
    const { events } = replay([
      { type: "item.started", item: mcpItem("o", { server: "other" }) },
    ]);
    assert.deepEqual(events, []);
  });

  it("emits exactly one error for top-level error then turn.failed (message on turn.failed)", () => {
    const { events } = replay([
      { type: "error", message: SPEND_CAP },
      { type: "turn.failed", error: { message: SPEND_CAP } },
    ]);
    assert.deepEqual(events, [{ type: "error", message: SPEND_CAP }]);
  });

  it("falls back to the top-level error message when turn.failed has none", () => {
    const { events } = replay([
      { type: "error", message: SPEND_CAP },
      { type: "turn.failed" },
    ]);
    assert.deepEqual(events, [{ type: "error", message: SPEND_CAP }]);
  });

  it("maps the native command_execution fallback", () => {
    const { events } = replay([
      { type: "item.started", item: { id: "c1", type: "command_execution", command: "ls" } },
      {
        type: "item.completed",
        item: {
          id: "c1",
          type: "command_execution",
          command: "ls",
          aggregated_output: "a\nb",
          exit_code: 0,
        },
      },
    ]);
    assert.deepEqual(events, [
      { type: "tool_call", id: "c1", command: "ls" },
      { type: "tool_result", id: "c1", output: "a\nb", exitCode: 0 },
    ]);
  });

  it("command_execution completed without started still emits tool_call first", () => {
    const { events } = replay([
      {
        type: "item.completed",
        item: { id: "c2", type: "command_execution", command: "pwd", output: "/x", exit_code: 1 },
      },
    ]);
    assert.deepEqual(
      events.map((e) => e.type),
      ["tool_call", "tool_result"],
    );
    assert.equal((events[1] as { exitCode: number | null }).exitCode, 1);
  });

  it("emits done without usage when the turn has none", () => {
    const { events } = replay([{ type: "turn.completed" }]);
    assert.deepEqual(events, [{ type: "done", usage: undefined }]);
  });

  it("ignores unknown event types", () => {
    assert.deepEqual(replay([{ type: "turn.started" }, { type: "whatever" }]).events, []);
  });
});

describe("codexArgs", () => {
  it("builds a new turn with workspace, sandbox and every disable flag", () => {
    const args = codexArgs({ model: "gpt-6-luna", workspace: "/tmp/ws" });
    assert.deepEqual(args.slice(0, 3), ["exec", "--json", "--skip-git-repo-check"]);
    assert.equal(args[args.indexOf("-C") + 1], "/tmp/ws");
    assert.equal(args[args.indexOf("-s") + 1], "danger-full-access");
    assert.equal(args[args.indexOf("-m") + 1], "gpt-6-luna");
    const disabled = args.flatMap((arg, index) => (arg === "--disable" ? [args[index + 1]] : []));
    assert.deepEqual(disabled, DISABLED_FEATURES);
    assert.equal(args[args.length - 1], "-");
    assert.ok(args.some((arg) => arg.startsWith("developer_instructions=")));
    assert.ok(args.some((arg) => arg.startsWith("mcp_servers.bashit.env.BASHIT_CWD=")));
  });

  it("resumes with the thread id and bypasses approvals without -C/-s", () => {
    const args = codexArgs({ model: "gpt-6-luna", workspace: "/tmp/ws", resume: "thread-1" });
    assert.deepEqual(args.slice(0, 4), ["exec", "resume", "thread-1", "--json"]);
    assert.ok(args.includes("--dangerously-bypass-approvals-and-sandbox"));
    assert.equal(args.includes("-C"), false);
    assert.equal(args.includes("-s"), false);
    assert.equal(args[args.length - 1], "-");
  });
});
