import { tool } from '@openai/agents';
import { WebAPIPlatformError } from '@slack/web-api';
import { z } from 'zod';

import { sessionStopped, toolFailed } from '../guardrails.js';

export const listViews = tool({
  name: 'list_views',
  description:
    'List the view tabs currently attached to the code channel.\n' +
    '\n' +
    'Use it before publishing a new view, since a channel holds at most 5, or to\n' +
    'find the `view_id` of a tab to remove.',
  parameters: z.object({}),
  inputGuardrails: [sessionStopped],
  errorFunction: toolFailed,
  execute: async (_input, context) => {
    const deps = /** @type {import('../sessions.js').AgentDeps} */ (context?.context);
    let response;
    try {
      response = await deps.client.agents.conversations.listViews({ channel_id: deps.channelId });
    } catch (e) {
      if (!(e instanceof WebAPIPlatformError)) throw e;
      return `Could not list views: ${e.data.error}`;
    }

    const views = /** @type {any[]} */ (response.views ?? []);
    if (views.length === 0) return 'No views are attached to this channel yet.';
    const lines = views.map(
      (v) =>
        `- ${v.name || v.label}: view_key=${v.view_key ?? '(diff)'} ` +
        `view_id=${v.view_id} version=${v.content_version ?? 'unknown'}`,
    );
    return `${views.length} of 5 views attached:\n${lines.join('\n')}`;
  },
});
