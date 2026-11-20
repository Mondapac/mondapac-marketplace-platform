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

/**
 * Share a saved filter of the insights list with every admin who can see it, and change or delete
 * one another admin shared (the generic saved-filter routes of `lists`). Without it an admin keeps
 * filters for themselves only; the list itself still needs `assistant.settings.view`. Platform
 * scope and protected: a shared filter shapes what every admin sees first, so a role gets it by
 * name. A filter holds only the selector (view, reason, minimum count, sort), never buyer text.
 */
export const ASSISTANT_INSIGHTS_SAVED_FILTER_SHARE = definePermission('assistant', {
  key: 'assistant.insights-saved-filter.share',
  scope: 'platform',
  protected: true,
});

export const ASSISTANT_PERMISSIONS = declarePermissions('assistant', [
  ASSISTANT_INSIGHTS_SAVED_FILTER_SHARE,
  ASSISTANT_CUSTOMER_CONVERSATION_VIEW,
  ASSISTANT_SETTINGS_MANAGE,
  ASSISTANT_SETTINGS_VIEW,
]);
