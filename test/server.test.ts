import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { HarnessEvent, ProviderRun } from "../src/events.js";
import { createApp } from "../src/server.js";

const root = mkdtempSync(path.join(tmpdir(), "bashit-server-"));
after(() => rmSync(root, { recursive: true, force: true }));

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

interface Fake {
  run: ProviderRun;
  started: Promise<void>;
  signals: AbortSignal[];
  resumes: Array<string | undefined>;
  calls: number;
}

/** Yields text, then blocks until aborted, then yields done. */
function fakeProvider(): Fake {
  const startedD = deferred();
  const fake: Fake = {
    started: startedD.promise,
    signals: [],
    resumes: [],
    calls: 0,
    run: async function* (options) {
      fake.calls++;
      fake.signals.push(options.signal);
      fake.resumes.push(options.resume);
      options.onSessionId?.(`prov-${fake.calls}`);
      yield { type: "text", text: "started" };
      startedD.resolve();
      if (!options.signal.aborted) {
        await new Promise<void>((r) => options.signal.addEventListener("abort", () => r(), { once: true }));
      }
      yield { type: "done" };
    },
  };
  return fake;
}

function post(app: ReturnType<typeof createApp>, body: unknown, url = "/api/chat") {
  return app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Incremental SSE reader. */
function reader(res: Response) {
  const r = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  return {
    async next(): Promise<HarnessEvent | null> {
      for (;;) {
        const idx = buf.indexOf("\n\n");
        if (idx >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const data = chunk
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .join("");
          if (data) return JSON.parse(data) as HarnessEvent;
          continue;
        }
        const { value, done } = await r.read();
        if (done) return null;
        buf += dec.decode(value, { stream: true });
      }
    },
    async drain(): Promise<HarnessEvent[]> {
      const out: HarnessEvent[] = [];
      for (let e = await this.next(); e; e = await this.next()) out.push(e);
      return out;
    },
    cancel: () => r.cancel(),
  };
}

const MODEL = "claude-haiku-5-5";

function setup() {
  const fake = fakeProvider();
  const workspacesRoot = path.join(root, `ws-${Math.random().toString(36).slice(2)}`);
  const app = createApp({ providers: { claude: fake.run, codex: fake.run }, workspacesRoot });
  return { app, fake, workspacesRoot };
}

async function waitUntilIdle(app: ReturnType<typeof createApp>, sessionId: string, model = MODEL) {
  // Session.running flips to false in the stream's finally block; poll via a new request.
  for (let i = 0; i < 100; i++) {
    const res = await post(app, { sessionId, model, prompt: "ping" });
    if (res.status !== 409) return res;
    await res.text();
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("session stayed busy");
}

describe("GET /api/health", () => {
  it("reports the server as healthy", async () => {
    const { app } = setup();
    const res = await app.request("/api/health");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

describe("request origin and host checks", () => {
  it("refuses a cross-origin POST", async () => {
    const { app } = setup();
    const res = await app.request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ model: MODEL, prompt: "hi" }),
    });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { code: string }).code, "bad_origin");
  });

  it("refuses a text/plain chat body", async () => {
    const { app } = setup();
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ model: MODEL, prompt: "hi" }),
    });
    assert.equal(res.status, 415);
    assert.equal(((await res.json()) as { code: string }).code, "bad_content_type");
  });

  it("refuses a non-loopback Host", async () => {
    const { app } = setup();
    const res = await app.request("http://attacker.example/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, prompt: "hi" }),
    });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { code: string }).code, "bad_host");
  });
});

describe("POST /api/chat validation", () => {
  it("400 for an unknown model", async () => {
    const { app } = setup();
    const res = await post(app, { model: "nope", prompt: "hi" });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code: string }).code, "unknown_model");
  });

  it("400 for an empty prompt", async () => {
    const { app } = setup();
    const res = await post(app, { model: MODEL, prompt: "  " });
    assert.equal(res.status, 400);
  });

  it("400 bad_workspace for a relative workspace", async () => {
    const { app } = setup();
    const res = await post(app, { model: MODEL, prompt: "hi", workspace: "relative/dir" });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code: string }).code, "bad_workspace");
  });

  it("400 for a missing absolute workspace", async () => {
    const { app } = setup();
    const res = await post(app, {
      model: MODEL,
      prompt: "hi",
      workspace: path.join(root, "does-not-exist"),
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code: string }).code, "bad_workspace");
  });

  it("404 for an unknown sessionId", async () => {
    const { app } = setup();
    const res = await post(app, { model: MODEL, prompt: "hi", sessionId: "nope" });
    assert.equal(res.status, 404);
  });

  it("404 when aborting an unknown session", async () => {
    const { app } = setup();
    const res = await app.request("/api/chat/nope/abort", { method: "POST" });
    assert.equal(res.status, 404);
  });
});

