import { maskValue } from '@/lib/casegraph/facts';
import { allGaps } from '@/lib/casegraph/gaps';
import type { Tx } from '@/lib/db';
import { application, applicationField, fact, reviewEvent } from '@/lib/db/schema';
import { labelFor, toLabsAspSource } from '@/lib/vocabulary';
import { and, asc, eq } from 'drizzle-orm';

/**
 * The review-ready packet, and the submit gate.
 *
 * The packet is the product: every field in form order, with the value, what
 * kind of control holds it, whether the form requires it, and a provenance
 * object that points at the fact the value came from. A reviewer can answer
 * "why does it say this?" for every line without leaving the response.
 *
 * Values are masked by default. A packet is read in a room with a participant,
 * and the extension masks SSN and EIN in its own review view for the same
 * reason.
 */

export type PacketField = {
  ordinal: number;
  fieldKey: string;
  label: string;
  purpose: string | null;
  value: string | null;
  inputType: string;
  options: string[] | null;
  required: boolean;
  verified: boolean;
  provenance: {
    source: string | null;
    /** labs-asp's narrower enum, so an existing consumer's rendering still works. */
    legacySource: string | null;
    detail: string | null;
    factId: string | null;
    observedAt: string | null;
    confirmedBy: string | null;
    confidence: number | null;
  } | null;
};

export async function buildPacket(
  tx: Tx,
  applicationId: string,
  options: { reveal?: boolean } = {},
) {
  const reveal = options.reveal === true;

  const rows = await tx
    .select({ field: applicationField, fact })
    .from(applicationField)
    .leftJoin(fact, eq(fact.id, applicationField.factId))
    .where(eq(applicationField.applicationId, applicationId))
    .orderBy(asc(applicationField.ordinal));

  const fields: PacketField[] = rows.map(({ field, fact: linked }) => ({
    ordinal: field.ordinal,
    fieldKey: field.fieldKey,
    label: field.label,
    purpose: field.purpose,
    value:
      field.value === null
        ? null
        : reveal
          ? field.value
          : maskValue(field.purpose ?? field.fieldKey, field.value),
    inputType: field.inputType,
    options: field.options,
    required: field.required,
    // A write that was never read back is not verified, and the packet says so
    // rather than rounding it up. The silent-success failure class is exactly
    // the one a reviewer cannot catch by eye.
    verified: field.verifiedAt !== null,
    provenance:
      field.value === null
        ? null
        : {
            source: field.source,
            legacySource: field.source ? toLabsAspSource(field.source) : null,
            detail: field.sourceDetail ?? linked?.sourceDetail ?? null,
            factId: field.factId,
            observedAt: linked?.observedAt?.toISOString() ?? null,
            confirmedBy: linked?.confirmedBy ?? null,
            confidence:
              linked?.confidence === null || linked?.confidence === undefined
                ? null
                : Number(linked.confidence),
          },
  }));

  const gaps = await allGaps(tx, applicationId);

  const filled = fields.filter((item) => item.value !== null);
  const withProvenance = filled.filter(
    (item) => item.provenance?.factId || item.provenance?.source === 'page',
  );

  return {
    masked: !reveal,
    fields,
    gaps: gaps.map((row) => ({
      id: row.id,
      fieldKey: row.fieldKey,
      label: row.label,
      purpose: row.purpose,
      question: row.question,
      kind: row.kind,
      required: row.required,
      inputType: row.inputType,
      options: row.options,
      answered: row.answeredAt !== null,
    })),
    summary: {
      fieldCount: fields.length,
      filledCount: filled.length,
      verifiedCount: filled.filter((item) => item.verified).length,
      // The pilot measure, computed rather than asserted. The database makes
      // this always 1 for a consistent row, which is the point: a value with
      // no provenance cannot be stored, so a drop here means missing data, not
      // untraceable data.
      provenanceShare: filled.length === 0 ? null : withProvenance.length / filled.length,
      openGapCount: gaps.filter((row) => row.answeredAt === null).length,
      requiredUnfilledCount: fields.filter(
        (item) => item.required && (item.value === null || item.value === ''),
      ).length,
    },
  };
}

export type SubmitGateVerdict = {
  allowed: boolean;
  blockers: string[];
  reviewerPrincipal: string | null;
  attestedAt: string | null;
};

/**
 * Evaluates the submit gate.
 *
 * Mirrors the `Application_submit_gate` trigger so a caller gets a readable
 * 409 with reasons instead of a Postgres exception. The trigger is the
 * guarantee; this is the explanation. If they ever disagree, the trigger wins
 * and the request fails, which is the correct direction.
 *
 * This service never drives a final submit. The gate exists because recording
 * a submission is how outcome tracking starts, and that record must have a
 * named human in it.
 */
export async function evaluateSubmitGate(
  tx: Tx,
  applicationId: string,
): Promise<SubmitGateVerdict> {
  const blockers: string[] = [];

  const confirmations = await tx
    .select({ reviewerPrincipal: reviewEvent.reviewerPrincipal, at: reviewEvent.at })
    .from(reviewEvent)
    .where(and(eq(reviewEvent.applicationId, applicationId), eq(reviewEvent.action, 'confirmed')))
    .orderBy(asc(reviewEvent.at))
    .limit(1);

  const confirmation = confirmations[0] ?? null;
  if (!confirmation) {
    blockers.push('No reviewer has confirmed this packet.');
  }

  const fields = await tx
    .select({
      required: applicationField.required,
      value: applicationField.value,
      label: applicationField.label,
      purpose: applicationField.purpose,
      verifiedAt: applicationField.verifiedAt,
    })
    .from(applicationField)
    .where(eq(applicationField.applicationId, applicationId));

  // Every other rule is about something wrong in the packet, so an empty packet
  // would satisfy all of them.
  if (!fields.some((row) => row.value !== null && row.value !== '')) {
    blockers.push('Nothing has been filled, so there is nothing to review.');
  }

  const unfilled = fields.filter((row) => row.required && (row.value === null || row.value === ''));
  for (const row of unfilled) {
    blockers.push(`Required field is empty: ${row.label}.`);
  }

  const unverified = fields.filter((row) => row.value !== null && row.verifiedAt === null);
  for (const row of unverified) {
    blockers.push(
      `Value was never read back to confirm it landed: ${labelFor(row.purpose ?? row.label)}.`,
    );
  }

  const gaps = await allGaps(tx, applicationId);
  const openRequired = gaps.filter((row) => row.answeredAt === null && row.required);
  for (const row of openRequired) {
    blockers.push(`Unanswered required question: ${row.question}`);
  }

  const rows = await tx
    .select({ submittedAt: application.submittedAt })
    .from(application)
    .where(eq(application.id, applicationId))
    .limit(1);
  if (rows[0]?.submittedAt) {
    blockers.push('This application is already recorded as submitted.');
  }

  return {
    allowed: blockers.length === 0,
    blockers,
    reviewerPrincipal: confirmation?.reviewerPrincipal ?? null,
    attestedAt: confirmation?.at?.toISOString() ?? null,
  };
}
