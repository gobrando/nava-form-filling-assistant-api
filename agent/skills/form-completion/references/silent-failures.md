# Silent failures

Failure modes where a write reports success and lands nothing. These are the
reason Phase 4 exists, and the reason `record_field` asks for `verified` rather
than inferring it.

A loud failure is cheap: it costs a retry. A silent failure is expensive because
it produces a packet that looks complete, which means the reviewer's attention —
the last line of defense — is spent on the wrong fields.

## Masked inputs

A date, SSN, or formatted phone field usually attaches a handler that rewrites
the value as the user types. Setting the value directly bypasses the handler.
Depending on the implementation, the field ends up empty, holds an unformatted
string the form will later reject, or holds the value until the next re-render
discards it. The write returns success in every case.

**Fill with keystrokes.** `#birthDate_primary_input` on BenefitsCal and
`#ssnTxt` on the Riverside IHSS form are both confirmed cases; their playbook
entries carry `method: 'keys'` for this reason.

## Selects with scripted change handlers

Setting a select's value without dispatching the change event the page listens
for leaves the control showing the right option while the page's own state never
updates. The form submits the old value.

**Choose the option the way a person would** and confirm the readback, not just
the control's displayed text.

## Dependent fields that do not exist yet

A field revealed by another answer is absent from the DOM until its trigger is
set. Filling it before the trigger silently does nothing — there was no element.

**Fill the trigger, let the page settle, survey again.** The second survey is
not redundant; it is the only way to see the fields the first one could not.

## Re-render resets

A page that re-renders after an async validation or a trigger change can reset
controls it re-mounts. A value written before the re-render is gone, and nothing
reports it.

**Verify after the page has settled,** not immediately after writing.

## Ambiguous selectors

A selector that matched one element when the playbook was written can match two
after a site change. A write then lands on whichever one the query returns
first, which may be the wrong one, and it reports success.

This is why a freshness probe requires **exactly one** match, not at least one.
A count of two fails the probe and routes the run to the model, on purpose.

## Off-screen and disabled controls

A control that is disabled, `aria-hidden`, or inside a collapsed section may
accept a programmatic write that the form ignores on submission.

**Treat a write to a control you cannot see as unverified** until a readback
proves otherwise.
