import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of assistant (settings). Changing the settings switches the buyer
// assistant on or off for a whole Market and sets its spend caps, so it is a protected platform
// key: only the Platform Administrator holds it by definition. Reading them is a plain key.

/** See the Market's buyer assistant settings. */
export const ASSISTANT_SETTINGS_VIEW = definePermission('assistant', {
  key: 'assistant.settings.view',
  scope: 'platform',
  protected: false,
});

/** Change the Market's buyer assistant settings. */
export const ASSISTANT_SETTINGS_MANAGE = definePermission('assistant', {
  key: 'assistant.settings.manage',
  scope: 'platform',
  protected: true,
});

/**
 * See how many assistant conversations one customer had and when (started, last message) on the
 * customer page (customers management phase 2b). Never the messages, their cards or the turns.
 */
export const ASSISTANT_CUSTOMER_CONVERSATION_VIEW = definePermission('assistant', {
  key: 'assistant.customer-conversation.view',
  scope: 'platform',
  protected: false,
});

export const ASSISTANT_PERMISSIONS = declarePermissions('assistant', [
  ASSISTANT_CUSTOMER_CONVERSATION_VIEW,
  ASSISTANT_SETTINGS_MANAGE,
  ASSISTANT_SETTINGS_VIEW,
]);
