---
name: mondapac-role-review
description: Use when a MondaPac proposal or owner request needs review by team roles (e.g. product-owner, software-architect, cto, security) before docs are changed or the owner decides.
---

# MondaPac role review

Team roles are agent files in `.claude/agents/`. Names and role ids:

| Name | Role id |
|---|---|
| Ali | cto |
| Hadi | product-owner |
| Mohammad | software-architect |
| Mojtaba | database-designer |
| Jafar | product-designer |
| Reza | ui-ux-designer |
| Hossein | backend-developer |
| Mahdi | frontend-developer |
| Sajad | qa-engineer |
| Hassan | security-tester |
| Bagher | qc-release-manager |
| Kazem | devops-engineer |
| Javad | scrum-master |

## 1. Frame the proposal
Write the owner's request and a concrete proposal to a scratch file. Include:
- the current state, citing feature IDs and ADRs
- the proposed model
- the feature-ID changes
- open owner questions

Pick the reviewing roles:

| Topic | Roles |
|---|---|
| Catalog or business rules | Hadi, Mohammad, Ali |
| Auth, payments or certification | add Hassan |
| Schema | add Mojtaba |
| UI | add Jafar and Reza |
| Process | Javad |

## 2. Give reviewers the context
Reviewers must be able to read:
- their agent file
- CLAUDE.md
- the related `docs/features/*.md` and ADRs
- the proposal

In Cowork, stage these into the container with `device_stage_files`, and re-stage anything that changed.

## 3. Run the reviews in parallel
Launch one subagent per role in one message. Each prompt:
1. Tells the reviewer to read and act as its agent file, read-only.
2. Lists the file paths.
3. States what that role must check:
   - PO: faithfulness to the request, priorities and acceptance criteria.
   - Architect: aggregates, invariants and their enforcement points, state machines, events and boundaries.
   - CTO: ADR conflicts, scope, risk, and whether an ADR is needed.
4. Asks for a verdict (Accept / Accept with changes / Rework), numbered concrete changes, and at most 2 owner questions. English, under ~600 words.

## 4. Consolidate
- Verify reviewers' claims about feature IDs by grepping the docs.
- Merge the changes. Where roles disagree, apply Ali's (cto) call or turn it into an owner question.
- Keep hard rules (CERT-21 etc.) strict.
- Never weaken a quality gate for speed.

## 5. Take it to the owner
- Send a Persian summary: what each role said and what changed.
- Ask the remaining owner decisions **one at a time** with AskUserQuestion, recommended option first.
- Apply the result, usually an ADR plus feature-doc updates, following mondapac-repo-doc-change.
