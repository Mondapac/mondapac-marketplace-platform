// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { OtpColumn, OtpField, otpRowWidth } from './otp-field.tsx';
import { TextField } from './text-field.tsx';

afterEach(cleanup);

const digitLabel = (position: number, total: number) => `Digit ${position} of ${total}`;

describe('OtpField', () => {
  it('focuses the first box on mount when asked', () => {
    render(<OtpField label="6-digit code" digitLabel={digitLabel} autoFocus />);
    expect(document.activeElement).toBe(screen.getByLabelText('Digit 1 of 6'));
  });

  it('leaves focus alone without autoFocus', () => {
    render(<OtpField label="6-digit code" digitLabel={digitLabel} />);
    expect(document.activeElement).toBe(document.body);
  });

  it('adds the step instructions and the error to the group description', () => {
    render(
      <>
        <p id="body">Open your authenticator app.</p>
        <OtpField label="6-digit code" digitLabel={digitLabel} describedBy="body" error="Wrong" />
      </>,
    );
    const group = screen.getByRole('group', { name: '6-digit code' });
    const ids = (group.getAttribute('aria-describedby') ?? '').split(' ');
    expect(ids[0]).toBe('body');
    expect(ids).toHaveLength(2);
    expect(document.getElementById(ids[1] ?? '')?.textContent).toBe('Wrong');
  });

  it('has no description when there is neither instructions nor an error', () => {
    render(<OtpField label="6-digit code" digitLabel={digitLabel} />);
    expect(screen.getByRole('group').hasAttribute('aria-describedby')).toBe(false);
  });

  it('sizes each box to at most 3rem with 0.5rem gaps, the sizes otpRowWidth adds up', () => {
    render(<OtpField label="6-digit code" digitLabel={digitLabel} />);
    const box = screen.getByLabelText('Digit 1 of 6');
    expect(box.className).toContain('max-w-12');
    expect(box.className).toContain('min-w-0');
    expect(box.className).toContain('flex-1');
    expect(box.parentElement?.className).toContain('gap-2');
  });
});

describe('OtpColumn', () => {
  it('is as wide as the row of boxes and fills narrower parents', () => {
    render(
      <OtpColumn>
        <span>inside</span>
      </OtpColumn>,
    );
    const column = screen.getByText('inside').parentElement as HTMLElement;
    expect(column.style.maxWidth).toBe(otpRowWidth(6));
    expect(column.className).toContain('w-full');
  });

  it('follows the number of boxes', () => {
    expect(otpRowWidth(6)).toBe('20.5rem');
    expect(otpRowWidth(8)).toBe('27.5rem');
  });
});

describe('TextField describedBy', () => {
  it('puts outside text first in the description, before help and error', () => {
    render(
      <>
        <p id="body">Instructions</p>
        <TextField label="Backup code" describedBy="body" help="Ten characters" error="Wrong" />
      </>,
    );
    const ids = (screen.getByLabelText('Backup code').getAttribute('aria-describedby') ?? '').split(
      ' ',
    );
    expect(ids[0]).toBe('body');
    expect(ids).toHaveLength(3);
  });
});
