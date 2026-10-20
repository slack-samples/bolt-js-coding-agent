import { tool } from '@anthropic-ai/claude-agent-sdk';
import { WebAPIPlatformError } from '@slack/web-api';
import { z } from 'zod';

import { toolResult } from '../runtime.js';

const ContextBarItem = z.object({
  key: z.string().describe('A unique key for the item, such as `repo`, `branch`, `pr`, or `ci`.'),
  label: z.string().describe('The display text, such as `PR #42 is open` or `Tests passing`.'),
  icon: z
    .enum(['branch', 'folder', 'hierarchy', 'life-ring', 'link', 'globe', 'terminal', 'code', 'search', 'lock'])
    .optional()
    .describe('An icon shown beside the label.'),
  url: z.string().optional().describe('Makes the item a link to this URL.'),
});

/** @param {import('../sessions.js').AgentDeps} deps */
export const setContextBar = (deps) =>
  tool(
    'set_context_bar',
    'Set the items pinned to the context bar at the top of the code channel.\n' +
      '\n' +
      'Use it to show where the work stands: the repo, branch, PR, and CI status.\n' +
      'The list replaces the current set, so always send every item you want to\n' +
      'keep. Keep labels current as things change. At most 5 items.',
    {
      items: z.array(ContextBarItem).describe('The full set of context bar items, in display order.'),
    },
    async ({ items }) => {
      try {
        await deps.client.agents.conversations.setProperties({
          channel_id: deps.channelId,
          code_channel: { context_bar_items: items.slice(0, 5) },
        });
        return toolResult(`Set ${Math.min(items.length, 5)} context bar items.`);
      } catch (e) {
        if (!(e instanceof WebAPIPlatformError)) throw e;
        return toolResult(`Could not set the context bar: ${e.data.error}`);
      }
    },
  );
