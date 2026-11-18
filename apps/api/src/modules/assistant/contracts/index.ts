// Public contracts of the assistant module (ADR-0008): the permission keys, audit actions and the
// admin's read of one customer's conversation dates.
// Other modules may import only what this file exports, through ../index.ts.
export { ASSISTANT_AUDIT_ACTIONS } from '../domain/audit';
export {
  CUSTOMER_CONVERSATIONS_FACADE,
  type AdminConversationDates,
  type AdminConversationsRequest,
  type CustomerConversationsFacade,
  type CustomerConversationsFailure,
} from './customer-conversations.facade';
export {
  ASSISTANT_CUSTOMER_CONVERSATION_VIEW,
  ASSISTANT_PERMISSIONS,
  ASSISTANT_SETTINGS_MANAGE,
  ASSISTANT_SETTINGS_VIEW,
} from './permissions';
