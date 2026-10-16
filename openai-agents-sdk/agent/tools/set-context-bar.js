import { tool } from '@openai/agents';
import { WebAPIPlatformError } from '@slack/web-api';
import { z } from 'zod';

import { sessionStopped, toolFailed } from '../guardrails.js';

const ContextBarItem = z.object({
  key: z.string().describe('A unique key for the item, such as `repo`, `branch`, `pr`, or `ci`.'),
  label: z.string().describe('The display text, such as `PR #42 is open` or `Tests passing`.'),
  icon: z
    .enum(['branch', 'folder', 'hierarchy', 'life-ring', 'link', 'globe', 'terminal', 'code', 'search', 'lock'])
    .nullable()
    .describe('An icon shown beside the label.'),
  url: z.string().nullable().describe('Makes the item a link to this URL.'),
});

export const setContextBar = tool({
  name: 'set_context_bar',
  description:
    'Set the items pinned to the context bar at the top of the code channel.\n' +
    '\n' +
    'Use it to show where the work stands: the repo, branch, PR, and CI status.\n' +
    'The list replaces the current set, so always send every item you want to\n' +
    'keep. Keep labels current as things change. At most 5 items.',
  parameters: z.object({
    items: z.array(ContextBarItem).describe('The full set of context bar items, in display order.'),
  }),
  inputGuardrails: [sessionStopped],
  errorFunction: toolFailed,
  execute: async ({ items }, context) => {
    const deps = /** @type {import('../sessions.js').AgentDeps} */ (context?.context);
    try {
      await deps.client.agents.conversations.setProperties({
        channel_id: deps.channelId,
        code_channel: {
          // Leave out the fields the model sent as null.
          context_bar_items: items.slice(0, 5).map(({ icon, url, ...item }) => ({
            ...item,
            ...(icon === null ? {} : { icon }),
            ...(url === null ? {} : { url }),
          })),
        },
      });
      return `Set ${Math.min(items.length, 5)} context bar items.`;
    } catch (e) {
      if (!(e instanceof WebAPIPlatformError)) throw e;
      return `Could not set the context bar: ${e.data.error}`;
    }
  },
});
