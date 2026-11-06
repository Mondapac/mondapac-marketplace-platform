/**
 * The permission an admin must hold to manage agents (ADR-0045 decision 2; agents brief
 * AGT-01). The key is declared by the `agents` module, so identity cannot import it (ADR-0008):
 * it is a plain string here, and `identity`'s agent use cases re-check it on the caller's own
 * actor, in the unit that writes. Until `agents` declares it the permission registry holds it
 * for nobody and every such use case answers `access.denied` (fail closed).
 */
export const AGENTS_MANAGE_KEY = 'agents.manage';

/** The access state of an agent account (ADR-0045 decision 5), read live. */
export type AgentAccess = 'active' | 'disabled' | 'invited';
