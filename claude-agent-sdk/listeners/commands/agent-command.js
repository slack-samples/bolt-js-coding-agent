import { findSession, runTurn } from '../../agent/index.js';

/**
 * Handle a slash command the agent registered in a code channel.
 *
 * The command and its text become the next turn, like `/run-tests unit`, so the
 * agent decides what each of its commands does.
 *
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackCommandMiddlewareArgs} args
 * @returns {Promise<void>}
 */
export async function handleAgentCommand({ ack, command, client, respond }) {
  await ack();

  const session = await findSession(client, command.channel_id);
  if (session === null) {
    await respond("I don't have a session here. Mention me to start one.");
    return;
  }

  const text = `${command.command} ${command.text ?? ''}`.trim();
  await runTurn({ client, session, text, userId: command.user_id });
}
