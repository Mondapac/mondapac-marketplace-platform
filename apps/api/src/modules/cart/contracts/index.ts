// Public contracts of the cart module (ADR-0008): the checkout facade interface.
// Other modules may import only what this file exports, through ../index.ts.
export {
  CART_CHECKOUT_FACADE,
  type CartCheckoutFacade,
  type CartCheckoutFailure,
  type CheckoutLine,
} from './cart.facade';
export {
  CART_REMINDER_FACADE,
  type CartReminderFacade,
  type IdleCart,
} from './cart-reminder.facade';
export {
  CART_ASSISTANT_FACADE,
  MAX_ASSISTANT_SELL_UNITS,
  type AssistantCart,
  type AssistantCartFailure,
  type AssistantCartGroup,
  type AssistantCartLine,
  type AssistantOfferUnits,
  type AssistantSellUnit,
  type CartAssistantFacade,
} from './cart-assistant.facade';
