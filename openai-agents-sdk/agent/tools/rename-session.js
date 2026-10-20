import { tool } from '@openai/agents';
import { WebAPIPlatformError } from '@slack/web-api';
import { z } from 'zod';

import { sessionStopped, toolFailed } from '../guardrails.js';

export const renameSession = tool({
  name: 'rename_session',
  description:
    'Rename the code channel and its session title.\n' +
    '\n' +
    "Use it when the task's focus changes enough that the current name would\n" +
    'mislead someone scanning their channels.',
  parameters: z.object({
    title: z.string().describe('A short, descriptive title for the task, such as `Fix flaky login test`.'),
  }),
  inputGuardrails: [sessionStopped],
  errorFunction: toolFailed,
  execute: async ({ title }, context) => {
    const deps = /** @type {import('../sessions.js').AgentDeps} */ (context?.context);
    try {
      await deps.client.agents.sessions.rename({ channel_id: deps.channelId, title });
      return `Renamed the session to '${title}'.`;
    } catch (e) {
      if (!(e instanceof WebAPIPlatformError)) throw e;
      return `Could not rename the session: ${e.data.error}`;
    }
  },
});
