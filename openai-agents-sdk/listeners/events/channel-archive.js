import { endSession } from '../../agent/index.js';

/**
 * Forget a code channel someone archived, and delete its working directory.
 *
 * When the agent archives the channel itself, its turn ends the session once
 * `archive_channel` returns, and Bolt skips the app's own event.
 *
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackEventMiddlewareArgs<'channel_archive' | 'group_archive'>} args
 * @returns {Promise<void>}
 */
export async function handleChannelArchive({ event }) {
  endSession(event.channel);
}
