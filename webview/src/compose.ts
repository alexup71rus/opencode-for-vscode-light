import { useStore } from "./store/store";
import type { SendMessageOptions } from "./api/types";

/**
 * Build the per-message send options (model / agent / system prompt) from the
 * current store state. Shared by every sendMessage call site (chat composer,
 * example prompts, retry, edit-resend) so they can't drift.
 */
export function buildSendOptions(): SendMessageOptions {
  const { selectedModel, selectedAgent, settings } = useStore.getState();
  const opts: SendMessageOptions = {};
  if (selectedModel) opts.model = selectedModel;
  if (selectedAgent) opts.agent = selectedAgent;
  if (settings.systemPrompt.trim()) opts.system = settings.systemPrompt.trim();
  return opts;
}
