import { withTenant } from '@/lib/db';
import { parseInput, toolScope } from '@/lib/eve/tool-context';
import {
  publicPlaybook,
  resolvePlaybookForDomain,
  resolvePlaybookForProgram,
} from '@/lib/playbooks/registry';
import { defineTool } from 'eve/tools';
import { z } from 'zod';

/**
 * Fetches the playbook for a site.
 *
 * Worth calling even when the run is on the cold path because a probe failed. A
 * site that changed is usually a site that changed in one place, so a stale
 * field map is still the cheapest available map — it turns a twenty-tool-call
 * survey into a handful of confirmations.
 */
const inputSchema = z
  .object({
    programId: z.string().max(100).optional(),
    domain: z.string().max(300).optional(),
  })
  .refine((value) => value.programId || value.domain, {
    message: 'Provide programId or domain.',
  });

export default defineTool({
  description: [
    'Get the known field map, freshness probes, and safe-advance rules for a site.',
    '',
    'Call this before surveying a page. If a playbook comes back marked stale,',
    'treat its field map as a starting hypothesis to confirm rather than a fact —',
    'and note which selectors moved, so the scribe can repair it.',
  ].join('\n'),

  inputSchema: {
    type: 'object',
    properties: {
      programId: { type: 'string', description: 'e.g. wic, calfresh, ihss' },
      domain: { type: 'string', description: 'e.g. benefitscal.com' },
    },
    additionalProperties: false,
  },

  execute: async (raw, ctx) => {
    const input = parseInput(inputSchema, raw);
    const scope = toolScope(ctx);

    return withTenant(scope.tenantId, async (tx) => {
      const row = input.programId
        ? await resolvePlaybookForProgram(tx, scope.tenantId, input.programId)
        : await resolvePlaybookForDomain(tx, scope.tenantId, input.domain as string);

      if (!row) {
        return {
          playbook: null,
          note: 'No playbook for this site. Survey it with scout, then have scribe write one.',
        };
      }

      return { playbook: publicPlaybook(row) };
    });
  },
});
