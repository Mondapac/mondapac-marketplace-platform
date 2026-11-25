import type { CapabilitySpec } from '../../../platform/ai/capability';
import { WRITER_PROMPT_VERSION } from '../domain/description-writer/writer-prompt';

/**
 * catalog's AI capabilities (docs/design/domain/platform-ai.md section 4), registered with the
 * gateway at boot. The description writer (AIS-03) is two capabilities, one per audience: a seller
 * writes for their own product under their own switch (SEL-25), an admin writes platform content.
 * One call, no tools (R4, R9); the caps match the writer's own limits.
 */
const WRITER = {
  task: 'write',
  maxInputTokens: 8_000,
  maxOutputTokens: 700,
  maxToolRounds: 0,
  timeoutMs: 25_000,
  promptVersion: WRITER_PROMPT_VERSION,
} as const;

export const DESCRIPTION_WRITER_SELLER = 'catalog.description-writer.seller';
export const DESCRIPTION_WRITER_ADMIN = 'catalog.description-writer.admin';

export const CATALOG_AI_CAPABILITIES: readonly CapabilitySpec[] = [
  { id: DESCRIPTION_WRITER_SELLER, audience: 'seller', sellerScoped: true, ...WRITER },
  { id: DESCRIPTION_WRITER_ADMIN, audience: 'admin', sellerScoped: false, ...WRITER },
];
