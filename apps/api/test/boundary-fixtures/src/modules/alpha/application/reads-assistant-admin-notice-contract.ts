import { spendCapReached } from '../../assistant/contracts/admin-notice.contract';

// Violation: only notifications may import assistant's admin-notice contract.
export const followed = spendCapReached;
