export type HarnessEvent =
  | { type: "session"; sessionId: string; workspace: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; command: string; timeoutSec?: number }
  | { type: "tool_result"; id: string; output: string; exitCode: number | null }
  | {
      type: "done";
      usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
    }
  | { type: "error"; message: string };

export type ProviderId = "claude" | "codex";

export interface ProviderRunOptions {
  model: string;
  prompt: string;
  workspace: string;
  /** Provider-side conversation id to resume. */
  resume?: string;
  signal: AbortSignal;
  /** Called whenever the provider reports a new conversation id. */
  onSessionId?: (id: string) => void;
}

export type ProviderRun = (
  options: ProviderRunOptions,
) => AsyncGenerator<HarnessEvent, void, unknown>;
