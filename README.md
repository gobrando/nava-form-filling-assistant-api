# Nava Form-Filling Assistant API

An API for filling out public-benefits applications on a caseworker's behalf,
without ever submitting one.

A partner (a county platform, a community organization's case-management tool,
or another Nava product) sends a household and names a program. The API fills
the application, and anything it doesn't know becomes a question instead of a
guess. The partner gets back a **review-ready packet** in which every value says
where it came from. Submission stays with a named human, and the database
enforces that.

This is the server side of the
[Nava Form-Filling Assistant Chrome extension](#relationship-to-the-chrome-extension).
The extension's connector contract, vocabulary, and playbooks work unchanged
against it.

> **Status:** working prototype. The deterministic path is proven end to end
> over HTTP against a real browser (`pnpm prove`, 36 checks). The model-driven
> path compiles and its tools are tested, but it has not yet run against a
> model. See [What is and isn't proven](#what-is-and-isnt-proven).

---

## How it works

```mermaid
sequenceDiagram
    participant P as Partner (or the extension)
    participant API as Form-Filling API
    participant DB as Case graph (Postgres)
    participant S as Benefits site

    P->>API: POST /v1/households (facts, each with a source)
    API->>DB: append facts
    P->>API: GET /v1/programs/wic/playbook
    P->>S: probe the page's selectors
    P->>API: POST /v1/applications (probe results)
    alt every probe matched: warm path, no model
        API-->>P: 201 + fill plan (every write linked to a fact)
    else page changed or unknown site: cold path
        API->>API: Eve agent drives a browser
    end
    P->>S: enter values, read them back
    P->>API: POST /fields (what actually landed)
    API-->>P: mismatches become questions
    P->>API: GET /gaps → POST /gaps (a caseworker answers)
    P->>API: GET /packet (values + provenance)
    P->>API: POST /review (a named reviewer confirms)
    Note over P,S: a human submits on the site
    P->>API: POST /submit (records that they did)
```

### Four ideas the design rests on

**1. Every value has provenance, or it doesn't exist.** Household data lives in
an append-only ledger of *facts*. Each fact records its source (`connector`,
`document`, `caseworker`, `participant`, `page`, or `inferred`), when it was
observed, and who confirmed it. Every value placed on an application points at
the fact it came from. "What share of this packet can a reviewer trace?" is a
SQL query, and the answer on a completed run is 100%.

**2. A missing value becomes a question, not a guess.** In the multi-agent
skill design this is built on, a fill agent that lacks a value stops and
returns a `BLOCKED` report, and an orchestrator asks the human. An API has no
human to ask mid-run, so **`BLOCKED` becomes the `gaps` endpoint.** The run
pauses, the question persists, the partner answers when they can, and the run
resumes.

**3. A write isn't done until it's read back.** Forms fail silently. A field
with a `maxlength` truncates a ZIP code and reports success, and a masked input
rejects a value without an error. The API only trusts what the caller reads
back off the page, and a mismatch reopens the field as a question.

**4. The model is the fallback, not the default.** Most runs don't need an LLM.

| | Warm path | Cold path |
|---|---|---|
| When | The site's playbook is fresh (every probe selector matched) | New site, or the page changed |
| How | A deterministic fill plan: a join between the playbook's field map and the facts | An [Eve](https://www.npmjs.com/package/eve) orchestrator with `scout`, `fill`, `form_review`, and `scribe` subagents driving a browser |
| Cost | No model calls | Many model turns |
| Afterward | — | The playbook is marked stale, and the scribe repairs it so the next run is warm |

Each application records which path ran (`executionMode`), so cost per
completed packet can be measured, not estimated.

### Is it agentic?

It's a hybrid, on purpose. The cold path is a real multi-agent LLM system: an
orchestrator plus four subagents, each with its own instructions, tools, and
model tier (a cheaper model for checklist work, a stronger one for discovery
and playbook repair). The warm path deliberately has no model in it, because
re-deriving the same field mapping on every run is the expensive way to fill a
form you've already learned.

---

## Safety is enforced by the database

Prompt instructions are advice. These rules live in
[`lib/db/migrations`](lib/db/migrations) and hold even if an agent misbehaves
or a route handler has a bug:

- **Protected fields can never be inferred.** A `CHECK` constraint rejects an
  `inferred` fact for SSN, immigration status, income, household size, housing
  status, and the rest of the `DO_NOT_DERIVE` list. A test parses the SQL and
  compares it to the TypeScript list, so the two can't drift apart.
- **No value without provenance.** An application field can't hold a value
  unless it links to a fact or was already on the page.
- **The facts ledger is append-only.** The application's database role can't
  `UPDATE` or `DELETE` facts, audit events, or review events. A correction
  supersedes the old fact, and the old fact stays inspectable.
- **The submit gate is a trigger.** An application can't be marked submitted
  without a confirmed review by a named person, at least one filled value,
  every filled value read back, no empty required field, and no unanswered
  required question.
- **Audit rows can't carry participant data.** A `CHECK` constraint allows only
  counts and a fixed vocabulary of values. The trail says "4 fields filled,"
  never what was in them.
- **Tenants are isolated by row-level security**, set per transaction. The app
  connects as a role that can't bypass it.

**Nothing in this service submits an application.** No tool clicks a submit
button. The agent's browser tool refuses submit-like controls, `Enter`
key presses, and navigation off the application's own site. `POST /submit`
only records that a human submitted.

---

## Quickstart

Requires Node 24, pnpm 10, and Docker.

```bash
pnpm install
docker run -d --name nava-pg -p 5433:5432 \
  -e POSTGRES_PASSWORD=navatest -e POSTGRES_DB=nava_form_filling postgres:16

cp .env.example .env.local
# In .env.local:
#   POSTGRES_URL=postgresql://nava_api:nava_api_test@127.0.0.1:5433/nava_form_filling
#   POSTGRES_MIGRATION_URL=postgresql://postgres:navatest@127.0.0.1:5433/nava_form_filling
#   API_KEY_PEPPER=<any long random string>

pnpm db:migrate
# Let the local app role log in (production assumes it instead):
docker exec nava-pg psql -U postgres -d nava_form_filling \
  -c "ALTER ROLE nava_api LOGIN PASSWORD 'nava_api_test'"
pnpm db:seed        # demo tenant + shared playbooks; prints an API key once
pnpm dev            # API on :3000
```

### See it work

In a second terminal, start the local WIC form fixture, then run the proof:

```bash
pnpm fixture        # a copy of the WIC form on :4300
pnpm prove
```

`pnpm prove` plays the partner's role over real HTTP with a real Chromium. It
creates a household, fills the WIC form twice, and checks 36 things along the
way:

- **Run A, the trap.** The fixture's ZIP field silently truncates five digits
  to four. The API catches it on readback, turns it into a question, and keeps
  the gate shut, even after a caseworker answers, because the page still can't
  hold the value.
- **Run B, the clean form.** Every value lands, the clinic question is
  answered, the packet shows 100% provenance, a named reviewer confirms, and a
  human submission is recorded. A second submission is refused.
- **Throughout:** requests without a key get 401, another tenant can't see the
  household, an inferred SSN is refused, and the audit export contains none of
  the household's values.

---

## Using the API

Authenticate with `Authorization: Bearer nava_<keyId>_<secret>`. Every response
is JSON with `"ok": true` or `"ok": false, "error": "..."`. The full contract is
[`openapi.yaml`](openapi.yaml), and a test fails if it drifts from the route
handlers.

**1. Create a household.** `externalRef` is *your* identifier, so no particular
case-management system is required.

```bash
curl -X POST localhost:3000/v1/households -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{
    "externalRef": "case-1234",
    "facts": [
      { "key": "fullName",   "value": "Jordan Sample", "source": "caseworker" },
      { "key": "postalCode", "value": "92501",         "source": "caseworker" }
    ]
  }'
```

Or import one from a live connector (see [Live connectors](#live-connectors)):

```bash
curl -X POST localhost:3000/v1/households/import -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{ "connectionId": "acme-apricot", "recordId": "1001" }'
```

**2. Get the playbook and probe the page.** The playbook lists selectors that
must each match exactly once if the site hasn't changed.

```bash
curl localhost:3000/v1/programs/wic/playbook -H "Authorization: Bearer $KEY"
```

**3. Start the application** with what you found:

```bash
curl -X POST localhost:3000/v1/applications -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{
    "householdId": "<id>",
    "programIds": ["wic"],
    "probeResults": [{ "selector": "#edit-name", "count": 1 }, ...]
  }'
```

A fresh playbook returns `201` with `plan.writes` (each carrying its `factId`)
and `plan.gaps`. A changed or unknown site returns `202`, and supplying
`agentApiKey` hands the run to the agent.

**4. Enter the values, then report what actually landed:**

```bash
curl -X POST localhost:3000/v1/applications/<id>/fields ... -d '{
  "readbacks": [{ "fieldKey": "#edit-zip-code", "landedValue": "9250" }]
}'
```

**5. Answer the open questions.** Each answer becomes a fact attributed to the
person who gave it, and goes back onto its field waiting to be entered and read
back.

```bash
curl localhost:3000/v1/applications/<id>/gaps -H "Authorization: Bearer $KEY"
curl -X POST localhost:3000/v1/applications/<id>/gaps ... -d '{
  "answers": [{ "gapId": "<gap>", "value": "Riverside WIC",
                "source": "caseworker", "answeredBy": "caseworker-7" }]
}'
```

**6. Review and record.**

```bash
curl localhost:3000/v1/applications/<id>/packet   # masked by default; ?reveal=true is audited
curl -X POST .../review -d '{ "action": "confirmed", "reviewerPrincipal": "reviewer-3",
                              "attestation": "Reviewed with the participant." }'
# a human submits on the benefits site, then:
curl -X POST .../submit -d '{ "submittedBy": "caseworker-7", "confirmationNumber": "WIC-12345" }'
```

`/review` and `/submit` return `409` with a list of blockers until the packet is
complete.

### All endpoints

| Area | Endpoints |
|---|---|
| Case graph | `POST/GET /v1/households`, `POST /v1/households/import`, `GET /v1/households/{id}`, `POST/GET /v1/households/{id}/facts` |
| Applications | `POST/GET /v1/applications` (start a run / the work queue) |
| Per application | `/fields`, `/gaps`, `/packet`, `/review`, `/submit`, `/metrics`, `/events` (SSE, cold path), `/lease`, `/handoff`, `/resume` |
| Catalog | `GET /v1/programs`, `GET/POST /v1/programs/{slug}/playbook` |
| Connectors | `GET /v1/connectors/{id}/health`, `/schema`, `/records/{recordId}` (the extension's contract) |
| Audit | `GET /v1/audit/export` |

---

## Live connectors

Apricot 360 connections run in one of two modes. **Demo mode** serves seeded
data in Apricot's wire format. **Live mode** reads the organization's real
Apricot using the OAuth client-credentials protocol that
[labs-asp](https://github.com/navapbc/labs-asp) uses against Bonterra's sandbox.

Turning a connection live is configuration, not code:

1. The organization that owns the Apricot instance issues an API client, under
   a data-sharing agreement with them.
2. Set `APRICOT_<NAME>_BASE_URL`, `_CLIENT_ID`, `_CLIENT_SECRET`, and
   `_ENVIRONMENT` (`sandbox` or `api`). On Cloud Run, these are Secret Manager
   references.
3. Point the `Connection` row at them with `secretRef = "env:APRICOT_<NAME>"`,
   pin it to one Apricot form (`sourceId`), and record the reviewed field
   mapping (`mappings`, Apricot field id to canonical key).

`pnpm apricot` checks the `APRICOT_RIVERSIDE` prefix and prints only the host
and the token HTTP status. It does not print the token.

Only mapped fields become facts. A field Apricot adds later is counted and
dropped until someone reviews what it means. A record from a different form is
a 404, never a cross-form read. Connectors are **read-only**: nothing is
written back to the organization's system of record.

---

## Tests

```bash
POSTGRES_TEST_URL=postgresql://postgres:navatest@127.0.0.1:5433/nava_form_filling pnpm test
```

109 tests. The safety invariants run against real Postgres, because a mocked
constraint proves nothing.

| File | Covers |
|---|---|
| `safety.test.ts` | RLS isolation as the app role, protected-field inference, append-only ledger, provenance, audit allowlist, every submit-gate rule |
| `e2e.test.ts` | A warm run: probe, plan, caught truncation, answered questions, packet, gate |
| `connector-live.test.ts` | The live Apricot adapter against a wire-format mock: token reuse, re-auth on 401, cross-form refusal, mapped-only import, no values in audit |
| `browser-tool.test.ts` | The agent's browser tool in a real Chromium: fills and reads back, refuses submit, `Enter`, and off-site navigation |
| `browser-policy.test.ts` | The browser policy as pure functions |
| `contract.test.ts` | `openapi.yaml` matches the route handlers exactly |
| `logic.test.ts` | Probe evaluation, fill planning, masking, vocabulary, stream adaptation |

---

## When the site changes

A failed freshness probe used to have one continuation: start Eve, if you have
a model key. Most changes are smaller than that. The questions are the same
and the ids are not.

`POST /v1/programs/{slug}/playbook/repair` takes the controls the caller
already has on screen — selector, label, type, count. It does not take values.
Leave `publish` off for a dry run. The scribe keeps a selector that still
matches one element, and moves a field only when a single label uniquely names
it. Publishing writes a **new version on that tenant**. The shared playbook is
left alone, so another county does not inherit an unreviewed map.

A protected field does not move onto a nearby identifier. An SSN with a
"Social Security Number" label moves; an SSN with only a "Case number" on the
page stays unresolved, and publish is refused. Two controls with the same
label are a tie, which is also a refusal. The model scribe is for that case,
not for the case this one can already prove.

The same observation can be sent on `POST /v1/applications` with
`"repair": true`. When the repair is safe, the response is the warm plan
(`201`, `executionMode: "script"`) instead of a request for an agent key.

```bash
pnpm rehearse
```

That runs the drifted WIC fixture and an SSN-versus-case-number check with no
database and no model. The ZIP field on that fixture still truncates, so a
repaired playbook does not skip readback.

### Drift lab

`pnpm drift` scores fictional county pages in `tests/fixtures/drift/` with that
same scribe, plus the rehearsal fixture above. No API key and no database. It
prints a scorecard and writes
[`reports/scribe-drift.md`](reports/scribe-drift.md): which drifts publish,
which refusals still belong to the model scribe, and what a green row does not
prove (readback, no submit, all-or-nothing publish).

`pnpm review-brief` writes [`reports/repair-review.md`](reports/repair-review.md)
for a design review. Cost assumptions live in
[`config/review-brief.json`](config/review-brief.json). The fixture share is
this lab, not a production rate.

## What is and isn't proven

| | Status |
|---|---|
| Case graph, provenance, safety constraints | Tested against real Postgres |
| Warm path, end to end over HTTP | Proven: `pnpm prove`, 36 checks, real browser |
| Live Apricot reads and import | Tested against a wire-format mock, not yet against a real instance |
| Agent tree (orchestrator + 4 subagents) | Compiles (`pnpm eve:info`: 0 errors, 7 tools, 2 skills, 4 subagents) |
| Agent browser tool | Tested in a real Chromium, without a model driving it |
| Deterministic scribe: a stale page repaired into a warm playbook | Proven without a model. `pnpm rehearse`, and `tests/scribe.test.ts` |
| **Cold path with a real model** | **Not yet run.** It needs an Anthropic key or Vertex credentials. The scribe above handles the case where every old field still has one unambiguous label. |
| Production auth (per-tenant SSO) | Not built. API keys and a signed-cookie placeholder today. |

---

## Deploying

The app is a standard Next.js server (`output: 'standalone'`), plus the Eve
agent as a second process. It runs on Vercel, and the [`Dockerfile`](Dockerfile)
targets Cloud Run. Because `openapi.yaml` is hand-authored, it can configure GCP
API Gateway directly.

## Layout

```
app/v1/            Route handlers: the partner-facing API
lib/casegraph/     Facts ledger, gaps, fill plan, packet, submit gate, outcomes
lib/planner/       Shared mapper / gap / reviewer engine and the five-model score
lib/connectors/    Apricot 360: demo mode and live mode
lib/playbooks/     Served playbooks and freshness probes
lib/browser/       Browser transport and the policy that refuses submits
lib/db/            Drizzle schema and the safety migrations
lib/vocabulary.ts  Enums shared verbatim with the Chrome extension
agent/             The cold path: Eve orchestrator, subagents, skills, tools
scripts/prove.ts   The end-to-end HTTP proof
tests/             See above
```

## After submission

`POST /v1/applications/{id}/submit` records that a person submitted. It does not
submit. What the county does next is a separate, append-only history:

`received` → `pending_documents` or `approved` or `denied` → `benefit_received`.

A denial or a document request needs a reason code (`missing_documents`,
`ineligible_income`, and the rest of the list in the OpenAPI spec). The
optional follow-up sentence is shown to the participant and is not copied into
the audit log. The audit event records the status only.

## Participant page

A caseworker mints a link with `POST /v1/applications/{id}/share`. The person
the application is about opens it, sees the facts already on file (an SSN is
masked), and answers the questions the fill could not. The page has one button,
"Save my answers". It has no way to submit. Answers are stored as facts sourced
`participant`, so the packet can tell a caseworker's answer from the
participant's.

To see it locally, after the quickstart:

```bash
pnpm tsx --env-file-if-exists=.env.local scripts/demo-participant.ts
pnpm dev
```

Open the URL the script prints.

## Shared planner

The Chrome extension's on-device planner (field mapper, gap analyst, independent
reviewer) and this API run the same plan. `POST /v1/plan` takes a redacted field
inventory and the names of available sources — a `value` property is rejected —
and returns the plan shape the extension already applies. The extension checks
the plan again before it writes to the page. Set `navaApiBase` and `navaApiToken`
in the extension to send planning here; otherwise it keeps using Gemini Nano on
the caseworker's machine.

`pnpm compare` scores that plan the way the product is judged: review-ready or
not, confidently wrong fields, and a separate count when the wrong field is an
SSN or EIN. The five models are the set from the harness comparison: Claude
Opus 4.7, Opus 4.8, Sonnet 4.6, GPT-5.1, and GPT-5 mini. Without
`ANTHROPIC_API_KEY` and `OPENAI_API_KEY` those rows are skipped. The script still
checks a scripted correct plan and a scripted SSN mis-map, so the scorer is
proven either way. Costs are September 2026 list prices and ignore cache.

When `TYPESAFE_API_KEY` is set, `POST /v1/plan` asks Jev (`jev-1.13.0`) which
controls match a source, which ones the client has to answer, and which ones
should stay blank. That is the same split Kaylyn used on IHSS: the generative
model only sees the controls Jev is not confident about, and a Social Security
or EIN control is never filled from that decision. Jev's list price is $0.042
per million input tokens, and output tokens are free. Without the key, planning
is unchanged.

A cold start can send the same redacted inventory. The Eve message then lists
map, ask, and leave, and a mapping is dropped when the control label does not
share a word with the source. `pnpm compare:ihss` prices that decision pass on
a fictional IHSS-sized page. It is the planning cost only. It is not a full
browser run. `POST /v1/applications` also accepts `questions`, which are stored
as gaps so `POST /v1/applications/{id}/share` can hand them to the client.

## Relationship to the Chrome extension

The extension runs the same six-phase form-completion protocol client-side,
keeping its data in `chrome.storage`. This service is where that data, those
playbooks, and that work queue go when they need to outlive one browser
profile. The data can be shared across caseworkers and audited, and playbooks
can be updated without a Chrome Web Store release. `lib/vocabulary.ts` ports the
extension's enums verbatim so the two can't disagree about what a status means.

## Credits

The form-completion skill is adapted from
[navapbc/ai-chatbot](https://github.com/navapbc/ai-chatbot), and the
benefits-application skill and Apricot integration pattern from
[navapbc/labs-asp](https://github.com/navapbc/labs-asp), both by
[Nava PBC](https://www.navapbc.com/). All household data in this repository is
invented.
