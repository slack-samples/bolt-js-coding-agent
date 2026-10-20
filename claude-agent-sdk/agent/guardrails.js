/**
 * The SDK hooks that gate tool calls: command approvals and the stop button.
 *
 * Every coding agent tool call goes through the `PreToolUse` hook that
 * `gateToolCalls` builds for a run. It decides each call:
 *
 * - `allow` — run it.
 * - `deny` — skip it and tell the model why, like after the stop button.
 * - `defer` — end the run here, leaving the call waiting. A `run_command` that
 *   `commandNeedsApproval()` defers, and `agent/turns.js` posts Approve / Deny
 *   buttons. Resuming the session asks the hook about the same call again, and
 *   the decision is the answer.
 * - `ask` — hand the call to `answerUnanswered`. That's only for a call a dropped
 *   paused run left waiting.
 */

import { commandNeedsApproval } from './approvals.js';

// The name the model calls `run_command` by, through the agent's MCP server.
const RUN_COMMAND = 'mcp__coding-agent__run_command';

/**
 * @param {import('@anthropic-ai/claude-agent-sdk').HookPermissionDecision} permissionDecision
 * @param {string} [permissionDecisionReason]
 * @returns {import('@anthropic-ai/claude-agent-sdk').HookJSONOutput}
 */
function decide(permissionDecision, permissionDecisionReason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision,
      ...(permissionDecisionReason ? { permissionDecisionReason } : {}),
    },
  };
}

/**
 * The `PreToolUse` hook for one coding agent run.
 * @param {Object} fields
 * @param {import('./sessions.js').AgentDeps} fields.deps
 * @param {{ toolUseId: string, approved: boolean }} [fields.approval] - The deferred call this run resumes, and whether someone approved it.
 * @param {string} [fields.unanswered] - A call a paused run left waiting that was never resumed.
 * @returns {import('@anthropic-ai/claude-agent-sdk').HookCallback}
 */
export function gateToolCalls({ deps, approval, unanswered }) {
  return async (input, toolUseId) => {
    // Resuming the session asks about a call left waiting before anything else.
    if (unanswered !== undefined && toolUseId === unanswered) return decide('ask');
    // Skip every tool call once someone presses the stop button, so a stopped
    // turn changes nothing more in the repo or the channel while the model
    // wraps up.
    if (deps.session.stopped) {
      return decide(
        'deny',
        "The user stopped this session. Don't call any more tools. " +
          "Reply with one short line saying you've stopped.",
      );
    }
    if (approval && toolUseId === approval.toolUseId) {
      return approval.approved ? decide('allow') : decide('deny', 'The user denied running this command.');
    }
    if (input.hook_event_name === 'PreToolUse' && input.tool_name === RUN_COMMAND) {
      const command = String(/** @type {{ command?: string }} */ (input.tool_input).command ?? '');
      if (commandNeedsApproval(command)) {
        console.info(`run_command needs approval: ${command}`);
        return decide('defer');
      }
    }
    return decide('allow');
  };
}

/**
 * Answer the call a dropped paused run left waiting, as not run.
 *
 * This is the SDK's `canUseTool` callback, and the hook only sends it that
 * call. Interrupting ends the old turn there, without a reply from the model,
 * so the new turn starts right after.
 * @type {import('@anthropic-ai/claude-agent-sdk').CanUseTool}
 */
export async function answerUnanswered() {
  return { behavior: 'deny', message: "Not run. The user didn't approve this command.", interrupt: true };
}
