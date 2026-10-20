import { tool } from '@anthropic-ai/claude-agent-sdk';
import { WebAPIPlatformError } from '@slack/web-api';
import { z } from 'zod';

import { toolResult } from '../runtime.js';

/** @param {import('../sessions.js').AgentDeps} deps */
export const renameSession = (deps) =>
  tool(
    'rename_session',
    'Rename the code channel and its session title.\n' +
      '\n' +
      "Use it when the task's focus changes enough that the current name would\n" +
      'mislead someone scanning their channels.',
    {
      title: z.string().describe('A short, descriptive title for the task, such as `Fix flaky login test`.'),
    },
    async ({ title }) => {
      try {
        await deps.client.agents.sessions.rename({ channel_id: deps.channelId, title });
        return toolResult(`Renamed the session to '${title}'.`);
      } catch (e) {
        if (!(e instanceof WebAPIPlatformError)) throw e;
        return toolResult(`Could not rename the session: ${e.data.error}`);
      }
    },
  );
