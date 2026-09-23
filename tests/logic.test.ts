import { sanitizeDetails } from '@/lib/audit';
import { maskValue } from '@/lib/casegraph/facts';
import { classifyGap, defaultQuestion } from '@/lib/casegraph/gaps';
import { buildFillPlan } from '@/lib/casegraph/plan';
import { APRICOT_DEMO_SCHEMA, toApricotRecord } from '@/lib/connectors/apricot360';
import { ndjsonToSse } from '@/lib/eve/client';
import { evaluateProbes } from '@/lib/playbooks/registry';
import { resumeDecision } from '@/lib/queue/lease';
import {
  DO_NOT_DERIVE,
  FIELD_KEYS,
  fromExtensionSource,
  planWorkflows,
  toLabsAspSource,
} from '@/lib/vocabulary';
import { describe, expect, it } from 'vitest';

/**
 * Logic that does not need a database.
 *
 * The invariants that matter most are in `safety.test.ts`, against a real
 * Postgres, because they are constraints. These cover the decisions: which path
 * a run takes, whether a resume is allowed, what a gap is, and what never
 * reaches the audit trail.
 */

describe('audit detail sanitization', () => {
  it('keeps allowlisted counts and enums', () => {
    expect(
      sanitizeDetails({ fieldCount: 18, verifiedCount: 11, resumeOutcome: 'verified' }),
    ).toEqual({ fieldCount: 18, verifiedCount: 11, resumeOutcome: 'verified' });
  });

  it('drops everything else, including anything participant-shaped', () => {
    expect(
      sanitizeDetails({
        ssn: '900-12-3456',
        firstName: 'Jordan',
        address: '100 Example Way',
        note: 'she said she moved',
        fieldCount: 3,
      }),
    ).toEqual({ fieldCount: 3 });
  });

  it('drops an enum key whose value is not in its enum', () => {
    // An allowlisted key is not a free-text channel. Without the value check,
    // `resumeOutcome` would be a place to smuggle a string.
    expect(sanitizeDetails({ resumeOutcome: 'participant declined to answer' })).toEqual({});
  });

  it('coerces a count to a non-negative integer', () => {
    expect(sanitizeDetails({ fieldCount: -4 })).toEqual({ fieldCount: 0 });
    expect(sanitizeDetails({ gapCount: 2.9 })).toEqual({ gapCount: 2 });
    expect(sanitizeDetails({ pageCount: 'many' })).toEqual({});
  });
});

