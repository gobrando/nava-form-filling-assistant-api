import { evaluateSubmitGate } from '@/lib/casegraph/packet';
import { withTenant } from '@/lib/db';
import { requireApplication, toolScope } from '@/lib/eve/tool-context';
import { defineTool } from 'eve/tools';

/**
 * Reports what still stands between this packet and a human's review.
 *
 * Deliberately read-only, and deliberately does not submit anything. The agent
 * gets this tool so it can tell the difference between "done filling" and
 * "nothing left to do" — those are not the same state, and the second one is
 * not the agent's to reach.
 */
export default defineTool({
  description: [
    'Check what is still blocking this packet from being ready for a reviewer.',
    '',
    'Call this when you think filling is complete. Empty required fields,',
    'unverified writes, and unanswered required questions all come back as',
    'blockers. Fix what you can, report the rest as gaps.',
    '',
    'This does not submit anything and there is no tool that does. Submission is',
    "a participant's legal attestation and a human performs it.",
  ].join('\n'),

  inputSchema: { type: 'object', properties: {}, additionalProperties: false },

  execute: async (_raw, ctx) => {
    const scope = toolScope(ctx);
    const applicationId = requireApplication(scope);

    return withTenant(scope.tenantId, async (tx) => {
      const verdict = await evaluateSubmitGate(tx, applicationId);
      return {
        readyForReview: verdict.blockers.length === 0,
        blockers: verdict.blockers,
        note: 'A reviewer confirms and submits. You do not.',
      };
    });
  },
});
