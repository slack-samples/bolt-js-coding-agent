import { tool } from '@openai/agents';
import { WebAPIPlatformError } from '@slack/web-api';
import { z } from 'zod';

import { sessionStopped, toolFailed } from '../guardrails.js';

export const archiveChannel = tool({
  name: 'archive_channel',
  description:
    'Post a final summary and archive the code channel.\n' +
    '\n' +
    'Only call this when the user says the work is done or asks to wrap up. The\n' +
    'summary is shared back to the message that started the session. After this,\n' +
    "the session is over and you can't post again.",
  parameters: z.object({
    summary: z.string().describe('A short wrap-up of what changed, where it lives, and anything left to do.'),
  }),
  inputGuardrails: [sessionStopped],
  errorFunction: toolFailed,
  execute: async ({ summary }, context) => {
    const deps = /** @type {import('../sessions.js').AgentDeps} */ (context?.context);
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
      return `Could not archive the channel: ${e.data.error}`;
    }

    deps.session.archived = true;
    return 'Posted the summary and archived the channel. The session is over.';
  },
});
