import { handleApprovalButtons } from './approval-buttons.js';

/**
 * Register action listeners with the Bolt app.
 * @param {import('@slack/bolt').App} app
 * @returns {void}
 */
export function register(app) {
  app.action('approve_command', handleApprovalButtons);
  app.action('deny_command', handleApprovalButtons);
}
