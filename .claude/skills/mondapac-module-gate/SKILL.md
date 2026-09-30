---
name: mondapac-module-gate
description: Use when a MondaPac module needs to pass its readiness gates (ADR-0013): drafting the module brief, running G1 with the owner, G2 design review, and recording approvals.
---

# MondaPac module readiness gate (ADR-0013)

No design starts without an approved G1. No code is written without an approved G2. Tier B modules pass one combined gate; tier C modules need product-owner approval only. The tiers and the status register are in `docs/modules/README.md`.

## 1. Prepare
- Read:
  - `docs/modules/README.md` for the module's tier and phase
  - `docs/modules/_template/brief.md`
  - the feature files for the module's IDs, and `00-INDEX.md`
  - the ADRs that constrain the module, and `CLAUDE.md`
- Load skills (per `docs/process/skills-map.md`):
  - `product-management:write-spec` for the brief
  - `engineering:system-design` and `engineering:architecture` for G2

## 2. Draft the brief (Hadi, product-owner)
Fill `docs/modules/<module>/brief.md` from the template:
- goal and roles
- scope by feature ID, both in and out
- key flows, and hard rules (one per line)
- data ownership and events
- market, tenant and time-zone dimensions
- section 7: one owner decision per row, each with the team's recommendation
- risks, NFRs and acceptance criteria

Never invent business rules. Anything missing from the spec becomes an owner question.

## 3. G1: scope and capabilities (owner + Hadi + Ali, plus Jafar if there is UI)
1. Ali (cto) reviews the brief for ADR conflicts and MVP scope, following mondapac-role-review.
2. Send the owner a short Persian summary.
3. Ask the section 7 questions **one at a time** with AskUserQuestion, recommended option first. If a question needs a proposal, run a role review first.
4. Record the answers in section 7.
5. Record the G1 result and date in the brief's approvals table and in `docs/modules/README.md`.

## 4. Design and G2 (Mohammad, Mojtaba, Reza; reviewed by Ali, plus Hassan for tier A)
1. Each role produces its part of the design:
   - Mohammad: the domain model, state machines, boundary, facades and events, and where each hard rule is enforced.
   - Mojtaba: the physical schema plan and migration approach.
   - Reza and Jafar: flows and screens, if the module has UI.
2. Ali reviews the design. Hassan also reviews for tier A.
3. Send the owner a Persian summary, with a diagram for complex flows (load `artifact-diagramming`). Ask only the questions that need an owner decision.
4. Write an ADR only when a decision crosses modules.
5. Record the G2 result and date.

## 5. After the gates
- Hadi writes stories only from the approved brief.
- If scope or a hard rule changes during coding, run a mini-review (load `operations:change-request`) and record it in the brief's change log.
- Javad (scrum-master) checks that the next module's brief is being prepared in parallel.
- Commit following mondapac-repo-doc-change.
