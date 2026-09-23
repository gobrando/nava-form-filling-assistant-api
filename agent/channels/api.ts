import { isExecutionTier } from '@/lib/ai/model-map';
import { authenticate } from '@/lib/auth';
import { eveChannel } from 'eve/channels/eve';

/**
 * The Eve HTTP channel, authenticated per tenant.
 *
 * Replaces the scaffold's `placeholderAuth()`, which makes every unfinished
 * route fail closed with a 501 — correct for a scaffold, useless here.
 *
 * `tenantId` is put on the session's auth attributes because that is the only
 * thing carried to every tool call and every subagent step. The fact tools read
 * it and pass it to `withTenant`, so an agent tool cannot reach another
 * organization's case graph even if the model asks it to: the isolation is a
 * Postgres policy, not a prompt instruction.
 *
 * `executionTier` rides the same channel and is what `agent.ts` resolves the
 * model from on `step.started`.
 */
export default eveChannel({
  cors: {
    // The agent server is reached by this service's own route handlers over
    // loopback, never by a browser. No origin needs credentialed access.
    origin: 'null',
    credentials: false,
  },

  auth: async (request: Request) => {
    const auth = await authenticate(request);
    if (!auth) return null;

    const requestedTier = request.headers.get('x-nava-execution-tier');
    const tier = isExecutionTier(requestedTier) ? requestedTier : 'cold';

    const applicationId = request.headers.get('x-nava-application-id');
    const householdId = request.headers.get('x-nava-household-id');

    return {
      // The bearer key is verified by HMAC comparison, which is what this
      // names. Eve's runtime session schema accepts a fixed set of
      // authenticator labels, and this is the accurate one.
      authenticator: 'jwt-hmac',
      principalId: auth.principalId,
      principalType: 'service',
      attributes: {
        tenantId: auth.tenantId,
        tenantSlug: auth.tenantSlug,
        executionTier: tier,
        ...(applicationId ? { applicationId } : {}),
        ...(householdId ? { householdId } : {}),
      },
    };
  },
});
