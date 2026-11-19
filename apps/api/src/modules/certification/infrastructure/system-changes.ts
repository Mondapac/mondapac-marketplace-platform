import { createSystemChangeRegistrar } from '../../system-requests';

/**
 * Certification's own registrar for System requests, created once and shared by the registry
 * and the claim-policy providers. Never exported from the module's barrel: it is the module's
 * identity towards System requests (a kind only under `certification.`, in the area it owns).
 */
export const CERTIFICATION_SYSTEM_CHANGES = createSystemChangeRegistrar('certification');
