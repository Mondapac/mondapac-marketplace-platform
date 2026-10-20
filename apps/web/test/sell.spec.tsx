// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { resendSellerEmail, signUpSeller } from '../src/sell/actions.ts';
import { SellFaq } from '../src/sell/sell-faq.tsx';
import { SellerSignUpCard } from '../src/sell/seller-sign-up-card.tsx';
import { checkSignUp, minutesOf } from '../src/sell/sign-up-rules.ts';
import { loadSellerSignUp } from '../src/storefront/source.ts';
import type { SellerSignUpAnswer } from '../src/storefront/types.ts';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const RULE = { min: 15, max: 128 };
const GOOD = {
  name: 'Maryam Rahimi',
  email: 'maryam@example.com',
  password: 'river stone apple tea',
};
const SIGN_IN = 'https://seller.example.test/sign-in';

function renderCard(
  submit: (input: typeof GOOD) => Promise<SellerSignUpAnswer> = () =>
    Promise.resolve({ kind: 'accepted' }),
  resend: (email: string) => Promise<SellerSignUpAnswer> = () =>
    Promise.resolve({ kind: 'accepted' }),
) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <SellerSignUpCard
        passwordMin={15}
        passwordMax={128}
        signInUrl={SIGN_IN}
        submit={submit}
        resend={resend}
      />
    </NextIntlClientProvider>,
  );
}

function fill(values: Partial<typeof GOOD> = GOOD) {
  if (values.name !== undefined)
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: values.name } });
  if (values.email !== undefined)
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: values.email } });
  if (values.password !== undefined)
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: values.password } });
}

const create = () => fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

describe('seller sign-up rules', () => {
  it('accepts a name, an email and a password of the Market length', () => {
    expect(checkSignUp(GOOD, RULE)).toEqual({});
    expect(checkSignUp({ ...GOOD, name: '  J. R. Smith ' }, RULE)).toEqual({});
  });

  it('refuses empty fields', () => {
    expect(checkSignUp({ name: ' ', email: '', password: '' }, RULE)).toEqual({
      name: 'required',
      email: 'required',
      password: 'required',
    });
  });

  it('refuses a name with a web address, a control or a bidi character (HF13)', () => {
    for (const name of [
      'Visit https://x.test',
      'www.shop',
      'shop.example.com',
      'myshop.com',
      'Ali‮Reza',
      'Ali\u0007',
      'Ali⁦',
    ])
      expect(checkSignUp({ ...GOOD, name }, RULE).name).toBe('name-characters');
    expect(checkSignUp({ ...GOOD, name: 'a'.repeat(101) }, RULE).name).toBe('name-length');
  });

  it('checks the email shape and the password length in code points', () => {
    expect(checkSignUp({ ...GOOD, email: 'maryam@' }, RULE).email).toBe('email-format');
    expect(checkSignUp({ ...GOOD, password: 'a'.repeat(14) }, RULE).password).toBe(
      'password-short',
    );
    expect(checkSignUp({ ...GOOD, password: '😀'.repeat(15) }, RULE)).toEqual({});
    expect(checkSignUp({ ...GOOD, password: 'a'.repeat(129) }, RULE).password).toBe(
      'password-long',
    );
  });

  it('rounds a wait up to whole minutes, at least one', () => {
    expect(minutesOf(1)).toBe(1);
    expect(minutesOf(600)).toBe(10);
    expect(minutesOf(601)).toBe(11);
  });
});

describe('seller sign-up server actions', () => {
  it('checks the input again and answers the same for every valid address', async () => {
    await expect(signUpSeller(GOOD)).resolves.toEqual({ kind: 'accepted' });
    await expect(signUpSeller({ ...GOOD, password: 'short' })).resolves.toEqual({
      kind: 'invalid',
      fields: { password: 'password-short' },
    });
    await expect(signUpSeller({ name: 1, email: 'a@b.co', password: 'x' })).resolves.toEqual({
      kind: 'failed',
    });
    await expect(signUpSeller(null)).resolves.toEqual({ kind: 'failed' });
    await expect(resendSellerEmail(GOOD.email)).resolves.toEqual({ kind: 'accepted' });
    await expect(resendSellerEmail(42)).resolves.toEqual({ kind: 'failed' });
  });

  it('takes the password rule from the Market setup', async () => {
    const setup = await loadSellerSignUp();
    expect(setup.passwordMinLength).toBeGreaterThan(0);
    expect(setup.passwordMaxLength).toBeGreaterThanOrEqual(setup.passwordMinLength);
  });
});

