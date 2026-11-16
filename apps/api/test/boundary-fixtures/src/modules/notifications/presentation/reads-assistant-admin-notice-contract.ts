import { spendCapReached } from '../../assistant/contracts/admin-notice.contract';

// Allowed: notifications subscribes to assistant's spend-cap event through the contract file.
export const followed = spendCapReached;
