import { resumeTurn } from '../../agent/index.js';

/**
 * Resume the paused run with the decision from whichever button was clicked.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackActionMiddlewareArgs<import('@slack/bolt').BlockButtonAction>} args
 * @returns {Promise<void>}
 */
export async function handleApprovalButtons({ ack, action, body, client }) {
  await ack();
  await resumeTurn({
    client,
    channelId: /** @type {string} */ (body.channel?.id),
    messageTs: /** @type {string} */ (body.message?.ts),
    approved: action.value === 'approve',
  });
}
