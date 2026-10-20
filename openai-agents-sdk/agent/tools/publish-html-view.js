import { tool } from '@openai/agents';
import { WebAPIPlatformError } from '@slack/web-api';
import { z } from 'zod';

import { sessionStopped, toolFailed } from '../guardrails.js';

export const publishHtmlView = tool({
  name: 'publish_html_view',
  description:
    'Publish an HTML document as a tab in the code channel.\n' +
    '\n' +
    'Use it for rich output that reads better rendered than as a message, such as\n' +
    'a test report or coverage summary. Calling it again with the same `view_key`\n' +
    'updates that tab in place. A channel holds at most 5 views.',
  parameters: z.object({
    view_key: z.string().describe('A stable key for this view, such as `reports/tests.html`.'),
    name: z.string().describe('The short tab label shown in the channel, such as `Tests`.'),
    html: z.string().describe('A full, self-contained HTML document with inline styles and no external scripts.'),
  }),
  inputGuardrails: [sessionStopped],
  errorFunction: toolFailed,
  execute: async ({ view_key, name, html }, context) => {
    const deps = /** @type {import('../sessions.js').AgentDeps} */ (context?.context);
    try {
      const response = await deps.client.agents.conversations.setView({
        channel_id: deps.channelId,
        type: 'html',
        view_key,
        name,
        content: html,
      });
      return `Published the \`${name}\` tab (view_id ${response.view_id}).`;
    } catch (e) {
      if (!(e instanceof WebAPIPlatformError)) throw e;
      return `Could not publish the view: ${e.data.error}`;
    }
  },
});
