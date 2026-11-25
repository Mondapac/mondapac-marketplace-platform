import { AiUsageReport } from '../../../platform/ai/usage/ai-usage-report';

// Violation (ai-usage-report-only-from-module-infrastructure): a module reads its capability's
// usage only from its infrastructure adapters.
export const violation = AiUsageReport;
