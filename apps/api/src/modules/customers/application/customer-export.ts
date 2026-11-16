import type { CustomerListRow } from '../domain/customer-list';

// The file of the Customers export: pure text functions, no I/O.

/** The columns of the file, as the page's column picker names them; email is always the first. */
export const CUSTOMER_EXPORT_COLUMNS = [
  'name',
  'status',
  'verified',
  'joined',
  'last-order',
  'orders',
  'spent',
  'currency',
  'refunds',
  'groups',
] as const;
export type CustomerExportColumn = (typeof CUSTOMER_EXPORT_COLUMNS)[number];

export const CUSTOMER_EXPORT_HEADERS: Readonly<Record<CustomerExportColumn | 'email', string>> =
  Object.freeze({
    email: 'Email',
    name: 'Name',
    status: 'Status',
    verified: 'Email verified',
    joined: 'Joined',
    'last-order': 'Last order',
    orders: 'Orders',
    spent: 'Spent (minor units)',
    currency: 'Currency',
    refunds: 'Refunds',
    groups: 'Groups',
  });

export function exportCell(column: CustomerExportColumn, row: CustomerListRow): string {
  switch (column) {
    case 'name':
      return row.displayName ?? '';
    case 'status':
      return row.status === 'disabled' ? 'Disabled' : 'Active';
    case 'verified':
      return row.emailVerified ? 'Yes' : 'No';
    case 'joined':
      return row.signedUpAt.toString();
    case 'last-order':
      return row.lastOrderAt === null ? '' : row.lastOrderAt.toString();
    case 'orders':
      return String(row.orderCount);
    case 'spent':
      return row.spentMinor.toString();
    case 'currency':
      return row.currency ?? '';
    case 'refunds':
      return String(row.refundCount);
    case 'groups':
      return row.groups.map((group) => group.name).join('; ');
  }
}
