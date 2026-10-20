import { tool } from '@openai/agents';
import { WebAPIPlatformError } from '@slack/web-api';
import { z } from 'zod';

import { sessionStopped, toolFailed } from '../guardrails.js';

export const removeView = tool({
  name: 'remove_view',
  description:
    'Remove a view tab from the code channel.\n' +
    '\n' +
    "Use it to clear out a view that's stale or no longer useful. Find the\n" +
    '`view_id` with `list_views` first.',
  parameters: z.object({
    view_id: z.string().describe('The view_id of the tab to remove, as returned by `list_views`.'),
  }),
  inputGuardrails: [sessionStopped],
  errorFunction: toolFailed,
  execute: async ({ view_id }, context) => {
    const deps = /** @type {import('../sessions.js').AgentDeps} */ (context?.context);
    try {
      await deps.client.agents.conversations.removeView({ channel_id: deps.channelId, view_id });
      return `Removed view ${view_id}.`;
    } catch (e) {
      if (!(e instanceof WebAPIPlatformError)) throw e;
      return `Could not remove the view: ${e.data.error}`;
    }
  },
});
