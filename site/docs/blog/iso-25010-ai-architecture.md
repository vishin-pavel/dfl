---
title: Steering AI Architecture with ISO 25010 Quality Attributes
description: Why prose prompts cause architectural drift in AI-generated code, and how dfl's /design-tech step screens ISO/IEC 25010:2023 quality attributes, 8 operational concerns, and DEC-n decisions to steer architecture without micromanagement.
tags: [architecture, iso-25010, ai-coding, specs, showdev]
crosspost:
  devto:
    tags: [showdev, architecture, ai, softwareengineering]
    note: Use #showdev (never #opensource); set canonical_url to this page before publishing.
  hashnode:
    tags: [software-architecture, ai, engineering, specs]
    note: Set canonicalUrl to this page; keep the Honest Trade-Offs section intact.
---

# Steering AI Architecture with ISO 25010 Quality Attributes

Ask a coding agent to *"make the checkout endpoint fast, secure, and maintainable"* and you will get three things you did not ask for: an unnecessary caching layer you now have to invalidate, a hand-rolled sanitization helper that misses the actual threat model, and six abstraction files for a 40-line handler.

Prose prompts fail at architecture for a simple reason: **adjectives are not constraints.** Without measurable targets or explicit boundaries, an LLM fills the vacuum with generic patterns from its training data. Worse, when engineers try to fix this by over-specifying implementation details (*"create `OrderCacheService.ts` using Redis with a `Map` fallback and a 3-layer factory"*), they lock the agent into brittle micromanagement that rots the moment requirements evolve.

