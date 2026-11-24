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
