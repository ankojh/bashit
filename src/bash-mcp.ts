#!/usr/bin/env node
/**
 * bashit's only tool.
 *
 * A deliberately small stdio MCP server exposing `bash`. Both providers mount
 * this same process, so the tool behaves identically whichever model runs.
 */
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export const DEFAULT_TIMEOUT_SEC = 120;
export const MAX_TIMEOUT_SEC = 600;
export const OUTPUT_LIMIT = 30_000;
export const HEAD_LIMIT = 10_000;
export const TAIL_LIMIT = 20_000;

export interface BashResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
}

export interface BashOptions {
  cwd: string;
  timeoutSec?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

/**
 * Keeps the first 10k characters and a rolling 20k tail. This bounds memory
 * for commands that produce gigabytes of output while preserving exactly the
 * parts the model is shown.
 */
export class OutputCollector {
  private head = "";
  private tail = "";
  private total = 0;

  push(chunk: string): void {
    this.total += chunk.length;
    if (this.head.length < HEAD_LIMIT) {
      const take = Math.min(HEAD_LIMIT - this.head.length, chunk.length);
      this.head += chunk.slice(0, take);
      chunk = chunk.slice(take);
      if (!chunk) return;
    }
    this.tail += chunk;
    if (this.tail.length > TAIL_LIMIT) {
      this.tail = this.tail.slice(-TAIL_LIMIT);
    }
  }

  toString(): string {
    if (this.total <= this.head.length + this.tail.length) {
      return this.head + this.tail;
    }
    const omitted = this.total - this.head.length - this.tail.length;
    return `${this.head}\n[... ${omitted} chars truncated ...]\n${this.tail}`;
  }

  get length(): number {
    return this.total;
  }
}

export interface FormatOptions {
  exitCode: number | null;
  timedOut?: boolean;
  timeoutSec?: number;
  aborted?: boolean;
}

/** Formats the exact text the model sees. */
export function formatResult(output: string, options: FormatOptions): string {
  const body = output.replace(/\n+$/, "");
  const details: string[] = [];
  if (options.timedOut) {
    details.push(`[timed out after ${options.timeoutSec ?? DEFAULT_TIMEOUT_SEC}s]`);
  }
  if (options.aborted) {
    details.push("[aborted]");
  }
  details.push(`[exit code: ${options.exitCode}]`);
  return body ? `${body}\n${details.join("\n")}` : details.join("\n");
}

function clampTimeout(timeoutSec: number | undefined): number {
  if (timeoutSec === undefined || !Number.isFinite(timeoutSec)) {
    return DEFAULT_TIMEOUT_SEC;
  }
  return Math.max(1, Math.min(MAX_TIMEOUT_SEC, Math.floor(timeoutSec)));
}

const activeChildren = new Set<number>();

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** Kill every tracked process group; used only when the MCP server shuts down. */
export function killAllChildren(): void {
  for (const pid of activeChildren) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  activeChildren.clear();
}

export function runBash(command: string, options: BashOptions): Promise<BashResult> {
  const timeoutSec = clampTimeout(options.timeoutSec);
  const collector = new OutputCollector();

  return new Promise<BashResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let timer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;

    // Merge stderr into stdout inside the shell so the model sees output in
    // the order the command produced it. Both execs keep the same pid, so the
    // process group and exit code are unchanged.
    const child = spawn(
      "bash",
      ["-c", 'exec 2>&1; exec bash -lc "$1"', "bashit", command],
      {
        cwd: options.cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: options.env ?? process.env,
      },
    );

    const pid = child.pid;
    if (pid !== undefined) activeChildren.add(pid);

    const finish = (exitCode: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      // Keep the group tracked while a background job still holds it. The
      // MCP server kills every tracked group on shutdown.
      if (pid !== undefined && !groupAlive(pid)) activeChildren.delete(pid);
      options.signal?.removeEventListener("abort", onAbort);
      if (spawnError) collector.push(spawnError);
      resolve({
        output: collector.toString(),
        exitCode,
        timedOut,
        aborted,
      });
    };

    const interrupt = () => {
      if (pid === undefined) return;
      if (settled) return;
      killProcessGroup(pid);
    };

    const onAbort = () => {
      aborted = true;
      interrupt();
    };

    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => collector.push(chunk));
    child.stderr?.on("data", (chunk: string) => collector.push(chunk));

    child.on("error", (error) => {
      finish(null, `[failed to start bash: ${error.message}]`);
    });

    // Settle when the bash leader exits, not when every holder of the pipes
    // exits. Background jobs can keep the pipes open for minutes.
    child.on("exit", (code) => {
      drainTimer = setTimeout(() => finish(code), 100);
    });

    child.on("close", (code) => {
      finish(code);
    });

    timer = setTimeout(() => {
      timedOut = true;
      interrupt();
    }, timeoutSec * 1000);
    timer.unref?.();
  });
}

function workspaceFromEnv(): string {
  const cwd = process.env.BASHIT_CWD;
  if (!cwd) {
    throw new Error("BASHIT_CWD is not set");
  }
  const stat = statSync(cwd);
  if (!stat.isDirectory()) {
    throw new Error(`BASHIT_CWD is not a directory: ${cwd}`);
  }
  return cwd;
}

export function buildServer(workspace: string, env?: NodeJS.ProcessEnv): McpServer {
  const server = new McpServer({ name: "bashit", version: "0.1.0" });

  server.registerTool(
    "bash",
    {
      title: "bash",
      description: `Run a bash command in the session workspace (${workspace}).

Every call starts a fresh bash shell in the workspace. cd does not persist between calls; chain commands with && or write a script. stdout and stderr are combined. Output is truncated to the first 10k and last 20k characters when it exceeds 30k. The default timeout is ${DEFAULT_TIMEOUT_SEC}s (maximum ${MAX_TIMEOUT_SEC}s); on timeout or abort the whole process group is killed. Background jobs (\`cmd &\`) keep running until the end of the turn and are then killed.`,
      inputSchema: {
        command: z.string().min(1).describe("The bash command to run."),
        timeout_sec: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `Timeout in seconds. Defaults to ${DEFAULT_TIMEOUT_SEC}, capped at ${MAX_TIMEOUT_SEC}.`,
          ),
      },
    },
    async ({ command, timeout_sec }, extra) => {
      const result = await runBash(command, {
        cwd: workspace,
        env,
        timeoutSec: timeout_sec,
        signal: extra.signal,
      });
      const text = formatResult(result.output, {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        timeoutSec: clampTimeout(timeout_sec),
        aborted: result.aborted,
      });
      return { content: [{ type: "text" as const, text }] };
    },
  );

  return server;
}

async function main(): Promise<void> {
  const workspace = workspaceFromEnv();
  const server = buildServer(workspace);
  const transport = new StdioServerTransport();

  const shutdown = () => {
    killAllChildren();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);

  await server.connect(transport);
}

const isMain =
  process.argv[1] !== undefined &&
  (import.meta.url === `file://${process.argv[1]}` ||
    import.meta.url.endsWith(process.argv[1].split("/").pop() ?? ""));

if (isMain) {
  main().catch((error) => {
    console.error("[bashit] failed to start:", error);
    process.exit(1);
  });
}
