// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TextField } from './text-field.tsx';

afterEach(cleanup);

describe('TextField errors', () => {
  it('shows an error as text tied to the input, without an alert role by default', () => {
    render(<TextField label="Name" error="Enter a name." />);
    expect(screen.queryByRole('alert')).toBeNull();
    const input = screen.getByLabelText('Name');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toContain(screen.getByText('Enter a name.').id);
  });

  it('announces the error once as an alert when asked to', () => {
    render(<TextField label="Name" error="Enter a name." announceError />);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).toBe('Enter a name.');
  });
});

describe('TextField framedPrefix', () => {
  it('puts one frame round the prefix and the input, with a borderless input', () => {
    const { container } = render(<TextField label="Price" prefix="$" framedPrefix />);
    const input = screen.getByLabelText('Price');
    expect(input.className).toContain('border-0');
    const frame = container.querySelector('input')!.parentElement!;
    expect(frame.className).toContain('border-line-input');
    expect(frame.textContent).toBe('$');
  });

  it('shows the error colour on the frame, not on the input', () => {
    const { container } = render(
      <TextField label="Price" prefix="$" framedPrefix error="Needs price" />,
    );
    const frame = container.querySelector('input')!.parentElement!;
    expect(frame.className).toContain('border-critical-solid');
    expect(screen.getByLabelText('Price').className).not.toContain('border-critical-solid');
  });

  it('keeps the unframed prefix look when framedPrefix is off', () => {
    render(<TextField label="Slug" prefix="/l/" />);
    expect(screen.getByLabelText('Slug').className).toContain('rounded-e-md');
  });
});
