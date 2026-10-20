/**
 * Publish a short Home tab that explains how to start a task.
 *
 * Under agent_view this event also fires for the Messages tab, which needs no
 * view since messages there are answered like mentions.
 *
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackEventMiddlewareArgs<'app_home_opened'>} args
 * @returns {Promise<void>}
 */
export async function handleAppHomeOpened({ client, context, event }) {
  if (event.tab !== 'home') return;

  await client.views.publish({
    user_id: /** @type {string} */ (context.userId),
    view: {
      type: 'home',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              'Message me here, or mention me in a channel, with a coding ' +
              "task and a repo. I'll answer quick questions in place and " +
              'create a code channel for anything that takes more than ' +
              'one message.',
          },
        },
      ],
    },
  });
}