describe('playbook freshness probes', () => {
  const playbook = {
    id: 'p1',
    tenantId: null,
    domain: 'example.test',
    programIds: ['wic'],
    version: 1,
    name: 'Fixture',
    probes: ['#a', '#b'],
    fieldMap: [],
    safeAdvanceRules: [],
    autoAdvance: false,
    note: null,
    staleAt: null,
    staleReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('routes to the script path when every probe resolves once', () => {
    const verdict = evaluateProbes(playbook, [
      { selector: '#a', count: 1 },
      { selector: '#b', count: 1 },
    ]);
    expect(verdict.passed).toBe(true);
    expect(verdict.executionMode).toBe('script');
  });

  it('routes to the model path when a probe is missing', () => {
    const verdict = evaluateProbes(playbook, [
      { selector: '#a', count: 1 },
      { selector: '#b', count: 0 },
    ]);
    expect(verdict.passed).toBe(false);
    expect(verdict.executionMode).toBe('model');
    expect(verdict.missing).toEqual(['#b']);
  });

  it('fails an ambiguous probe, not just a missing one', () => {
    // A selector matching two elements is as unsafe to replay as one matching
    // none: the write lands on whichever comes first, and reports success.
    const verdict = evaluateProbes(playbook, [
      { selector: '#a', count: 1 },
      { selector: '#b', count: 2 },
    ]);
    expect(verdict.passed).toBe(false);
    expect(verdict.missing).toEqual(['#b']);
  });

  it('stays on the model path while marked stale, even if probes pass', () => {
    const verdict = evaluateProbes(
      { ...playbook, staleAt: new Date(), staleReason: 'selectors moved' },
      [
        { selector: '#a', count: 1 },
        { selector: '#b', count: 1 },
      ],
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain('selectors moved');
  });
});

describe('the resume decision', () => {
  const paused = {
    handoffToPrincipal: null,
    handoffAcceptedAt: null,
    location: 'https://example.test/page/2',
    pageSignatureHash: 'sig-1',
  };

  it('allows a resume when the page is intact', () => {
    const decision = resumeDecision(paused, {
      location: 'https://example.test/page/2',
      pageSignatureHash: 'sig-1',
      tabOpen: true,
      sourceFreshness: 'fresh',
    });
    expect(decision.outcome).toBe('verified');
    expect(decision.canContinue).toBe(true);
  });

  it('puts an expired source ahead of everything else', () => {
    // Continuing with expired data writes stale values into a legal document,
    // so it outranks even a closed tab.
    const decision = resumeDecision(paused, { sourceFreshness: 'expired', tabOpen: false });
    expect(decision.outcome).toBe('source_expired');
  });

  it('blocks on a pending handoff before looking at the page', () => {
    const decision = resumeDecision(
      { ...paused, handoffToPrincipal: 'someone-else' },
      { location: 'https://example.test/elsewhere', tabOpen: true },
    );
    expect(decision.outcome).toBe('handoff_pending');
  });

  it('blocks when the page navigated away', () => {
    const decision = resumeDecision(paused, {
      location: 'https://example.test/page/5',
      tabOpen: true,
    });
    expect(decision.outcome).toBe('location_changed');
    expect(decision.canContinue).toBe(false);
  });

  it('blocks when the page structure changed underneath', () => {
    const decision = resumeDecision(paused, {
      location: 'https://example.test/page/2',
      pageSignatureHash: 'sig-2',
      tabOpen: true,
    });
    expect(decision.outcome).toBe('page_changed');
  });
});

describe('gap classification', () => {
  it('treats a protected field as a decision', () => {
    expect(classifyGap({ fieldKey: '#ssn', purpose: 'ssn' })).toBe('decision');
    expect(classifyGap({ fieldKey: '#income', purpose: 'income' })).toBe('decision');
  });

  it('treats a select as a decision', () => {
    expect(classifyGap({ fieldKey: '#clinic', inputType: 'select' })).toBe('decision');
  });

  it('treats a plain missing text field as required', () => {
    expect(classifyGap({ fieldKey: '#email', purpose: 'email', inputType: 'text' })).toBe(
      'required',
    );
  });

  it('phrases a protected field as needing direct confirmation', () => {
    const question = defaultQuestion({ fieldKey: '#ssn', purpose: 'ssn' });
    expect(question).toContain('cannot be inferred');
  });

  it('asks about the participant, not about the form', () => {
    const question = defaultQuestion({ fieldKey: '#edit-email', purpose: 'email' });
    expect(question).toBe('What is the email?');
  });
});

describe('the deterministic fill plan', () => {
  const now = new Date();
  const playbook = {
    id: 'p1',
    tenantId: null,
    domain: 'www.ruhealth.org',
    programIds: ['wic'],
    version: 1,
    name: 'WIC',
    probes: [],
    fieldMap: [
      { fieldKey: '#edit-name', purpose: 'fullName', inputType: 'text' },
      { fieldKey: '#edit-email', purpose: 'email', inputType: 'text' },
      { fieldKey: '#ssn', purpose: 'ssn', inputType: 'text', method: 'keys' },
      { fieldKey: '#clinic', purpose: null, inputType: 'select' },
    ],
    safeAdvanceRules: [],
    autoAdvance: false,
    note: null,
    staleAt: null,
    staleReason: null,
    createdAt: now,
    updatedAt: now,
  };

  const facts = new Map([
    [
      'fullName',
      {
        id: 'f1',
        key: 'fullName',
        value: 'Jordan Sample',
        source: 'connector' as const,
        sourceDetail: 'Apricot 900001',
        confidence: 1,
        observedAt: now,
        expiresAt: null,
        confirmedBy: null,
        confirmedAt: null,
        consentScope: null,
        freshness: 'fresh' as const,
        sensitive: false,
      },
    ],
    [
      'ssn',
      {
        id: 'f2',
        key: 'ssn',
        value: '900-12-3456',
        source: 'connector' as const,
        sourceDetail: null,
        confidence: 1,
        observedAt: new Date(now.getTime() - 90 * 86_400_000),
        expiresAt: null,
        confirmedBy: null,
        confirmedAt: null,
        consentScope: null,
        freshness: 'stale' as const,
        sensitive: true,
      },
    ],
  ]);

  const plan = buildFillPlan(playbook, facts);

  it('plans a write for every mapped field that has a fact', () => {
    expect(plan.writes.map((write) => write.fieldKey)).toEqual(['#edit-name', '#ssn']);
  });

  it('links every write to the fact it came from', () => {
    for (const write of plan.writes) {
      expect(write.factId).toBeTruthy();
    }
  });

  it('uses keystrokes for a masked field', () => {
    const ssn = plan.writes.find((write) => write.fieldKey === '#ssn');
    expect(ssn?.method).toBe('keys');
    const name = plan.writes.find((write) => write.fieldKey === '#edit-name');
    expect(name?.method).toBe('value');
  });

  it('turns a mapped field with no fact into a gap, not a blank', () => {
    expect(plan.gaps.map((gap) => gap.fieldKey)).toContain('#edit-email');
  });

  it('turns an unclassified control into a gap', () => {
    // The playbook knows the control exists but not what fact answers it. Only
    // a human does.
    expect(plan.gaps.map((gap) => gap.fieldKey)).toContain('#clinic');
  });

  it('names the stale facts it used', () => {
    expect(plan.staleUsed).toEqual(['ssn']);
  });
});

describe('the shared vocabulary', () => {
  it('maps the extension’s reformatted values to connector, not to inferred', () => {
    // 'changed' means the record's value was reformatted to fit the control
    // ("California" -> "CA"). It is still the organization's value.
    expect(fromExtensionSource('changed')).toBe('connector');
    expect(fromExtensionSource('record')).toBe('connector');
    expect(fromExtensionSource('page')).toBe('page');
  });

  it('maps every canonical source into labs-asp’s narrower enum', () => {
    expect(toLabsAspSource('connector')).toBe('database');
    expect(toLabsAspSource('document')).toBe('database');
    expect(toLabsAspSource('participant')).toBe('caseworker');
    expect(toLabsAspSource('inferred')).toBe('inferred');
  });

  it('groups programs served by one site into one run', () => {
    const plans = planWorkflows(['calfresh', 'medical', 'calworks']);
    expect(plans).toHaveLength(1);
    expect(plans[0].workflowId).toBe('benefitscal');
    expect(plans[0].name).toBe('BenefitsCal — CalFresh, Medi-Cal, and CalWORKs');
  });

  it('keeps programs on different sites as separate runs', () => {
    expect(planWorkflows(['wic', 'ihss'])).toHaveLength(2);
  });

  it('ignores an unknown program rather than inventing one', () => {
    expect(planWorkflows(['wic', 'not-a-program'])).toHaveLength(1);
  });

  it('holds every protected key in the canonical field vocabulary', () => {
    // A protected key that is not a real field key would silently protect
    // nothing.
    for (const key of DO_NOT_DERIVE) {
      expect(FIELD_KEYS).toContain(key);
    }
  });
});

describe('sensitive value masking', () => {
  it('masks an SSN down to its last four digits', () => {
    expect(maskValue('ssn', '900-12-3456')).toBe('•••-••-3456');
  });

  it('masks an EIN', () => {
    expect(maskValue('ein', '12-3456789')).toBe('•••-••-6789');
  });

  it('leaves an ordinary field alone', () => {
    expect(maskValue('city', 'WILDOMAR')).toBe('WILDOMAR');
  });

  it('does not produce a fake mask for an empty value', () => {
    expect(maskValue('ssn', '')).toBe('');
  });
});

describe('the Apricot wire shape', () => {
  it('renders canonical facts as field_<id> attributes', () => {
    const record = toApricotRecord(
      '900001',
      { firstName: 'Jordan', ssn: '900-12-3456' },
      new Date(),
    );
    expect(record.data[0].attributes.field_101).toBe('Jordan');
    expect(record.data[0].attributes.field_127).toBe('900-12-3456');
    expect(record.data[0].attributes.form_id).toBe(99);
  });

  it('drops a key the schema does not declare rather than inventing a field', () => {
    const record = toApricotRecord('900001', { notAField: 'x' }, new Date());
    expect(Object.keys(record.data[0].attributes)).toEqual(['form_id', 'mod_time']);
  });

  it('gives every schema field a reference tag in the canonical vocabulary', () => {
    for (const field of APRICOT_DEMO_SCHEMA) {
      expect(FIELD_KEYS).toContain(field.reference_tag);
    }
  });
});

describe('NDJSON to SSE adaptation', () => {
  async function collect(chunks: string[]): Promise<string> {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const out = ndjsonToSse(source);
    const reader = out.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text;
  }

  it('emits one SSE frame per NDJSON line, named by event type', async () => {
    const text = await collect(['{"type":"step.started"}\n{"type":"step.finished"}\n']);
    expect(text).toContain('event: step.started');
    expect(text).toContain('event: step.finished');
  });

  it('reassembles an object split across chunk boundaries', async () => {
    // The failure this prevents is a truncated JSON object being forwarded as
    // a complete event, which breaks the consumer's parser for good.
    const text = await collect(['{"type":"par', 'tial","ok":true}\n']);
    expect(text).toContain('event: partial');
    expect(text).toContain('"ok":true');
  });

  it('drops a malformed line instead of forwarding it', async () => {
    const text = await collect(['not json\n{"type":"fine"}\n']);
    expect(text).not.toContain('not json');
    expect(text).toContain('event: fine');
  });

  it('surfaces the continuation token to the caller', async () => {
    const seen: string[] = [];
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('{"type":"turn.finished","continuationToken":"ct-1"}\n'),
        );
        controller.close();
      },
    });
    const reader = ndjsonToSse(source, (event) => {
      if (event.continuationToken) seen.push(event.continuationToken);
    }).getReader();
    while (!(await reader.read()).done) {
      // drain
    }
    // Without this the gaps endpoint would start a cold session instead of
    // resuming the one that stopped.
    expect(seen).toEqual(['ct-1']);
  });
});
