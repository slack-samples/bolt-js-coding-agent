import assert from 'node:assert';
import { describe, it } from 'node:test';

import { MAX_TURNS, resumeRun, sdk, settle } from '../../agent/agent.js';
import { AgentDeps, CodeChannelSession } from '../../agent/sessions.js';
import { fakeClient } from '../helpers.js';

/**
 * A run's result, completed unless `fields` say otherwise.
 * @param {Record<string, any>} [fields]
 * @returns {any}
 */
function result(fields = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 1,
    session_id: 'session-1',
    result: 'Done.',
    ...fields,
  };
}

/**
 * The result of a run that ended on a command waiting for approval.
 * @param {string} [command]
 */
function deferred(command = 'rm -rf build') {
  return result({
    result: '',
    terminal_reason: 'tool_deferred',
    deferred_tool_use: { id: 'toolu_1', name: 'mcp__coding-agent__run_command', input: { command } },
  });
}

describe('settle', () => {
  it('a completed run keeps its history', () => {
    const earlier = result();
    const done = result();

    const outcome = settle([earlier], done);

    assert.strictEqual(outcome.finalOutput, 'Done.');
    assert.strictEqual(outcome.needsApproval, false);
    assert.deepStrictEqual(outcome.history, [earlier, done]);
  });

  it('a paused run leaves the pending call for the next run to answer', () => {
    const paused = deferred();

    const outcome = settle([], paused);

    assert.deepStrictEqual(outcome.paused.history, [paused]);
    assert.strictEqual(outcome.command, 'rm -rf build');
    // A stopped or replaced run leaves this history behind, and the next run
    // answers its waiting call as not run.
    assert.strictEqual(outcome.history.at(-1).deferred_tool_use.id, 'toolu_1');
  });

  it('a failed run throws with its errors', () => {
    assert.throws(
      () => settle([], result({ subtype: 'error_during_execution', is_error: true, errors: ['API Error: 500'] })),
      /API Error: 500/,
    );
  });
});

describe('resumeRun', () => {
  /**
   * Resume a paused run, and return the hook's decision on its pending call.
   * @param {import('node:test').TestContext} t
   * @param {boolean} approved
   */
  async function resume(t, approved) {
    const query = t.mock.method(sdk, 'query', () =>
      (async function* () {
        yield result();
      })(),
    );
    const deps = new AgentDeps({ client: fakeClient(), session: new CodeChannelSession({ channelId: 'C_CODE' }) });

    await resumeRun({ history: [deferred()] }, approved, deps);

    const { prompt, options } = /** @type {any} */ (query.mock.calls[0].arguments[0]);
    assert.strictEqual(options.resume, 'session-1');
    // Resuming sends no prompt, so the CLI picks the deferred call back up.
    assert.strictEqual(typeof prompt, 'object');
    const hook = options.hooks.PreToolUse[0].hooks[0];
    const input = {
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__coding-agent__run_command',
      tool_input: { command: 'rm -rf build' },
      tool_use_id: 'toolu_1',
    };
    const output = await hook(input, 'toolu_1', { signal: new AbortController().signal });
    return output.hookSpecificOutput;
  }

  it('approving approves the pending item', async (t) => {
    const decision = await resume(t, true);

    assert.strictEqual(decision.permissionDecision, 'allow');
  });

  it('denying rejects the pending item', async (t) => {
    const decision = await resume(t, false);

    assert.strictEqual(decision.permissionDecision, 'deny');
    assert.ok(decision.permissionDecisionReason.includes('denied'));
  });
});

describe('outOfTurns', () => {
  it('running out of turns ends with a message in history', () => {
    const outOfTurns = result({ subtype: 'error_max_turns', is_error: true, errors: [] });

    const outcome = settle([], outOfTurns);

    assert.ok(String(outcome.finalOutput).includes(String(MAX_TURNS)));
    assert.deepStrictEqual(outcome.history, [outOfTurns]);
  });
});
