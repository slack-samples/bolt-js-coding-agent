import { answerRequest, findSession, runTurn } from '../../agent/index.js';

/**
 * Handle a direct message, or a message in a code channel, without an @mention.
 *
 * A direct message is answered like a mention: in place, or with a code channel
 * for bigger work. In a code channel the people in it are talking to the agent
 * directly, so every message is a turn. Messages anywhere else are left alone.
 *
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackEventMiddlewareArgs<'message'>} args
 * @returns {Promise<void>}
 */
export async function handleMessage({ client, context, event }) {
  // Ignore edits, joins, or bot posts.
  if (event.subtype || ('bot_id' in event && event.bot_id)) return;
  const mention = `<@${context.botUserId}>`;
  const text = (event.text ?? '').trim();
  const channelId = event.channel;
  const userId = /** @type {string} */ (context.userId);

  if (event.channel_type === 'im') {
    await answerRequest({
      client,
      channelId,
      messageTs: event.ts,
      threadTs: event.thread_ts ?? null,
      text: text.replaceAll(mention, '').trim(),
      userId,
      inDm: true,
    });
    return;
  }

  // A message that mentions the agent also arrives as app_mention, which runs the turn.
  if (!text || text.includes(mention)) return;
  const session = await findSession(client, channelId);
  if (session === null) return;
  await runTurn({ client, session, text, userId });
}
