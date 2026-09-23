import { recordAudit } from '@/lib/audit';
import { reportGaps } from '@/lib/casegraph/gaps';
import { withTenant } from '@/lib/db';
import { application, applicationField } from '@/lib/db/schema';
import { guard } from '@/lib/guard';
import { fail, ok, preflight, readJson } from '@/lib/http';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

/**
 * POST /v1/applications/{id}/fields
 *
 * The readback report. This is Phase 4 of the form-completion protocol, and it
 * is the only thing that turns a planned write into a verified one.
 *
 * A caller reports what it read back out of each control. A value that matched
 * gets `verifiedAt`; a value that did not gets its verification cleared and
 * becomes a gap, because a write that did not land is indistinguishable from a
 * value nobody has.
 *
 * The distinction matters because the failure this catches is silent: a masked
 * input rejects a direct assignment and reports success anyway, so a packet
 * built on intentions alone claims eighteen filled fields when eleven landed.
 */
const postSchema = z
  .object({
    readbacks: z
      .array(
        z.object({
          fieldKey: z.string().min(1).max(500),
          /** What the control actually contained after the write. */
          landedValue: z.string().max(2000).nullable(),
        }),
      )
      .min(1)
      .max(500),
  })
  .strict();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const origin = request.headers.get('origin');
  const { auth, response } = await guard(request);
  if (!auth) return response;

  const { id } = await params;
  const parsed = await readJson(request, postSchema);
  if (parsed.error) return parsed.error;

  return withTenant(auth.tenantId, async (tx) => {
    const apps = await tx
      .select({ id: application.id, submittedAt: application.submittedAt })
      .from(application)
      .where(eq(application.id, id))
      .limit(1);
    if (!apps[0]) return fail(404, 'Application not found.', { origin });
    if (apps[0].submittedAt) {
      return fail(409, 'This application is already recorded as submitted.', { origin });
    }

    const planned = await tx
      .select({
        fieldKey: applicationField.fieldKey,
        label: applicationField.label,
        purpose: applicationField.purpose,
        value: applicationField.value,
        inputType: applicationField.inputType,
        options: applicationField.options,
        required: applicationField.required,
      })
      .from(applicationField)
      .where(eq(applicationField.applicationId, id));

    const byKey = new Map(planned.map((row) => [row.fieldKey, row]));
    const verified: string[] = [];
    const mismatched: { fieldKey: string; label: string }[] = [];
    const unknown: string[] = [];

    for (const readback of parsed.data.readbacks) {
      const field = byKey.get(readback.fieldKey);
      if (!field) {
        unknown.push(readback.fieldKey);
        continue;
      }

      // Compared as trimmed strings. A control that normalizes whitespace or
      // reformats a date has still accepted the value; a control that holds
      // something different has not.
      const matched =
        field.value !== null &&
        readback.landedValue !== null &&
        readback.landedValue.trim() === field.value.trim();

      await tx
        .update(applicationField)
        .set({ verifiedAt: matched ? new Date() : null })
        .where(
          and(
            eq(applicationField.applicationId, id),
            eq(applicationField.fieldKey, readback.fieldKey),
          ),
        );

      if (matched) verified.push(readback.fieldKey);
      else mismatched.push({ fieldKey: readback.fieldKey, label: field.label });
    }

    // A write that did not land becomes a question. Leaving it as a silently
    // unverified field would let it disappear from the reviewer's attention.
    if (mismatched.length > 0) {
      await reportGaps(
        tx,
        auth.tenantId,
        id,
        mismatched.map((item) => {
          const field = byKey.get(item.fieldKey);
          return {
            fieldKey: item.fieldKey,
            label: item.label,
            purpose: field?.purpose ?? null,
            question: `The value for ${item.label} did not land on the page. What should it be?`,
            required: field?.required ?? false,
            inputType: field?.inputType,
            options: field?.options ?? null,
          };
        }),
      );
    }

    await tx
      .update(application)
      .set({
        status: mismatched.length > 0 ? 'needs_attention' : 'ready_for_review',
        interventionReason: mismatched.length > 0 ? 'unsupported_control' : null,
        updatedAt: new Date(),
      })
      .where(eq(application.id, id));

    await recordAudit(tx, {
      tenantId: auth.tenantId,
      type: 'page_verified',
      principalId: auth.principalId,
      applicationId: id,
      outcome: mismatched.length > 0 ? 'partial' : 'verified',
      details: { verifiedCount: verified.length, blockedCount: mismatched.length },
    });

    return ok(
      {
        verifiedCount: verified.length,
        mismatched,
        unknown,
        status: mismatched.length > 0 ? 'needs_attention' : 'ready_for_review',
      },
      { origin },
    );
  });
}

export async function OPTIONS(request: Request) {
  return preflight(request.headers.get('origin'));
}
