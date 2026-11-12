import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  buildServer,
  DEFAULT_TIMEOUT_SEC,
  formatResult,
  killAllChildren,
  MAX_TIMEOUT_SEC,
  OutputCollector,
  runBash,
} from "../src/bash-mcp.js";

const cwd = mkdtempSync(path.join(tmpdir(), "bashit-test-"));
const testEnv = { ...process.env, HOME: cwd };
after(() => rmSync(cwd, { recursive: true, force: true }));

function bash(command: string, options: Partial<Parameters<typeof runBash>[1]> = {}) {
  return runBash(command, { cwd, env: testEnv, ...options });
}

describe("runBash", () => {
  it("returns stdout and exit code 0", async () => {
    const r = await bash("echo hello");
    assert.equal(r.output.trim(), "hello");
    assert.equal(r.exitCode, 0);
    assert.equal(r.timedOut, false);
    assert.equal(r.aborted, false);
  });

  it("returns stderr and a non-zero exit code", async () => {
    const r = await bash("echo oops >&2; exit 7");
    assert.equal(r.output.trim(), "oops");
    assert.equal(r.exitCode, 7);
  });

  it("merges stdout and stderr in command order", async () => {
    const r = await bash("for i in 1 2 3 4 5; do echo out$i; echo err$i >&2; done");
    assert.equal(
      r.output.trim(),
      "out1\nerr1\nout2\nerr2\nout3\nerr3\nout4\nerr4\nout5\nerr5",
    );
    assert.equal(r.exitCode, 0);
  });

  it("runs in the given cwd", async () => {
    const r = await bash("pwd -P");
    assert.equal(path.basename(r.output.trim()), path.basename(cwd));
  });

  it("kills the process group on timeout and keeps partial output", async () => {
    const start = Date.now();
    const r = await bash("echo partial; sleep 5; echo never", { timeoutSec: 1 });
    const elapsed = Date.now() - start;
    assert.equal(r.timedOut, true);
    assert.match(r.output, /partial/);
    assert.doesNotMatch(r.output, /never/);
    assert.ok(elapsed < 4000, `took ${elapsed}ms`);
    const text = formatResult(r.output, {
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      timeoutSec: 1,
    });
    assert.match(text, /\[timed out after 1s\]/);
  });

  it("kills grandchildren spawned by the command", async () => {
    const r = await bash("sleep 30 & echo $!; wait", { timeoutSec: 1 });
    const pid = Number(r.output.trim().split("\n")[0]);
    assert.ok(Number.isInteger(pid) && pid > 0);
    await new Promise((res) => setTimeout(res, 200));
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  });

  it("settles when the leader exits even with a background job", async () => {
    const start = Date.now();
    const r = await bash("sleep 30 & echo started");
    const elapsed = Date.now() - start;

    assert.equal(r.exitCode, 0);
    assert.equal(r.timedOut, false);
    assert.match(r.output, /started/);
    assert.ok(elapsed < 1000, `took ${elapsed}ms`);
    killAllChildren();
  });

  it("kills tracked background jobs on shutdown", async () => {
    const r = await bash("sleep 30 & echo PID:$!");
    const pid = Number(/PID:(\d+)/.exec(r.output)?.[1]);
    assert.ok(Number.isInteger(pid) && pid > 0);
    assert.doesNotThrow(() => process.kill(pid, 0));

    killAllChildren();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  });

  it("clamps a too-small timeout up to 1s", async () => {
    const start = Date.now();
    const r = await bash("sleep 5", { timeoutSec: 0 });
    assert.equal(r.timedOut, true);
    assert.ok(Date.now() - start < 4000);
  });

  it("stops on abort", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const start = Date.now();
    const r = await bash("sleep 5", { signal: ac.signal });
    assert.equal(r.aborted, true);
    assert.ok(Date.now() - start < 4000);
  });
});

describe("OutputCollector", () => {
  it("does not truncate at or below the limit", () => {
    const c = new OutputCollector();
    const text = "a".repeat(30_000);
    c.push(text);
    assert.equal(c.toString(), text);
    assert.doesNotMatch(c.toString(), /truncated/);
  });

  it("keeps first 10k, last 20k, and a marker when over the limit", () => {
    const c = new OutputCollector();
    const head = "H".repeat(10_000);
    const middle = "M".repeat(5_000);
    const tail = "T".repeat(20_000);
    // Push in odd-sized chunks to exercise the rolling tail.
    const all = head + middle + tail;
    for (let i = 0; i < all.length; i += 777) c.push(all.slice(i, i + 777));
    const out = c.toString();
    assert.equal(c.length, 35_000);
    assert.equal(out, `${head}\n[... 5000 chars truncated ...]\n${tail}`);
  });

  it("truncates a single huge chunk", () => {
    const c = new OutputCollector();
    c.push("x".repeat(100_000));
    const out = c.toString();
    assert.match(out, /\[\.\.\. 70000 chars truncated \.\.\.\]/);
    assert.equal(out.length, 10_000 + 20_000 + "\n[... 70000 chars truncated ...]\n".length);
  });

  it("runBash truncates large real output", async () => {
    const r = await bash("head -c 100000 /dev/zero | tr '\\0' 'x'");
    assert.match(r.output, /\[\.\.\. 70000 chars truncated \.\.\.\]/);
  });
});

describe("formatResult", () => {
  it("appends the exit code and strips trailing newlines", () => {
    assert.equal(formatResult("hi\n\n", { exitCode: 0 }), "hi\n[exit code: 0]");
  });
  it("omits an empty body", () => {
    assert.equal(formatResult("", { exitCode: 3 }), "[exit code: 3]");
  });
  it("reports timeout and abort markers", () => {
    assert.equal(
      formatResult("x", { exitCode: null, timedOut: true, timeoutSec: 9, aborted: true }),
      "x\n[timed out after 9s]\n[aborted]\n[exit code: null]",
    );
  });
  it("defaults the timeout in the marker", () => {
    assert.match(formatResult("", { exitCode: null, timedOut: true }), /after 120s/);
  });
});

describe("bash MCP tool", () => {
  async function connect() {
    const server = buildServer(cwd, testEnv);
    const client = new Client({ name: "test", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    return { client, server };
  }

  it("documents default and max timeouts", async () => {
    assert.equal(DEFAULT_TIMEOUT_SEC, 120);
    assert.equal(MAX_TIMEOUT_SEC, 600);
    const { client } = await connect();
    const { tools } = await client.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "bash");
    assert.match(tools[0].description ?? "", /default timeout is 120s \(maximum 600s\)/);
    await client.close();
  });

  it("runs a command and formats the result", async () => {
    const { client } = await connect();
    const res = await client.callTool({ name: "bash", arguments: { command: "echo hi; exit 2" } });
    const content = res.content as Array<{ type: string; text: string }>;
    assert.equal(content[0].text, "hi\n[exit code: 2]");
    await client.close();
  });

  it("reports the timeout in the tool result", async () => {
    const { client } = await connect();
    const res = await client.callTool({
      name: "bash",
      arguments: { command: "echo partial; sleep 5", timeout_sec: 1 },
    });
    const text = (res.content as Array<{ text: string }>)[0].text;
    assert.match(text, /partial/);
    assert.match(text, /\[timed out after 1s\]/);
    await client.close();
  });
});
