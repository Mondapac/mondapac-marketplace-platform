import { authenticatedActor } from '@mondapac/shared-kernel/authenticated-actor';

// Allowed: identity's Authenticator is the one file that builds authenticated actors.
export const allowed = authenticatedActor('account');
