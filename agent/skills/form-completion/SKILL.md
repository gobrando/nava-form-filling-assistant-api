---
name: form-completion
description: Use when completing any multi-page web form on behalf of someone else. Covers surveying a page, matching known facts to controls, filling, verifying that writes actually landed, and advancing safely. Use this skill for benefits applications, intake forms, and renewals.
---

# Form completion

A six-phase protocol. The phases exist because skipping one produces a specific,
repeatable failure, and each phase below names the failure it prevents.

The protocol is written for a model driving a page. When a playbook's freshness
probes all pass, the service replays the field map deterministically instead and
none of this runs — a fresh playbook is a compiled version of phases 1 and 2.

## Phase 0 — Source

Call `read_facts` once. That is the household.

Note which facts come back `stale`. A stale fact may still be entered, but it
has to be called out in the summary so the reviewer confirms it rather than
trusting it.

*Prevents:* filling a form from a half-remembered context window instead of the
record, and having no answer when a reviewer asks where a value came from.

## Phase 1 — Survey

Call `get_playbook` first. If a field map comes back, you are confirming a map,
not building one — even a stale map, because a changed site is usually a partly
changed site.

Then enumerate the controls on the page: selector, visible label, control type,
whether it is required, and for a select or radio the exact option text. Read the
page once and work from your notes. Re-reading the DOM per field is what makes a
cold run cost twenty tool calls instead of three.

*Prevents:* discovering on page four that a field you filled on page two was a
combo box with different option text than you assumed.

## Phase 2 — Match

For each control, decide one of three things:

1. **A fact fills it.** You have a fact whose key matches the control's purpose.
2. **A fact implies it.** You can derive it — the county from the ZIP code, the
   nearest clinic from the home address. Write the derivation with
   `write_fact(source: 'inferred')` and put the reasoning in the record. It will
   be shown to the reviewer next to the value.
3. **Nothing fills it.** Call `report_gap`.

Never a fourth thing. There is no "reasonable default" branch. A blank field gets
asked about; a plausible wrong value gets filed.

These keys are option 3 or nothing, always, no matter how obvious the inference
looks:

    ssn, housingStatus, preferredContact, householdSize,
    immigrationStatus, income, childcare, unemployment, ein

They are protected because each one changes what someone receives, or is a
disclosure the participant alone can make. The database refuses an inferred
value for these keys, so guessing costs a turn and yields nothing.

*Prevents:* the only error class with no acceptable rate — a confident wrong
value in a field that determines eligibility.

## Phase 3 — Fill

Fill in document order. Respect the control:

- A **masked input** (date, SSN, phone with a format mask) takes keystrokes.
  Setting its value directly is frequently rejected by the mask's own handler,
  which reports success anyway. See `references/silent-failures.md`.
- A **select** takes an exact option string from the survey. Not a near match.
- A **radio group** takes a click on the specific input, not on the group label.
- A **dependent field** may not exist until its trigger is set. Fill the trigger,
  wait for the page to settle, then survey again.

*Prevents:* writes that land nowhere and report success.

## Phase 4 — Verify

Read every value back out of its control and compare it to what you intended.
Then call `record_field` with `verified: true` only for those that matched.

This phase is not optional and not a formality. A masked input, a scripted
select, and a field that a page re-render has reset all look identical to a
successful write from the writing side. The readback is the only thing that
distinguishes them.

Anything that did not match: fill it again, or report it as a gap. Do not record
it as filled.

*Prevents:* a packet that claims eighteen filled fields when eleven landed —
the failure a reviewer cannot catch by eye, because the packet looks complete.

## Phase 5 — Advance

Advance only on a control whose visible label is exactly one of: Begin, Next,
Continue. Nothing else.

Never activate: Submit, Sign, Certify, Agree, File, Finish, or any terms
checkbox. Never attempt a CAPTCHA. If the only way forward is one of those, stop
and report that a human is needed at this point.

After advancing, return to Phase 1. The new page is a new page.

*Prevents:* an agent filing a legal attestation on someone's behalf.

## Phase 6 — Report

Call `check_submit_gate`, then say plainly:

- what is filled and verified
- what is filled but unverified, and why
- what is missing and what question would resolve it
- whether a playbook probe failed, so the scribe can repair it

A run that ends with reported gaps has succeeded. It asked a question it was not
allowed to answer.

## References

- `references/silent-failures.md` — the failure modes where a write reports
  success and lands nothing.
- `references/provenance.md` — what each source means and what may never be
  inferred.
