import { handleAgentCommand } from './agent-command.js';

/**
 * Register command listeners with the Bolt app.
 * @param {import('@slack/bolt').App} app
 * @returns {void}
 */
export function register(app) {
  // Commands are registered per channel by the agent (set_commands), so match them all.
  app.command(/^\/.+/, handleAgentCommand);
}
