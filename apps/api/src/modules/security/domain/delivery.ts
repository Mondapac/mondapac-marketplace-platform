import { Temporal } from '@mondapac/shared-kernel';
import {
  escalationChain,
  isBusinessTime,
  nextBusinessStart,
  onCallAt,
  type OnCallRoster,
} from './roster';
import type { SecuritySeverity } from './severity';

// Who hears of an alert, by which channel and when (decisions T3 and T4; plan section 4):
// - s1: SMS, a call and email, 24/7, to the member on call; every 10 minutes until someone
//   acknowledges, the next member of the escalation chain (rotation order, then the incident
//   commander), at most S1_MAX_STEPS steps;
// - s2: email and team chat to the member on call and the security owner, once, in business hours
//   (out of hours it waits for the next business start: "the next morning");
// - s3: the page and the daily digest; s4: the page and the weekly report. Nothing is pushed.

export type DeliveryChannel = 'email' | 'sms' | 'call' | 'team-chat';
export const DELIVERY_CHANNELS: readonly DeliveryChannel[] = ['email', 'sms', 'call', 'team-chat'];

/** What became of one message. */
export type DeliveryOutcome = 'sent' | 'failed' | 'not-configured' | 'no-contact';
export const DELIVERY_OUTCOMES: readonly DeliveryOutcome[] = [
  'sent',
  'failed',
  'not-configured',
  'no-contact',
];

export const S1_ESCALATION_INTERVAL = Temporal.Duration.from({ minutes: 10 });
/** Two hours of escalation; past it the alert stays open on the page and the incident is logged. */
export const S1_MAX_STEPS = 12;

export const CHANNELS_BY_SEVERITY: Readonly<Record<SecuritySeverity, readonly DeliveryChannel[]>> =
  Object.freeze({
    s1: ['sms', 'call', 'email'],
    s2: ['email', 'team-chat'],
    s3: [],
    s4: [],
  });

/** Whether an alert of this severity has a delivery step at all (s3 and s4 go to digests). */
export function isPushed(severity: SecuritySeverity): boolean {
  return CHANNELS_BY_SEVERITY[severity].length > 0;
}

export interface DeliveryMessage {
  readonly recipient: string;
  readonly channel: DeliveryChannel;
}

/** The next step of an open alert whose delivery is due. */
export interface DeliveryStep {
  /** The messages to send now; empty when the step only waits for business hours. */
  readonly messages: readonly DeliveryMessage[];
  /** The alert's step after this one (unchanged when it only waits). */
  readonly nextStep: number;
  /** When the following step is due, or null when nothing more is sent. */
  readonly nextNotifyAt: Temporal.Instant | null;
}

/** The step due for an open alert at `now`; `step` is how many steps were already taken. */
export function planDelivery(
  severity: SecuritySeverity,
  step: number,
  roster: OnCallRoster,
  now: Temporal.Instant,
): DeliveryStep {
  const channels = CHANNELS_BY_SEVERITY[severity];
  if (channels.length === 0) return { messages: [], nextStep: step, nextNotifyAt: null };
  if (severity === 's1') {
    if (step >= S1_MAX_STEPS) return { messages: [], nextStep: step, nextNotifyAt: null };
    const chain = escalationChain(roster, now);
    const recipient = chain[step % chain.length]!;
    return {
      messages: channels.map((channel) => ({ recipient, channel })),
      nextStep: step + 1,
      nextNotifyAt: step + 1 >= S1_MAX_STEPS ? null : now.add(S1_ESCALATION_INTERVAL),
    };
  }
  // s2: once, in business hours.
  if (step > 0) return { messages: [], nextStep: step, nextNotifyAt: null };
  if (!isBusinessTime(roster.hours, now)) {
    return { messages: [], nextStep: step, nextNotifyAt: nextBusinessStart(roster.hours, now) };
  }
  const recipients = [...new Set([onCallAt(roster, now), roster.securityOwner])];
  return {
    messages: recipients.flatMap((recipient) =>
      channels.map((channel) => ({ recipient, channel })),
    ),
    nextStep: step + 1,
    nextNotifyAt: null,
  };
}
