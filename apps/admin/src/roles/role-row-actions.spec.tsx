// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { RoleRowActions } from './role-row-actions.tsx';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const ID = '0190a000-0000-7000-8000-0000000000a3';
const show = (editable: boolean, canDuplicate: boolean) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <RoleRowActions
        roleId={ID}
        name="Night shift"
        editable={editable}
        canDuplicate={canDuplicate}
      />
    </NextIntlClientProvider>,
  );

describe('role row actions', () => {
  afterEach(() => {
    cleanup();
    push.mockReset();
  });

  it('opens the editor from Edit role and asks nothing first', () => {
    show(true, false);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Night shift' }));
    expect(screen.queryByRole('menuitem', { name: 'Duplicate role' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit role' }));
    expect(push).toHaveBeenCalledWith(`/settings/roles/${ID}`);
  });

  it('offers View role for a role that cannot be edited, and Duplicate role with the permission', () => {
    show(false, true);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Night shift' }));
    expect(screen.getByRole('menuitem', { name: 'View role' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate role' }));
    expect(push).toHaveBeenCalledWith(`/settings/roles/new?from=${ID}`);
  });
});
