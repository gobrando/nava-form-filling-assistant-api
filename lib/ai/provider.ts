import { createAnthropic } from '@ai-sdk/anthropic';
import { vertexAnthropic } from '@ai-sdk/google-vertex/anthropic';
import type { VertexModelId } from './model-map';

/**
 * One place that turns a model id into a provider instance.
 *
 * Vertex is the production path, matching labs-asp. A direct Anthropic key is
 * accepted so the cold path can be run and verified by anyone holding one,
 * without access to the Vertex project. The model ids are the same aliases on
 * both providers, so tiering does not change with the credential.
 */
export function claude(modelId: VertexModelId) {
  if (process.env.ANTHROPIC_API_KEY) {
    return createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })(modelId);
  }
  return vertexAnthropic(modelId);
}
