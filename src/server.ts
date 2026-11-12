import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { HarnessEvent, ProviderId, ProviderRun } from "./events.js";
import { REPO_ROOT } from "./mcp-config.js";
import { MODELS, modelById } from "./models.js";
import { runClaude } from "./providers/claude.js";
import { runCodex } from "./providers/codex.js";

export interface Session {
  id: string;
  model: string;
  provider: ProviderId;
  workspace: string;
  providerSessionId?: string;
  running: boolean;
  abort?: AbortController;
}

export interface CreateAppOptions {
  /** Override providers in tests. */
  providers?: Partial<Record<ProviderId, ProviderRun>>;
  /** Default root for generated workspaces. */
  workspacesRoot?: string;
}

const WORKSPACES_ROOT = path.join(REPO_ROOT, "workspaces");

function jsonError(message: string, status: number, code?: string) {
  return Response.json({ error: message, ...(code ? { code } : {}) }, { status });
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

export function createApp(options: CreateAppOptions = {}): Hono {
  const sessions = new Map<string, Session>();
  const providers: Record<ProviderId, ProviderRun> = {
    claude: options.providers?.claude ?? runClaude,
    codex: options.providers?.codex ?? runCodex,
  };
  const workspacesRoot = options.workspacesRoot ?? WORKSPACES_ROOT;
  const app = new Hono();

  // Loopback binding alone does not stop the user's browser from posting to
  // this server from another site. Reject non-loopback Host headers (DNS
  // rebinding) and cross-origin writes, and require JSON for chat bodies so a
  // "simple" text/plain POST cannot start a run.
  const loopbackHostnames = new Set(["127.0.0.1", "localhost", "[::1]"]);
  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    if (!loopbackHostnames.has(url.hostname)) {
      return jsonError("Forbidden host.", 403, "bad_host");
    }
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const origin = c.req.header("origin");
      if (origin !== undefined && origin !== url.origin) {
        return jsonError("Cross-origin request refused.", 403, "bad_origin");
      }
      if (
        url.pathname === "/api/chat" &&
        !(c.req.header("content-type") ?? "").startsWith("application/json")
      ) {
        return jsonError("Content-Type must be application/json.", 415, "bad_content_type");
      }
    }
    await next();
  });

  app.get("/", (c) => {
    const html = readFileSync(path.join(REPO_ROOT, "public", "index.html"), "utf8");
    return c.html(html);
  });

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.get("/api/models", (c) => c.json(MODELS));

  app.post("/api/chat/:id/abort", (c) => {
    const id = c.req.param("id");
    const session = sessions.get(id);
    if (!session) return jsonError("Unknown session.", 404, "unknown_session");
    session.abort?.abort();
    return c.json({ ok: true });
  });

  app.post("/api/chat", async (c) => {
    let body: {
      sessionId?: unknown;
      model?: unknown;
      prompt?: unknown;
      workspace?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return jsonError("Request body must be JSON.", 400, "bad_json");
    }

    if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
      return jsonError("prompt must be a non-empty string.", 400, "bad_prompt");
    }
    if (typeof body.model !== "string") {
      return jsonError("model must be a string.", 400, "bad_model");
    }
    const model = modelById(body.model);
    if (!model) {
      return jsonError(`Unknown model: ${body.model}`, 400, "unknown_model");
    }

    let session: Session | undefined;
    if (body.sessionId !== undefined && body.sessionId !== null) {
      if (typeof body.sessionId !== "string") {
        return jsonError("sessionId must be a string.", 400, "bad_session");
      }
      session = sessions.get(body.sessionId);
      if (!session) return jsonError("Unknown session.", 404, "unknown_session");
      if (session.model !== model.id) {
        return jsonError(
          `This chat is using ${session.model}. Start a new chat to switch models.`,
          400,
          "model_mismatch",
        );
      }
      if (session.running) {
        return jsonError("This chat is already running a turn.", 409, "busy");
      }
    } else {
      const id = randomUUID();
      let workspace: string;
      if (body.workspace !== undefined && body.workspace !== null) {
        if (typeof body.workspace !== "string" || body.workspace.length === 0) {
          return jsonError("workspace must be a path string.", 400, "bad_workspace");
        }
        if (!path.isAbsolute(body.workspace)) {
          return jsonError("workspace must be an absolute path.", 400, "bad_workspace");
        }
        if (!isDirectory(body.workspace)) {
          return jsonError("workspace must be an existing directory.", 400, "bad_workspace");
        }
        workspace = path.resolve(body.workspace);
      } else {
        workspace = path.join(workspacesRoot, id);
        mkdirSync(workspace, { recursive: true });
      }
      session = {
        id,
        model: model.id,
        provider: model.provider,
        workspace,
        running: false,
      };
      sessions.set(id, session);
    }

    if (session.running) {
      return jsonError("This chat is already running a turn.", 409, "busy");
    }

    const activeSession = session;
    const abortController = new AbortController();
    activeSession.running = true;
    activeSession.abort = abortController;

    return streamSSE(c, async (stream) => {
      let closed = false;
      stream.onAbort(() => {
        closed = true;
        abortController.abort();
      });

      const send = async (event: HarnessEvent) => {
        if (closed) return;
        try {
          await stream.writeSSE({ data: JSON.stringify(event) });
        } catch {
          closed = true;
          abortController.abort();
        }
      };

      // A comment line keeps the SSE connection observably alive while a
      // long-running bash command produces no events.
      const heartbeat = setInterval(() => {
        if (!closed) {
          void stream.write(": ping\n\n").catch(() => {});
        }
      }, 10_000);

      await send({
        type: "session",
        sessionId: activeSession.id,
        workspace: activeSession.workspace,
      });

      try {
        const run = providers[activeSession.provider];
        for await (const event of run({
          model: activeSession.model,
          prompt: body.prompt as string,
          workspace: activeSession.workspace,
          resume: activeSession.providerSessionId,
          signal: abortController.signal,
          onSessionId: (id) => {
            activeSession.providerSessionId = id;
          },
        })) {
          await send(event);
          if (closed) break;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await send({ type: "error", message });
      } finally {
        clearInterval(heartbeat);
        activeSession.running = false;
        activeSession.abort = undefined;
      }
    });
  });

  return app;
}

export const app = createApp();

export function startServer(serverApp = app): void {
  const port = Number(process.env.PORT ?? 4545);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`[bashit] invalid PORT: ${process.env.PORT}`);
    process.exit(1);
  }

  serve({ fetch: serverApp.fetch, hostname: "127.0.0.1", port }, (info) => {
    console.log(`[bashit] listening on http://127.0.0.1:${info.port}`);
    console.log(`[bashit] workspaces: ${WORKSPACES_ROOT}`);
  });
}

process.on("unhandledRejection", (error) => {
  console.error("[bashit] unhandledRejection", error);
});

const isMain =
  process.argv[1] !== undefined &&
  (import.meta.url === `file://${process.argv[1]}` ||
    import.meta.url.endsWith(process.argv[1].split("/").pop() ?? ""));

if (isMain) {
  startServer();
}
