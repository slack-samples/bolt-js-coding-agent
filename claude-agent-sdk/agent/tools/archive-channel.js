import { tool } from '@anthropic-ai/claude-agent-sdk';
import { WebAPIPlatformError } from '@slack/web-api';
import { z } from 'zod';

import { toolResult } from '../runtime.js';

/** @param {import('../sessions.js').AgentDeps} deps */
export const archiveChannel = (deps) =>
  tool(
    'archive_channel',
    'Post a final summary and archive the code channel.\n' +
      '\n' +
      'Only call this when the user says the work is done or asks to wrap up. The\n' +
      'summary is shared back to the message that started the session. After this,\n' +
      "the session is over and you can't post again.",
    {
      summary: z.string().describe('A short wrap-up of what changed, where it lives, and anything left to do.'),
    },
    async ({ summary }) => {
      try {
        const posted = await deps.client.chat.postMessage({ channel: deps.channelId, markdown_text: summary });
        // Close the session while the channel can still be written to.
        await deps.client.agents.sessions.setStatus({ channel_id: deps.channelId, status: 'closed' });
        try {
          await deps.client.agents.conversations.archive({
            channel_id: deps.channelId,
            summary_message_ts: posted.ts,
          });
        } catch (e) {
          // A channel started from Slack's own UI has no origin message to share back to.
          if (!(e instanceof WebAPIPlatformError) || e.data.error !== 'no_origin_link') throw e;
          await deps.client.agents.conversations.archive({ channel_id: deps.channelId });
        }
      } catch (e) {
        if (!(e instanceof WebAPIPlatformError)) throw e;
        return toolResult(`Could not archive the channel: ${e.data.error}`);
      }

      deps.session.archived = true;
      return toolResult('Posted the summary and archived the channel. The session is over.');
    },
  );
