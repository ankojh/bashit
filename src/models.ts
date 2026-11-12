import type { ProviderId } from "./events.js";

export interface ModelInfo {
  id: string;
  label: string;
  provider: ProviderId;
}

/**
 * Model ids verified against the installed CLIs:
 * - `claude` 2.1.322 / @anthropic-ai/claude-agent-sdk 0.3.322
 * - `codex` 0.158.0 (`codex debug models`)
 *
 * The ticket listed `gpt-6.1-*`, which comes from a newer models cache than the
 * installed CLI understands; `gpt-6.1-sol` returns model_not_found on this
 * Codex build. The list below is what this CLI actually offers.
 */
export const MODELS: ModelInfo[] = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", provider: "claude" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", provider: "claude" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", provider: "claude" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1", provider: "claude" },
  { id: "gpt-6-astra", label: "GPT-6 Astra", provider: "codex" },
  { id: "gpt-6-sol", label: "GPT-6 Sol", provider: "codex" },
  { id: "gpt-6-luna", label: "GPT-6 Luna", provider: "codex" },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", provider: "codex" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", provider: "codex" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", provider: "codex" },
];

export function modelById(id: string): ModelInfo | undefined {
  return MODELS.find((m) => m.id === id);
}
