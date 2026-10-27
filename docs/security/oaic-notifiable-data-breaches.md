# Australian Notifiable Data Breaches (NDB) scheme: working note

Part of [incident-response.md](incident-response.md). Used by [runbooks/customer-data-breach.md](runbooks/customer-data-breach.md).

> This note is an operational summary, not legal advice. Before deciding whether to notify, john gets legal advice. Check the current OAIC guidance, because the law and forms change: `<link to current OAIC NDB guidance, confirm before use>`.

## What the scheme requires

Under Part IIIC of the Privacy Act 1988, an organisation covered by the Act must notify the Office of the Australian Information Commissioner (OAIC) and affected individuals when there is an **eligible data breach**. Whether Mondapac is covered (for example by turnover or by handling certain data) is a legal question for the legal adviser: `<legal adviser to confirm coverage>`. Treat the process as applying until told otherwise.

## Eligible data breach: the test

All three parts must be met.

1. **Unauthorised access, unauthorised disclosure, or loss** of personal information held by us, where loss makes access or disclosure likely.
2. **Likely to result in serious harm** to one or more individuals (physical, psychological, emotional, financial, reputational). Consider the kind of data (identity, contact, financial, location, order history), how sensitive it is, whether it was protected (encrypted, hashed), who could have it and whether they may mean harm, and how long it was exposed.
3. **Remedial action has not prevented the likely serious harm.** If we act in time so that, because of that action, serious harm is no longer likely (for example the data was recovered before use, or the access was blocked and shown unused), the breach is not notifiable. The reasoning must be recorded.

Cards: Mondapac does not store card numbers (hosted fields at Stripe), but confirm this for each incident.

## Timeline

| Step | Time |
| --- | --- |
| Reasonable grounds to suspect an eligible breach: begin assessment | Immediately |
| Complete the assessment | Within 30 days of becoming aware of the suspicion; act faster when serious harm is plausible |
| If an eligible breach is confirmed: prepare the statement and notify | As soon as practicable after forming the belief |

Do not wait for the full 30 days when it is already clear that harm is likely. Do contain first, assess in parallel.

## How to notify

1. Prepare a statement for the OAIC (the OAIC online form is the usual route): our identity and contact details, a description of the breach, the kinds of information involved, and recommended steps for affected individuals.
2. Notify the individuals. The Act gives three options:
   - notify all individuals whose information was involved;
   - notify only those at likely risk of serious harm;
   - if neither is practicable, publish the statement on our website and take reasonable steps to publicise it.
3. Preferred channel: the contact the person gave us (email), in plain language: what happened, what data, what we did, what they should do (for example change a reused password), how to contact us. Never ask for passwords, OTP codes or card numbers in the message.
4. Other duties may apply at the same time: a contractual duty to Stripe or carriers, other countries' laws if the data subjects live elsewhere, and cyber insurance conditions (`<insurer notice period, if any>`).

## Who decides

| Decision | Decides | Inputs |
| --- | --- | --- |
| Is it an eligible data breach; notify OAIC and people | john, with Ali (CTO) and Hassan (security testing) | Legal advice, scoping from Mojtaba and Hossein |
| Wording and sending customer message | john with Hadi (product owner) | Draft by Hadi, facts checked by Ali |
| Technical facts (what data, how many, how long) | Ali, with Hassan, Mojtaba, Hossein | Logs, audit trail, database review |

Responders do not contact the OAIC or customers on their own.

## Record keeping

Keep for every suspected breach, notifiable or not, in the private incident folder `<incident evidence location>` (Australian region):

1. Date and time first suspected, date assessment completed.
2. What happened, systems and data involved, number and kind of people.
3. Evidence reviewed (log ranges, audit chain verification result).
4. Remedial action taken and when.
5. The serious-harm reasoning and the decision, with who decided and the legal advice reference.
6. Copies of the OAIC statement and customer messages sent, with dates.

Security events and audit entries are kept as they are, never edited or deleted (see [incident-response.md](incident-response.md)). Retention follows [on-call-handbook.md](on-call-handbook.md). Do not put personal data lists into this repository.

## PCI DSS

Cards are entered into Stripe's hosted fields, so card data does not touch our servers. Mondapac is expected to remain at **SAQ A**, the shortest PCI DSS self-assessment. This depends on two conditions we must keep true:

1. A Content-Security-Policy with a working violation report endpoint (CSP report endpoint is planned in SOC package 4 and is a launch blocker).
2. Protection of the payment page: no unreviewed scripts, changes through review, alerts for new script sources (see [runbooks/unknown-script-csp.md](runbooks/unknown-script-csp.md)).

If either fails, tell john: the SAQ level may change. Confirm the exact SAQ and its yearly attestation with Stripe and the legal or compliance adviser.
