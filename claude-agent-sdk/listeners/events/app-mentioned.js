import { answerRequest, findSession, runTurn } from '../../agent/index.js';

/**
 * Handle an @mention by replying in place or creating a code channel.
 *
 * A mention in a normal channel is the entry point: the agent decides whether
 * the request fits in a reply or calls `create_code_channel`. A mention inside
 * a code channel is a turn in that session. That includes the request Slack
 * seeds into a channel the agent just created, which starts its first turn.
 *
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackEventMiddlewareArgs<'app_mention'>} args
 * @returns {Promise<void>}
 */
export async function handleAppMentioned({ client, context, event }) {
  const channelId = event.channel;
  const userId = /** @type {string} */ (context.userId);
  const text = (event.text ?? '').replaceAll(`<@${context.botUserId}>`, '').trim();

  const session = await findSession(client, channelId);
  if (session !== null) {
    await runTurn({ client, session, text, userId });
    return;
  }

  await answerRequest({
    client,
    channelId,
    messageTs: event.ts,
    threadTs: event.thread_ts ?? null,
    text,
    userId,
    inDm: false,
  });
}
