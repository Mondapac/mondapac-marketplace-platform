import { auditField, defineAuditAction } from '@mondapac/shared-kernel';
import type { PeriodId } from './period';

// The audited actions of reporting (dashboards v2, PR 5), registered at boot with
// `registerAuditActions('reporting', REPORTING_AUDIT_ACTIONS)`: each daily export. A row names the
// range, the file format and how many rows left; never a figure of the file.

/** The audit target type of the marketplace daily export; the target id is fixed. */
export const MARKETPLACE_REPORT_TARGET = 'reporting.marketplace-report';

/** The audit target type of a seller's daily export; the target id is the seller. */
export const SELLER_REPORT_TARGET = 'reporting.seller-report';

/**
 * The range of an export: the preset or `custom`, and the instants it covers in the Market's zone
 * (the start of its first day, the start of the day after its last), with its count of days.
 */
/** An audit code is a lower-case word, so `7d` is written `last-7-days`. */
export const AUDIT_PERIOD = {
  today: 'today',
  '7d': 'last-7-days',
  '30d': 'last-30-days',
  month: 'month-to-date',
  custom: 'custom',
} as const satisfies Record<PeriodId | 'custom', string>;

const RANGE = {
  period: auditField.enumOf([
    'today',
    'last-7-days',
    'last-30-days',
    'month-to-date',
    'custom',
  ] as const),
  rangeStart: auditField.instant(),
  rangeEnd: auditField.instant(),
  days: auditField.integer(),
  format: auditField.enumOf(['csv', 'xlsx'] as const),
  rowCount: auditField.integer(),
};

/** An admin downloaded the marketplace's daily figures for a range. */
export const MarketplaceDailyExported = defineAuditAction({
  action: 'reporting.marketplace-daily.exported',
  targetType: MARKETPLACE_REPORT_TARGET,
  targetId: auditField.enumOf(['marketplace-daily'] as const),
  actors: ['authenticated'],
  after: RANGE,
});

/** A seller's team member (or an admin in Login as Seller) downloaded the shop's daily figures. */
export const SellerDailyExported = defineAuditAction({
  action: 'reporting.seller-daily.exported',
  targetType: SELLER_REPORT_TARGET,
  actors: ['authenticated'],
  after: RANGE,
});

/** The audit target type of a seller's monthly goal; the target id is the seller. */
export const SELLER_GOAL_TARGET = 'reporting.seller-goal';

/**
 * A seller's team member (or an admin in Login as Seller) set the shop's goal for a month: the
 * month (the instant its first day starts in the Market's zone), the goal before (null: none) and
 * after, and the new version.
 */
export const SellerMonthlyGoalChanged = defineAuditAction({
  action: 'reporting.seller-goal.changed',
  targetType: SELLER_GOAL_TARGET,
  actors: ['authenticated'],
  before: { goal: auditField.optional(auditField.money()) },
  after: {
    monthStart: auditField.instant(),
    goal: auditField.money(),
    version: auditField.integer(),
  },
});

export const REPORTING_AUDIT_ACTIONS = [
  MarketplaceDailyExported,
  SellerDailyExported,
  SellerMonthlyGoalChanged,
] as const;