In [`@vishin-pavel/dfl`](https://github.com/vishin-pavel/dfl) (`v0.3.0`), the `/design-tech` step of the [`dev` flow](/guide/dev-flow) takes a different approach: **screen every quality attribute systematically using ISO/IEC 25010:2023 plus 8 operational concerns, write only the applicable measurable constraints, and record decisions only when they are expensive to reverse.**

---

## State What the System Must Achieve, Never How to Build It

The opening rule of `templates/flows/dev/steps/design-tech/SKILL.md.hbs` (lines 3–6) draws a sharp line between **technical requirements** and **implementation choices**:

> Turn the accepted business requirements, or the confirmed objectives of a technical change, into long-lived, measurable technical requirements. Screen every quality attribute, write only the applicable ones into the feature's `TECH_DESIGN.md`, grill them with the user and get them accepted. **State what the system must achieve, never how to build it: the implementation decides that.**

Under `## Pitfalls` (`design-tech/SKILL.md.hbs:128–134`), the skill explicitly forbids *"implementation in disguise"* — naming libraries, classes, file layouts, or specific cache/queue products unless they are either an existing repository constraint (`CON-n`) or an expensive-to-reverse architectural decision (`DEC-n`).

This separation is what keeps `TECH_DESIGN.md` durable across refactors and useful to both humans and coding agents: the spec constrains *observable properties* (latency budgets, integrity invariants, retention windows, API compatibility), while `/implement-task` stays free to choose the cleanest code structure.

---

## The 17-Row Quality Attribute Screening Matrix

The most common failure in AI-assisted design is silent omission: the agent writes a detailed happy-path design and completely forgets privacy, recoverability, or cost.

To prevent silent omissions, Step 3 of `design-tech/SKILL.md.hbs` (lines 46–55) requires screening **every single row** of `templates/flows/dev/partials/quality-catalog.hbs` (lines 1–20) — 9 ISO/IEC 25010:2023 product quality characteristics plus 8 operational concerns the standard does not name:

### ISO/IEC 25010:2023 Product Quality Characteristics (9)

| Code | Characteristic | Applicable when |
|------|----------------|-----------------|
| `FUNC` | Functional suitability (completeness, correctness, appropriateness) | Calculations, money, time zones, units, rounding |
| `PERF` | Performance efficiency (time behaviour, resource utilization, capacity) | User-facing paths, batch deadlines, large data, limited devices |
| `COMP` | Compatibility (co-existence, interoperability) | Shared hosts/DBs, integrations, import/export, public APIs |
| `IC` | Interaction capability *(formerly usability)* | Any UI or CLI; holds the UI appearance section |
| `REL` | Reliability (faultlessness, availability, fault tolerance, recoverability) | Online services, external dependencies, persistent data, long jobs |
| `SEC` | Security (confidentiality, integrity, authenticity, resistance, …) | Any write path (**integrity always applies**), personal data, auth, public endpoints |
| `MAINT` | Maintainability (modularity, analysability, modifiability, testability) | Any code change (**testability always applies**) |
| `FLEX` | Flexibility *(formerly portability)* | Several platforms, growth, schema changes, vendor changes |
| `SAFE` | Safety (fail safe, hazard warning, safe integration) | Devices, health, money movement, irreversible bulk actions |

### Additional Operational & Architecture Concerns (8)

| Code | Concern | Applicable when |
|------|---------|-----------------|
| `OBS` | Observability (logs, metrics, traces, alerts) | Any backend service or job |
| `DEPLOY` | Deployability (release, rollback, feature flags) | Anything shipped to an environment |
| `CICD` | Pipeline gates | Project baseline; a feature only when it needs a new gate |
| `COST` | Cost efficiency | New infrastructure, paid APIs, LLM calls |
| `PRIV` | Privacy and data retention | Personal data |
| `DCONS` | Data consistency and durability | Several stores, caches, asynchronous flows |
| `COMPL` | Compliance | Regulated data or markets |
| `DX` | Developer experience | Project baseline; a feature that adds tooling or services |

### Why Every Row Requires an Explicit Verdict

For each affected feature, `/design-tech` writes a screening table into the task brief (`| Code | Verdict | Reason |`) with one of three verdicts (`design-tech/SKILL.md.hbs:48–55`):

- **`Applicable`**: This task adds, changes, or retires technical requirements for this code.
- **`Baseline SYS-n`**: Covered by the project-wide baseline (`docs/requirements/TECH_DESIGN.md`), so the feature needs nothing of its own.
- **`N/A`**: Does not apply, with a one-line justification.

Two safeguards make this screening bite instead of becoming paperwork:

1. **`MAINT` (testability) and `SEC` (integrity) cannot be marked `N/A`** — they start as `Applicable` and may only become `Baseline` (`design-tech/SKILL.md.hbs:53`).
2. **Downstream verification checks the verdicts:** During fresh-session [`/verify-task`](/blog/fresh-session-diff-verification), Dev QA cross-checks the actual `git diff` against the screening table (`verify-task/SKILL.md.hbs:66–68`). If code stores personal data while `PRIV` was marked `N/A`, or mutates a persistent entity without a `data` section, Dev QA fires `DESIGN_GAP` and sends the task back to `/design-tech`.

---

## Measurable Constraints & Anti-Padding Rules

After you confirm the screening table, `/design-tech` drafts **only** the sections triggered by `Applicable` codes (`data`, `interfaces`, `ui`, `operations`, `engineering`), capped at roughly **3 requirements per sub-characteristic** (`design-tech/SKILL.md.hbs:70–71`): *"drop any that would not change an implementation choice or a check."*

Every numeric target must be confirmed by a human (`Source: user`) — invented numbers like a plausible-sounding `p95 < 200ms` nobody agreed to are explicitly flagged as a pitfall (`design-tech/SKILL.md.hbs:131`). In `/fast-forward` autopilot mode, an unconfirmed proposal is marked `Source: assumed` and surfaced for mandatory human review in both Dev QA and the draft PR.

Conflicting requirements (for example, `PERF` latency vs. `DCONS` strong consistency) are not silently smoothed over — every conflicting pair is recorded under **Trade-offs** in section 2 with the human's explicit choice (`design-tech/SKILL.md.hbs:80–82`).

---

## `DEC-n`: Recording Only Expensive-to-Reverse Decisions

Most Architecture Decision Records (ADRs) fail because teams either write none or write 40 of them covering trivial library picks. Step 5 of `design-tech/SKILL.md.hbs` (lines 73–77) narrows `DEC-n` records strictly to **decisions that are expensive to reverse** (3–5 lines: context, decision, alternatives, consequences):

- System of record and storage engine (when not already constrained)
- Synchronous vs. asynchronous communication across a boundary
- Deployment unit boundaries
- Public contracts and versioning strategy
- Data ownership and multi-tenancy

Everything else — helper libraries, internal patterns, file layout, local algorithms — is explicitly left to `/implement-task`.

---

## Avoiding Waterfall: When `/design-tech` Doesn't Run at All

A common reaction from senior engineers is: *"I don't want to screen 17 quality attributes just to fix a 5-line bug!"*

You don't. In `dfl`'s `dev` flow, [`/classify-task`](/guide/dev-flow#adaptive-4-route-classification) routes every task across **4 adaptive routes**:

- **`code` route** (bug violating a cited requirement ID, refactor, dependency bump, chore): skips both Behavior and Tech design → goes straight to `implement-task`.
- **`behavior` route** (clarified rule or business-rule tweak with no data, interface, UI placement, or quality-target impact): runs `define-behavior` → skips `design-tech` via `NO_TECH_IMPACT`.
- **`design` route** (new quality target, infra/CI/storage change): skips `define-behavior` via `TECH_ONLY` → runs `design-tech`.
- **`full` route** (new feature or rule change with technical impact): runs both.

You pay the architectural screening cost *only* when the task actually changes technical boundaries.

---

## Honest Trade-Offs

- **Upfront grilling takes human attention:** `/design-tech` deliberately grills each applicable section with you before committing `TECH_DESIGN.md`. If you rubber-stamp the screening table without reading it, you will get low-signal requirements.
- **Not a formal static verifier:** `TECH_DESIGN.md` rows (like `CHK-PERF-1`) are verified in `/verify-task` via tests, benchmarks, static checks, inspection, or explicit deferral to ops/QA — `dfl` does not execute performance benchmarks automatically unless your test/check command runs them.
- **Brownfield adoption is incremental:** On an existing codebase without specs, `/design-tech` extracts `CON-n` constraints only for the area a task touches (`design-tech/SKILL.md.hbs:42–45`), so your technical design grows organically rather than requiring a big-bang rewrite.

---

## Next Steps

- Read the complete [`dev` flow reference](/guide/dev-flow) to see how `classify-task`, `define-behavior`, `design-tech`, `implement-task`, `verify-task`, and `ship-task` fit together.
- Customize the quality catalog for your own domain by editing `.df/dev/partials/quality-catalog.hbs` and running `dfl flow-update` (see [Variables & Templates](/guide/variables-and-templates)).
