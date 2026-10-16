/**
 * The SDK hooks that gate tool calls: command approvals, the stop button, and tool errors.
 */

import { defineToolInputGuardrail, ToolGuardrailFunctionOutputFactory } from '@openai/agents';

import { commandNeedsApproval } from './approvals.js';

/**
 * The `needsApproval` hook for `run_command`, checked with its arguments before it runs.
 *
 * Returning true pauses the run with a `RunToolApprovalItem`, which
 * `agent/turns.js` posts as Approve / Deny buttons.
 *
 * @param {import('@openai/agents').RunContext} _context
 * @param {{ command: string }} input
 * @returns {Promise<boolean>}
 */
export async function runCommandNeedsApproval(_context, { command }) {
  const needs = commandNeedsApproval(command ?? '');
  if (needs) {
    console.info(`run_command needs approval: ${command}`);
  }
  return needs;
}

/**
 * Skip every tool call once someone presses the stop button.
 *
 * Each code channel tool lists this guardrail, so a stopped turn changes nothing
 * more in the repo or the channel while the model wraps up.
 */
export const sessionStopped = defineToolInputGuardrail({
  name: 'session_stopped',
  run: async ({ context }) => {
    const deps = /** @type {import('./sessions.js').AgentDeps} */ (context.context);
    if (deps.session.stopped) {
      return ToolGuardrailFunctionOutputFactory.rejectContent(
        "The user stopped this session. Don't call any more tools. " +
          "Reply with one short line saying you've stopped.",
      );
    }
    return ToolGuardrailFunctionOutputFactory.allow();
  },
});

/**
 * Tell the model what went wrong when a tool throws, so it can recover.
 *
 * The SDK's default hides the error behind a fixed message, which leaves the
 * model guessing. Each tool sets this as its `errorFunction`.
 *
 * @param {import('@openai/agents').RunContext} _context
 * @param {unknown} error
 * @returns {string}
 */
export function toolFailed(_context, error) {
  console.error('Tool failed', error);
  const reason = error instanceof Error ? error.message : String(error);
  return `An error occurred while running the tool. Please try again. Error: ${reason}`;
}
