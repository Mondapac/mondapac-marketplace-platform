// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsNoAccess } from './settings-no-access.tsx';

afterEach(cleanup);
const show = (permissionKeys: string[]) =>
  render(
    <SettingsNoAccess
      permissionKeys={permissionKeys}
      title="No access"
      body="Ask the owner."
      labels={{ settings: 'Back to Settings', home: 'Back to Dashboard' }}
    />,
  );

describe('SettingsNoAccess', () => {
  it('leads back to Settings when the hub has a page for the caller', () => {
    show(['inventory.stock.view']);
    expect(screen.getByRole('link', { name: 'Back to Settings' }).getAttribute('href')).toBe(
      '/settings',
    );
  });

  it('leads to the dashboard when the caller holds no settings page', () => {
    show(['ordering.seller-order.view']);
    expect(screen.getByRole('link', { name: 'Back to Dashboard' }).getAttribute('href')).toBe('/');
    expect(screen.queryByRole('link', { name: 'Back to Settings' })).toBeNull();
  });
});