describe("session lifecycle", () => {
  it("streams session + provider events, enforces busy/mismatch, aborts, and accepts a follow-up", async () => {
    const { app, fake, workspacesRoot } = setup();

    const res = await post(app, { model: MODEL, prompt: "hi" });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const sse = reader(res);

    const first = (await sse.next()) as Extract<HarnessEvent, { type: "session" }>;
    assert.equal(first.type, "session");
    const sessionId = first.sessionId;
    // Default workspace is created under the supplied root.
    assert.equal(first.workspace, path.join(workspacesRoot, sessionId));
    assert.ok(existsSync(first.workspace));

    assert.deepEqual(await sse.next(), { type: "text", text: "started" });
    await fake.started;

    // Busy while running.
    const busy = await post(app, { sessionId, model: MODEL, prompt: "again" });
    assert.equal(busy.status, 409);
    assert.equal(((await busy.json()) as { code: string }).code, "busy");

    // Model mismatch.
    const mismatch = await post(app, { sessionId, model: "claude-opus-5-5", prompt: "again" });
    assert.equal(mismatch.status, 400);
    assert.equal(((await mismatch.json()) as { code: string }).code, "model_mismatch");

    // Abort.
    const abort = await app.request(`/api/chat/${sessionId}/abort`, { method: "POST" });
    assert.equal(abort.status, 200);
    assert.equal(fake.signals[0].aborted, true);

    // Stream ends (done may or may not be delivered after abort).
    const rest = await sse.drain();
    assert.ok(rest.every((e) => e.type === "done"));

    // Follow-up on the same session is accepted, resuming the provider session.
    const followUp = await waitUntilIdle(app, sessionId);
    assert.equal(followUp.status, 200);
    const sse2 = reader(followUp);
    assert.equal((await sse2.next())?.type, "session");
    assert.deepEqual(await sse2.next(), { type: "text", text: "started" });
    assert.equal(fake.resumes[1], "prov-1");

    await app.request(`/api/chat/${sessionId}/abort`, { method: "POST" });
    await sse2.drain();
  });

  it("aborts the provider when the client disconnects", async () => {
    const { app, fake } = setup();
    const res = await post(app, { model: MODEL, prompt: "hi" });
    const sse = reader(res);
    const first = (await sse.next()) as Extract<HarnessEvent, { type: "session" }>;
    await sse.next();
    await fake.started;

    await sse.cancel();
    for (let i = 0; i < 100 && !fake.signals[0].aborted; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fake.signals[0].aborted, true);

    const followUp = await waitUntilIdle(app, first.sessionId);
    assert.equal(followUp.status, 200);
    const sse2 = reader(followUp);
    await sse2.next();
    await sse2.next();
    await app.request(`/api/chat/${first.sessionId}/abort`, { method: "POST" });
    await sse2.drain();
  });

  it("uses an existing absolute workspace as given", async () => {
    const { app, fake } = setup();
    const res = await post(app, { model: "gpt-6-sol", prompt: "hi", workspace: root });
    assert.equal(res.status, 200);
    const sse = reader(res);
    const first = (await sse.next()) as Extract<HarnessEvent, { type: "session" }>;
    assert.equal(first.workspace, root);
    await sse.next();
    await fake.started;
    await app.request(`/api/chat/${first.sessionId}/abort`, { method: "POST" });
    await sse.drain();
  });

  it("emits an error event if the provider throws", async () => {
    const app = createApp({
      providers: {
        claude: async function* () {
          throw new Error("kaboom");
        },
      },
      workspacesRoot: path.join(root, "throwing"),
    });
    const res = await post(app, { model: MODEL, prompt: "hi" });
    const events = await reader(res).drain();
    assert.deepEqual(events.map((e) => e.type), ["session", "error"]);
    assert.equal((events[1] as { message: string }).message, "kaboom");
  });
});