describe('seller sign-up card', () => {
  it('has name, email and password only, with the password rule and the sign-in link', () => {
    const { container } = renderCard();
    const inputs = [...container.querySelectorAll('input')].map((input) => input.name);
    expect(inputs).toEqual(['name', 'email', 'password']);
    expect(screen.getByText('15 to 128 characters.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe(SIGN_IN);
    expect(screen.getByRole('link', { name: 'privacy policy' }).getAttribute('href')).toBe(
      '/privacy',
    );
    expect(
      screen.getByText('Seller and customer accounts are separate. Each has its own password.'),
    ).toBeTruthy();
  });

  it('shows the password with the eye button, whose name says what it does', () => {
    renderCard();
    const input = screen.getByLabelText('Password');
    const eye = screen.getByRole('button', { name: 'Show password' });
    expect(input.getAttribute('type')).toBe('password');
    fireEvent.click(eye);
    expect(input.getAttribute('type')).toBe('text');
    expect(eye.getAttribute('aria-pressed')).toBe('true');
    expect(eye.getAttribute('aria-label')).toBe('Hide password');
  });

  it('marks each bad field and moves focus to the first one, without sending', () => {
    const submit = vi.fn(() => Promise.resolve<SellerSignUpAnswer>({ kind: 'accepted' }));
    renderCard(submit);
    fill({ name: '', email: 'nope', password: 'short' });
    create();
    expect(submit).not.toHaveBeenCalled();
    const name = screen.getByLabelText('Your name');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(name);
    const help = document.getElementById(name.getAttribute('aria-describedby') ?? '');
    expect(help?.textContent).toBe('Enter your name.');
    expect(screen.getByText('Enter an email address like name@example.com.')).toBeTruthy();
    expect(
      screen.getByText('Use at least 15 characters. A few short words in a row work well.'),
    ).toBeTruthy();
  });

  it('turns into Check your email with the address, and never says whether it is known', async () => {
    const submit = vi.fn(() => Promise.resolve<SellerSignUpAnswer>({ kind: 'accepted' }));
    renderCard(submit);
    fill();
    create();
    const title = await screen.findByRole('heading', { name: 'Check your email' });
    expect(submit).toHaveBeenCalledWith(GOOD);
    expect(document.activeElement).toBe(title);
    expect(screen.getByText('maryam@example.com').tagName).toBe('B');
    expect(screen.getByRole('link', { name: 'Back to sign in' }).getAttribute('href')).toBe(
      SIGN_IN,
    );
    expect(document.body.textContent).not.toMatch(/already/i);
  });

  it('sends it again with the same address and says so in the status line', async () => {
    const resend = vi.fn(() => Promise.resolve<SellerSignUpAnswer>({ kind: 'accepted' }));
    renderCard(undefined, resend);
    fill();
    create();
    await screen.findByRole('heading', { name: 'Check your email' });
    fireEvent.click(screen.getByRole('button', { name: 'Send it again' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('We sent it again.'));
    expect(resend).toHaveBeenCalledWith('maryam@example.com');
  });

  it('goes back to the form with the name and email kept when the address was wrong', async () => {
    renderCard();
    fill();
    create();
    await screen.findByRole('heading', { name: 'Check your email' });
    fireEvent.click(screen.getByRole('button', { name: 'Wrong address? Sign up again' }));
    const email = screen.getByLabelText<HTMLInputElement>('Email');
    expect(email.value).toBe(GOOD.email);
    expect(screen.getByLabelText<HTMLInputElement>('Your name').value).toBe(GOOD.name);
    expect(screen.getByLabelText<HTMLInputElement>('Password').value).toBe('');
    expect(document.activeElement).toBe(email);
  });

  it('shows the field errors the server returns', async () => {
    renderCard(() => Promise.resolve({ kind: 'invalid', fields: { password: 'password-common' } }));
    fill();
    create();
    expect(
      await screen.findByText('That password is too easy to guess. Choose a different one.'),
    ).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('Password'));
  });

  it('when throttled, says how long to wait and keeps the button off until then', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderCard(() => Promise.resolve({ kind: 'throttled', retryAfterSeconds: 540 }));
    fill();
    create();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Too many attempts. Please wait 9 minutes and try again.');
    const button = await screen.findByRole<HTMLButtonElement>('button', { name: 'Create account' });
    expect(button.disabled).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(9 * 60 * 1000));
    expect(button.disabled).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('on a server error says nothing was saved and keeps what was typed', async () => {
    renderCard(() => Promise.reject(new Error('down')));
    fill();
    create();
    expect((await screen.findByRole('alert')).textContent).toBe(
      'We could not create your account just now. Nothing was saved. Please try again.',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Email').value).toBe(GOOD.email);
  });
});

describe('sell page questions', () => {
  it('keeps one question open at a time', () => {
    const { container } = render(
      <SellFaq
        items={[
          { question: 'One?', answer: 'A' },
          { question: 'Two?', answer: 'B' },
        ]}
      />,
    );
    const [first, second] = [...container.querySelectorAll('details')];
    expect(first?.getAttribute('name')).toBe('sgfaq');
    first!.open = true;
    fireEvent(first!, new Event('toggle'));
    second!.open = true;
    fireEvent(second!, new Event('toggle'));
    expect(first!.open).toBe(false);
    expect(second!.open).toBe(true);
  });
});
