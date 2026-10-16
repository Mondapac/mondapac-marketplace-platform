/**
 * The text message transport (Phase 6 package 4): a port, like the mail transport. A message
 * arrives fully rendered; the transport knows no template, no locale and no business rule. No
 * provider is chosen yet, so the only adapter in the application is {@link UnconfiguredSmsTransport};
 * a real provider is one more class behind this port plus a line in `smsTransportFor`.
 *
 * A message holds a phone number (personal data). It is never logged, put in an error or an
 * event: an adapter's error carries a fixed code only.
 */
export interface SmsMessage {
  /** The one recipient's number in international format (E.164), e.g. `+61412345678`. */
  readonly to: string;
  /** The sender id from the Market's configuration (alphanumeric, at most 11 characters). */
  readonly from: string;
  /** Plain text only. */
  readonly text: string;
}

/** Why a send failed: a code, never a provider message or a value. */
export type SmsSendFailure =
  | 'sms.transport-unconfigured'
  | 'sms.transport-unreachable'
  | 'sms.transport-timeout'
  | 'sms.transport-refused';

/** A failed send. The event dispatcher retries the delivery after its back-off. */
export class SmsSendError extends Error {
  override readonly name = 'SmsSendError';
  constructor(readonly code: SmsSendFailure) {
    super(`The text message was not sent: ${code}`);
  }
}

export interface SmsTransport {
  /**
   * Resolves when the provider accepted the message; throws {@link SmsSendError} otherwise. An
   * adapter ends a request on its own timeout, at most 5 seconds.
   */
  send(message: SmsMessage): Promise<void>;
}

/** Nest token of the {@link SmsTransport}. */
export const SMS_TRANSPORT = Symbol('SMS_TRANSPORT');

/** Used until a provider is chosen: every send fails with a fixed code, nothing leaves the process. */
export class UnconfiguredSmsTransport implements SmsTransport {
  send(): Promise<void> {
    return Promise.reject(new SmsSendError('sms.transport-unconfigured'));
  }
}
