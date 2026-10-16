/**
 * The conversation around a request, read from Slack and given to the agent with it.
 */

import { WebAPIPlatformError } from '@slack/web-api';

// Enough earlier conversation to follow along without crowding the prompt.
const MAX_MESSAGES = 50;
const MAX_MESSAGE_CHARS = 2000;

/**
 * One line per message, starting with who sent it.
 * @param {any[]} messages
 * @returns {string}
 */
function transcript(messages) {
  return messages
    .slice(-MAX_MESSAGES)
    .map((message) => {
      const sender = message.user ? `<@${message.user}>` : 'An app';
      return `${sender}: ${(message.text ?? '').slice(0, MAX_MESSAGE_CHARS)}`;
    })
    .join('\n');
}

/**
 * The messages in a thread that came before `beforeTs`.
 * @param {import('@slack/web-api').WebClient} client
 * @param {string} channelId
 * @param {string} threadTs
 * @param {{ beforeTs: string }} options
 * @returns {Promise<string>}
 */
export async function threadContext(client, channelId, threadTs, { beforeTs }) {
  let response;
  try {
    response = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 200 });
  } catch (e) {
    if (!(e instanceof WebAPIPlatformError)) throw e;
    console.warn(`Couldn't read the thread: ${e.data.error}`);
    return '';
  }
  const messages = response.messages ?? [];
  return transcript(messages.filter((m) => Number(m.ts) < Number(beforeTs)));
}

/**
 * The latest messages in a conversation before `beforeTs`, like a direct message's.
 * @param {import('@slack/web-api').WebClient} client
 * @param {string} channelId
 * @param {{ beforeTs: string }} options
 * @returns {Promise<string>}
 */
export async function recentContext(client, channelId, { beforeTs }) {
  let response;
  try {
    response = await client.conversations.history({ channel: channelId, latest: beforeTs, limit: 20 });
  } catch (e) {
    if (!(e instanceof WebAPIPlatformError)) throw e;
    console.warn(`Couldn't read the conversation: ${e.data.error}`);
    return '';
  }
  // History comes newest first.
  return transcript([...(response.messages ?? [])].reverse());
}

/**
 * The conversation before the message a code channel was started from.
 * @param {import('@slack/web-api').WebClient} client
 * @param {string} channelId
 * @param {string} ts
 * @returns {Promise<string>}
 */
export async function originContext(client, channelId, ts) {
  // A direct message's context is the conversation before it, not a thread.
  if (channelId.startsWith('D')) {
    return await recentContext(client, channelId, { beforeTs: ts });
  }
  let response;
  try {
    response = await client.conversations.replies({ channel: channelId, ts, limit: 1 });
  } catch (e) {
    if (!(e instanceof WebAPIPlatformError)) throw e;
    console.warn(`Couldn't read the origin message: ${e.data.error}`);
    return '';
  }
  const threadTs = response.messages?.[0]?.thread_ts;
  if (!threadTs) return '';
  return await threadContext(client, channelId, threadTs, { beforeTs: ts });
}
