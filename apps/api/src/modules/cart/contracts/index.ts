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
