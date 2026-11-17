import { cultureDemoteApprovals } from '../../sellers/contracts/culture-demote.port';

// Violation: only catalog's infrastructure/sellers-culture-members.ts (and sellers) may import
// sellers' culture demotion port (ADR-0048 security review N2).
export const demoteAll = cultureDemoteApprovals;
