import { stopTurn } from '../../agent/index.js';

/**
 * Handle the native stop button by stopping the channel's turn.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackEventMiddlewareArgs<'agent_session_stopped'>} args
 * @returns {Promise<void>}
 */
export async function handleAgentSessionStopped({ client, event }) {
  await stopTurn({ client, channelId: event.channel });
}
