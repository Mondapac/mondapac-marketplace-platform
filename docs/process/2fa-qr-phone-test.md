# Two-step enrolment QR: what CI proves and the phone test

## What CI proves (no phone)

`apps/admin` and `apps/seller` each run `src/auth/setup-qr.spec.tsx`. It renders `SetupQr` with an
`otpauth://totp/` URI shaped exactly like the one the API issues (`identity/domain/otpauth.ts`),
rasterises the SVG and reads it back with the `jsqr` decoder (dev dependency of both apps, test only).
The decoded text must equal the issued URI byte for byte, for a plain issuer, an issuer with a space and
a plus address, and a non-ASCII issuer. It also checks `secret`, `issuer`, `algorithm=SHA1`, `digits=6`
and `period=30`. The API side is pinned by `otpauth.spec.ts`.

This does not prove a phone camera reads the code from a given screen; only a real scan does.

## Phone test (about 5 minutes)

1. Start the demo (`scripts\demo-local.bat`) and open the admin panel; invite a second admin, or start
   two-step enrolment for an account that has none, until the QR code appears.
2. On the phone, open one app, choose to add an account by scanning a QR code, hold the phone 20 to
   30 cm from the screen with the whole code and its white border in view.
3. Success: the app adds an entry named `MondaPac` with the sign-in address underneath, and shows a
   six-digit code that changes every 30 seconds.
4. Type that code into the panel. Success: enrolment completes and the recovery codes appear.
5. Repeat for Google Authenticator, Microsoft Authenticator and Authy. Then try the typed setup key under
   the QR in one app as a fallback.
6. If a scan fails, note the app, the phone and the screen size; try browser zoom 100 percent first.
