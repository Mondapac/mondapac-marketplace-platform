# Runbook: unknown script or CSP violation

Part of [incident-response.md](../incident-response.md). The payment page matters most: keeping CSP and payment-page protection in place is the condition for PCI DSS SAQ A (see [oaic-notifiable-data-breaches.md](../oaic-notifiable-data-breaches.md)).

## Trigger and signals

- CSP violation reports naming a script source that is not in the approved list, especially on cart or checkout.
- A customer or tester reports a strange pop-up, redirect or extra form.
- A release introduced a new third-party script.
- Stripe or a security tool warns about changed page content.

## Severity

S2 for an unknown script on the payment page or any page with a form. S4 for a repeated report that is clearly a browser extension. If data was captured, S1 and also [customer-data-breach.md](customer-data-breach.md).

## What exists today

The storefront, seller and admin apps send a Content-Security-Policy through their own code (`apps/web/src/security/storefront-csp.ts`, `apps/admin/src/server/security-headers.ts`, `apps/seller/src/server/security-headers.ts`). The CSP report endpoint that collects violations is a launch blocker and is planned in SOC package 4; its events then flow into security events. Until it exists, there is no central view of reports. Fallback: browser developer console on the page, and a review of the page source and the last releases.

## Automatic actions

None (plan section 5). Alerts for CSP reports arrive with packages 2 and 4.

## Human steps

1. Acknowledge. Note the page, the blocked or loaded source (domain, script path, not user data), time and browser.
2. Reproduce in a clean browser profile with no extensions, to tell an extension from a real injection.
3. Find the source: compare the page's scripts with the code and the CSP allow-list. Check recent releases and dependency updates for something that adds the script.
4. If the source is not ours: remove or block it. Remove the line in the code or tighten the CSP, review, deploy. Do not allow-list an unknown domain to silence reports.
5. If it came from a dependency or supply chain: see [vulnerable-dependency.md](vulnerable-dependency.md); pin or roll back to the last good release.
6. Check whether the payment form could have been affected. Card fields are Stripe's hosted fields (inside Stripe's frame), so the script could not read card numbers from them, but it could redirect or overlay. If there is any doubt, ask Ali or john about pausing checkout (payment kill switch planned in package 3; fallback in [payment-fraud.md](payment-fraud.md)).
7. Review the audit trail for admin changes to content or settings that could have injected the script (a stolen admin account: [admin-account-takeover.md](admin-account-takeover.md)).
8. If customers were exposed, john with Hadi decides what to tell them.

## Verification

1. Clean browser profile loads the pages with no unknown sources.
2. CSP reports for the source stop.
3. The payment page was tested end to end in test mode.

## Close-out

Postmortem for S2. Actions: report-only policy tests before each release, an allow-list owner (Hassan), Subresource Integrity for third-party scripts, an alert rule on new sources.
