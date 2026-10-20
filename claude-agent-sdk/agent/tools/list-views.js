import { tool } from '@anthropic-ai/claude-agent-sdk';
import { WebAPIPlatformError } from '@slack/web-api';

import { toolResult } from '../runtime.js';

/** @param {import('../sessions.js').AgentDeps} deps */
export const listViews = (deps) =>
  tool(
    'list_views',
    'List the view tabs currently attached to the code channel.\n' +
      '\n' +
      'Use it before publishing a new view, since a channel holds at most 5, or to\n' +
      'find the `view_id` of a tab to remove.',
    {},
    async () => {
      let response;
      try {
        response = await deps.client.agents.conversations.listViews({ channel_id: deps.channelId });
      } catch (e) {
        if (!(e instanceof WebAPIPlatformError)) throw e;
        return toolResult(`Could not list views: ${e.data.error}`);
      }

      const views = /** @type {any[]} */ (response.views ?? []);
      if (views.length === 0) return toolResult('No views are attached to this channel yet.');
      const lines = views.map(
        (v) =>
          `- ${v.name || v.label}: view_key=${v.view_key ?? '(diff)'} ` +
          `view_id=${v.view_id} version=${v.content_version ?? 'unknown'}`,
      );
      return toolResult(`${views.length} of 5 views attached:\n${lines.join('\n')}`);
    },
  );
