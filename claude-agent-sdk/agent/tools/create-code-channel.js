import { tool } from '@anthropic-ai/claude-agent-sdk';
import { WebAPIPlatformError } from '@slack/web-api';
import { z } from 'zod';

import { toolResult } from './tool-result.js';

/** @param {import('../sessions.js').RequestDeps} deps */
export const createCodeChannel = (deps) =>
  tool(
    'create_code_channel',
    'Create a code channel for this request, where the coding work happens.\n' +
      '\n' +
      'Call it when the work will take more than one message: changing code, running\n' +
      'builds or tests, opening a pull request, or iterating with the requester. The\n' +
      "work continues in the new channel, so don't start it here.",
    {
      title: z.string().describe('A short, descriptive title for the task, such as `Fix flaky login test`.'),
    },
    async ({ title }) => {
      let created;
      try {
        // The session_id comes from the triggering message, not the model, so a
        // repeated call or a retried event reuses the same channel.
        created = await deps.client.agents.conversations.create({
          name: title.slice(0, 80),
          session_id: `${deps.channelId}-${deps.messageTs}`,
          origin_channel_id: deps.channelId,
          origin_message_ts: deps.messageTs,
        });
      } catch (e) {
        if (!(e instanceof WebAPIPlatformError)) throw e;
        return toolResult(`Could not create a code channel: ${e.data.error}`);
      }

      const channelId = /** @type {string} */ (created.channel_id);
      // Slack seeds the channel with the request, mention included, and that
      // mention starts the session there.
      if (deps.codeChannelId === null) {
        await deps.client.chat.postMessage({
          channel: deps.channelId,
          thread_ts: deps.threadTs ?? undefined,
          text: `On it! Follow along in <#${channelId}>.`,
        });
      }
      deps.codeChannelId = channelId;
      return toolResult(`Created <#${channelId}>. The work continues there.`);
    },
  );
