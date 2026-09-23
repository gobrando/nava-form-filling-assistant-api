---
name: benefits-application
description: Use when completing a California public-benefits application — CalFresh, Medi-Cal, CalWORKs, WIC, or IHSS. Covers which programs share one application, what each site does differently, and the boundary between filling and submitting.
---

# Benefits applications

Program-specific knowledge for the five applications this service supports. The
mechanics of driving a form are in the `form-completion` skill; this is what is
true about these particular programs.

## One application can serve several programs

BenefitsCal serves **CalFresh, Medi-Cal, and CalWORKs** from a single
application. Selecting all three is one run, not three, and the run sets three
apply-for checkboxes on one page rather than filling one form three times.

WIC (Riverside University Health System) and IHSS (Riverside County) are
separate sites with separate applications.

This grouping is `workflowId` in the program catalog. Getting it wrong means
either three redundant runs or one application that only requests one benefit.

## Per-site notes

### BenefitsCal — `benefitscal.com`

Multi-page. Auto-advance is safe, limited to controls labeled exactly Begin,
Next, or Continue.

The date of birth field `#birthDate_primary_input` is masked and must be filled
with keystrokes. So must `#ssn`. Both are confirmed silent-failure cases.

### Riverside WIC — `ruhealth.org`

A single inline form behind a CAPTCHA. There is nothing to advance to, and
auto-advance is off in the playbook because it would only race the bot check.

The clinic select is derivable from the home address and is not protected, so
inferring it is allowed — record the reasoning. The caseworker clears the CAPTCHA
and submits.

### Riverside IHSS — `riversideihss.org`

`#ssnTxt` is masked. The form has a submit gate that validates before allowing
submission, so an unverified write surfaces there as a validation error rather
than as a bad filing — but do not rely on that. Verify with a readback.

## Where a run stops

Fill and submit are different acts, and this service only performs the first.

A benefits application is a legal attestation by the participant about their own
household. Income, household composition, and immigration status are sworn to,
and a false statement has consequences for the participant, not for the tool.
Nobody has delegated that attestation, and it is not delegable.

So: never activate Submit, Sign, Certify, Agree, File, or Finish. Never accept a
terms checkbox. Never attempt a CAPTCHA. A CAPTCHA is a site saying it wants a
person, and the correct response is to get one.

The run ends with a review-ready packet. A human reads it, confirms it, and
submits.

## What "done" means

Done is: every field a fact could fill is filled and verified, every field it
could not is a gap with a question attached, and the packet says which is which.

Done is not: no blank fields. A run that ends with eight gaps and thirty
verified fields has done its job. A run that ends with zero gaps because it
filled eight fields with plausible guesses has done real harm, and it looks
better on a dashboard — which is why the protected-field list is a database
constraint and not a guideline.
