import { AiUsageReport } from '../../../platform/ai/usage/ai-usage-report';

// Violation (ai-usage-report-only-from-the-allow-list): only the allow-listed
// infrastructure files read a capability's usage.
export const violation = AiUsageReport;
