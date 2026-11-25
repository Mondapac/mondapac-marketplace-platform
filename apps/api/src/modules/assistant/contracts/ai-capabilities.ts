import type { CapabilitySpec } from '../../../platform/ai/capability';
import {
  MAX_INPUT_TOKENS,
  MAX_MODEL_ROUNDS,
  MAX_OUTPUT_TOKENS,
  MODEL_TIMEOUT_MS,
} from '../domain/conversation';
import { PROMPT_VERSION } from '../domain/instructions';

/**
 * assistant's AI capabilities (docs/design/domain/platform-ai.md section 4), registered with the
 * gateway at boot. The buyer chat (AIC-*) is market-only: guests and customers, READ and DRAFT
 * tools, one `run` per model round.
 */
export const BUYER_CHAT = 'assistant.buyer-chat';

export const ASSISTANT_AI_CAPABILITIES: readonly CapabilitySpec[] = [
  {
    id: BUYER_CHAT,
    audience: 'buyer',
    task: 'chat',
    sellerScoped: false,
    maxInputTokens: MAX_INPUT_TOKENS,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    maxToolRounds: MAX_MODEL_ROUNDS,
    timeoutMs: MODEL_TIMEOUT_MS,
    promptVersion: PROMPT_VERSION,
  },
];
