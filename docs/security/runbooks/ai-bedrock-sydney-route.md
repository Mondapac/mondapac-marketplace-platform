# Runbook: the Amazon Bedrock route in Sydney (AI Gateway)

Part of [incident-response.md](../incident-response.md). Owner of the AWS account steps: Kazem
(devops-engineer). Reviewer of the evidence: Hassan (security-tester). Decision to switch AI on:
john.

Context: ADR-0052 and `docs/design/domain/platform-ai.md` section 6. In AU the only route is the
`bedrock-mantle` route in `ap-southeast-2` (owner decision, 25 Nov 2026: Anthropic's own API has no
Australian region recorded, so there is no AU fallback). Its rows in
`apps/api/src/platform/ai/catalogue/bedrock.ts` stay unusable (`dataTerms: null`) until the
evidence below is recorded. Hassan's review of 25 Nov 2026 found the code ready and listed the
account conditions here (report: project file
`design/ai-gateway/build/bedrock-sydney-security-review-fa.html`).

What the AWS documentation says (read 25 Nov 2026; check again when you apply this):

- Endpoint `https://bedrock-mantle.{region}.api.aws/anthropic/v1/messages`, header
  `anthropic-version: 2023-06-01`, a Bedrock API key as `Authorization: Bearer`. The adapter
  (`anthropic-messages.provider.ts`) sends exactly this.
- Model ids on bedrock-mantle: `anthropic.claude-haiku-5-5` and `anthropic.claude-sonnet-5-5`.
  Cross-Region inference (geographic and global profiles) is not supported on bedrock-mantle, so a
  call to the Sydney host is served in Sydney. The Anthropic page lists Sydney as "Global, AU",
  which conflicts with this; E2 below settles it with a real call.
- Data retention on bedrock-mantle is set per Region, at account or project level. New accounts
  are `inherit`, which falls back to the model's default, and the default allows AWS to keep data
  for abuse prevention. `none` is zero data retention ("Chat Completions and Messages requests are
  never retained"). Bedrock does not share content with the model provider.
- Long-term API keys are "recommended only for exploration"; AWS recommends short-term keys or
  SigV4 for production (FE-20261125-ai-gateway-bedrock-short-term-keys).
- Regional endpoints cost 10 percent more than global ones; the catalogue prices carry that
  premium until E5 records the real price.

## Evidence to record before the rows are marked checked

Send each item to Hassan (screenshot or command output, with no key in it). All are in the AWS
account that will hold the production key, in `ap-southeast-2`.

| Id | Evidence | How |
| --- | --- | --- |
| E1 | Account data retention in `ap-southeast-2` is `none`, and both models list `none` in `allowed_modes` | Bedrock console, Data retention; or `GET /v1/data_retention` and `GET /v1/models/{model}` on the Sydney mantle host with an admin credential |
| E2 | Model access is granted for both models, and one synthetic call per model to the Sydney host answers 200 with the system prompt marked for caching | The curl below, with the production key, synthetic text only |
| E3 | A dedicated IAM user holds the key, with only the policy below; the key expires in 90 days or less | IAM console, the user and its service-specific credential |
| E4 | Model invocation logging is off in `ap-southeast-2` | Bedrock console, Settings |
| E5 | The price of both models in `ap-southeast-2` (input and output per million tokens) | AWS pricing page or AWS Marketplace listing |
| E6 | The guard that keeps retention at `none`: an SCP or IAM deny on changing it | AWS Organizations or IAM, the statement below |

Synthetic call for E2 (run once per model; never put customer data in it):

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  https://bedrock-mantle.ap-southeast-2.api.aws/anthropic/v1/messages \
  -H "Authorization: Bearer $AI_BEDROCK_KEY" \
  -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' \
  -d '{"model":"anthropic.claude-haiku-5-5","max_tokens":16,
       "system":[{"type":"text","text":"Answer with one word.","cache_control":{"type":"ephemeral"}}],
       "messages":[{"role":"user","content":[{"type":"text","text":"Say ok."}]}]}'
```

## IAM policy of the key's user (E3)

Replace `ACCOUNT_ID`. Check each action and condition key name in the IAM policy editor.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "LongTermBearerOnly",
      "Effect": "Allow",
      "Action": "bedrock-mantle:CallWithBearerToken",
      "Resource": "*",
      "Condition": { "StringEquals": { "bedrock-mantle:BearerTokenType": "LONG_TERM" } }
    },
    {
      "Sid": "TwoModelsInSydney",
      "Effect": "Allow",
      "Action": ["bedrock-mantle:CreateInference", "bedrock-mantle:CountTokens"],
      "Resource": "arn:aws:bedrock-mantle:ap-southeast-2:ACCOUNT_ID:project/*",
      "Condition": {
        "StringEquals": {
          "bedrock-mantle:Model": ["anthropic.claude-haiku-5-5", "anthropic.claude-sonnet-5-5"]
        }
      }
    },
    {
      "Sid": "NothingOutsideSydney",
      "Effect": "Deny",
      "Action": ["bedrock:*", "bedrock-mantle:*"],
      "Resource": "*",
      "Condition": { "StringNotEquals": { "aws:RequestedRegion": "ap-southeast-2" } }
    }
  ]
}
```

Guard for E6 (in an SCP, or on every admin role):

```json
{
  "Sid": "RetentionStaysNone",
  "Effect": "Deny",
  "Action": [
    "bedrock-mantle:PutAccountDataRetention",
    "bedrock-mantle:CreateProject",
    "bedrock-mantle:UpdateProject"
  ],
  "Resource": "*",
  "Condition": { "StringNotEquals": { "bedrock-mantle:DataRetentionMode": "none" } }
}
```

Create the key with `aws iam create-service-specific-credential --user-name <user>
--service-name bedrock.amazonaws.com --credential-age-days 90`. The value goes straight into the
secret manager as `AI_BEDROCK_API_KEY=AU=<key>` for the API, and into the GitHub Environment
`assistant-eval` as `ASSISTANT_EVAL_BEDROCK_API_KEY` (an evaluation key of its own is better: it
can be revoked alone). Never paste it in a chat, a ticket or a log.

## Order of switching AI on in AU

1. E1 to E6 are recorded and Hassan accepts them.
2. A PR fills `dataTerms` (date, reference to this evidence, reviewer Hassan) in both Bedrock rows,
   sets the E5 prices, updates the catalogue test and adds an entry to the ADR-0052 verification
   log. Merge with john's phrase.
3. Kazem sets `AI_BEDROCK_API_KEY` and restarts the API (keys are read at boot).
4. The `Assistant real-model evaluation` workflow runs on main with the model family (for example
   `claude-haiku-5-5`, tier `fast`). On a pass, a PR adds the entry to
   `apps/api/src/platform/ai/evaluations/results.ts` with the run link. Merge with john's phrase.
5. Before the first capability is on: the AU caps (day, month, guest pool) are set in the panel
   (AI Gateway, Limits). AU has no cap in Market config, so without this nothing is enforced.
6. john switches the capability on in the admin panel. The catalog description writer has no
   real-model evaluation yet, so it stays off.

## Switching it off (any time, no release)

- One Market: AI Gateway page, Emergency stop (no step-up needed to turn off).
- Every Market: `AI_KILL_SWITCH=true` and restart.
- The key itself: `aws iam update-service-specific-credential --status Inactive` for its id (also
  the first step if the key may have leaked; then follow [leaked-secret.md](leaked-secret.md)).
- If E1 is ever found not `none`: stop AI in AU at once, treat data sent since then as kept by AWS
  for up to its retention period, and open an incident (S2).
