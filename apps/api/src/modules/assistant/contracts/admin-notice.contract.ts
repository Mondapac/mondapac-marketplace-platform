// The admin-notice contract of assistant: what notifications needs to turn a spend-cap pause into
// an admin bell notice, the event and the permission that may read it. A file of its own, not on
// assistant's index.ts, because assistant imports notifications (the support contact facade): a
// subscriber importing assistant's index would close a cycle. Only notifications may import it
// (rule assistant-admin-notice-contract-is-for-notifications).
export { AssistantSpendCapReached, SPEND_CAPS } from '../domain/events';
export { ASSISTANT_SETTINGS_VIEW } from './permissions';
