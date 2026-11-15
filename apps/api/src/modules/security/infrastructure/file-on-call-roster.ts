import { readFileSync } from 'node:fs';
import { Temporal } from '@mondapac/shared-kernel';
import { z } from 'zod';
import type { OnCallRosterSource } from '../application/ports/on-call-roster';
import type { OnCallRoster } from '../domain/roster';

// The on-call roster file (SECURITY_ON_CALL_FILE; docs/design/data/security.md 5): JSON, outside
// the repository (it holds people's addresses and phone numbers), read once at boot. A file that
// is set but does not parse stops the boot with a message that names the field, never a value.
// config/security/on-call.example.json shows the shape.

const CODE = /^[a-z][a-z0-9-]{0,31}$/;
const TIME = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const minuteOf = (time: string): number => {
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  return hour * 60 + minute;
};

const isZone = (zone: string): boolean => {
  try {
    Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(zone);
    return true;
  } catch {
    return false;
  }
};

const memberSchema = z
  .object({
    code: z.string().regex(CODE),
    name: z.string().min(1).max(64),
    accountId: z.string().regex(UUID).nullable().default(null),
    email: z.email().max(254).nullable().default(null),
    phone: z
      .string()
      .regex(/^\+[1-9][0-9]{6,14}$/)
      .nullable()
      .default(null),
  })
  .strict();

const rosterSchema = z
  .object({
    businessHours: z
      .object({
        zone: z.string().refine(isZone, 'unknown zone'),
        start: z.string().regex(TIME),
        end: z.string().regex(TIME),
        days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
      })
      .strict(),
    members: z.array(memberSchema).min(1).max(32),
    rotation: z.array(z.string().regex(CODE)).min(1).max(16),
    /** The local start of the first rotation week, `YYYY-MM-DDTHH:MM`. */
    rotationStart: z.string().regex(/^\d{4}-\d{2}-\d{2}T([01][0-9]|2[0-3]):[0-5][0-9]$/),
    incidentCommander: z.string().regex(CODE),
    securityOwner: z.string().regex(CODE),
  })
  .strict()
  .superRefine((value, issue) => {
    const codes = value.members.map((member) => member.code);
    if (new Set(codes).size !== codes.length)
      issue.addIssue({ code: 'custom', path: ['members'], message: 'duplicate code' });
    for (const [path, code] of [
      ...value.rotation.map((code, index) => [`rotation.${index}`, code] as const),
      ['incidentCommander', value.incidentCommander] as const,
      ['securityOwner', value.securityOwner] as const,
    ]) {
      if (!codes.includes(code))
        issue.addIssue({ code: 'custom', path: [path], message: 'unknown member' });
    }
    if (minuteOf(value.businessHours.start) >= minuteOf(value.businessHours.end)) {
      issue.addIssue({
        code: 'custom',
        path: ['businessHours'],
        message: 'start must be before end',
      });
    }
  });

/** Thrown at boot for a roster file that is set but unusable; names fields only. */
export class OnCallRosterFileError extends Error {
  override readonly name = 'OnCallRosterFileError';
}

/** Parses the roster file's text; the error lists the failing paths, never a value. */
export function parseOnCallRoster(text: string): OnCallRoster {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new OnCallRosterFileError('SECURITY_ON_CALL_FILE is not JSON');
  }
  const parsed = rosterSchema.safeParse(json);
  if (!parsed.success) {
    const paths = [
      ...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(root)')),
    ];
    throw new OnCallRosterFileError(
      `SECURITY_ON_CALL_FILE is not a valid roster: ${paths.slice(0, 10).join(', ')}`,
    );
  }
  const value = parsed.data;
  return Object.freeze({
    hours: Object.freeze({
      zone: value.businessHours.zone,
      startMinute: minuteOf(value.businessHours.start),
      endMinute: minuteOf(value.businessHours.end),
      days: Object.freeze([...new Set(value.businessHours.days)].sort()),
    }),
    members: Object.freeze(value.members.map((member) => Object.freeze({ ...member }))),
    rotation: Object.freeze([...value.rotation]),
    rotationStart: Temporal.PlainDateTime.from(value.rotationStart),
    incidentCommander: value.incidentCommander,
    securityOwner: value.securityOwner,
  });
}

/** The roster read once from the file, or none when the variable is unset. */
export class FileOnCallRoster implements OnCallRosterSource {
  readonly #roster: OnCallRoster | null;

  constructor(
    path: string | null,
    read: (path: string) => string = (file) => readFileSync(file, 'utf8'),
  ) {
    if (path === null) {
      this.#roster = null;
      return;
    }
    let text: string;
    try {
      text = read(path);
    } catch {
      throw new OnCallRosterFileError('SECURITY_ON_CALL_FILE cannot be read');
    }
    this.#roster = parseOnCallRoster(text);
  }

  roster(): OnCallRoster | null {
    return this.#roster;
  }
}
