# Provenance

Every value in a packet answers the question "why does it say this?" without the
reviewer leaving the response. That is enforced by the database, not by
convention: `ApplicationField_provenance_required` permits a value only when it
links to a `Fact` or declares `source: 'page'`.

## The sources

| Source | Means | Who can assert it |
| --- | --- | --- |
| `connector` | The organization's system of record, through an authorized adapter | The connector endpoint |
| `document` | Extracted from an uploaded document | The document intake path |
| `caseworker` | Typed by a caseworker this session | The gaps endpoint |
| `participant` | Given by the participant directly | The gaps endpoint |
| `page` | Already on the form; the assistant did not write it | An agent, by observation |
| `inferred` | Derived from other facts | An agent, with reasoning |

An agent may only write `page` and `inferred`. It has not spoken to a caseworker
and has not called a provider, so claiming either would launder a guess into the
strongest tier in the packet. `write_fact` offers no other option.

## Reasoning is not optional

`inferred` requires `sourceDetail`, and it is displayed beside the value in the
packet. "Riverside County, from ZIP 92595" is a reviewable claim. "Inferred" is
not — it tells the reviewer that a judgment was made without telling them what
to check.

State the input and the rule. If you cannot state the rule, you are guessing,
and the value belongs in a gap.

## What may never be inferred

    ssn, housingStatus, preferredContact, householdSize,
    immigrationStatus, income, childcare, unemployment, ein

These are protected for two different reasons, both worth understanding:

**Some change what someone receives.** Household size, income, childcare costs,
and unemployment benefits feed eligibility and benefit amount directly. An
inference here is not a typo the reviewer will notice; it is a plausible number
in a plausible place that changes an outcome.

**Some are disclosures only the participant can make.** SSN, immigration status,
and housing status are the participant's to state. Deriving immigration status
from a name, a language preference, or a county is both unreliable and a
category error about who is speaking.

`preferredContact` is protected for a quieter reason: it decides how a county
reaches someone about their own application. Inferring "email" for a person who
reads their mail is how a notice gets missed and a case gets closed.

The `Fact_protected_not_inferred` CHECK constraint refuses these writes, so
attempting one costs a turn and returns an error. Call `report_gap`.

## Freshness

A fact carries `observedAt` and optionally `expiresAt`. A fact past its
expiration, or older than thirty days without one, comes back `stale`.

Stale is not unusable. A caseworker can confirm a stale address in three
seconds. But it must be *said* — a stale value entered silently is presented to
the reviewer as though it were current, which spends their attention in the
wrong place.
