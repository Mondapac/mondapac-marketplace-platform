import { CapabilityRegistry } from '../../../platform/ai/capability-registry';

// Violation (ai-registration-only-from-module-files): a module registers its AI capabilities in
// its *.module.ts only.
export const violation = CapabilityRegistry;
