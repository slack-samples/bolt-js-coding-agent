import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { setTracingDisabled } from '@openai/agents';

import { agent, MAX_TURNS, outOfTurns, resumeRun, settle, startRun } from '../../agent/agent.js';
import { AgentDeps, CodeChannelSession } from '../../agent/sessions.js';
import { call, FakeModel, say } from '../fake-model.js';
import { fakeClient } from '../helpers.js';

// Tests never reach OpenAI, so there are no traces to send.
setTracingDisabled(true);

/**
 * A run result with the parts `settle` reads.
 * @param {any[]} interruptions
 * @returns {any}
 */
function runResult(interruptions) {
  return {
    finalOutput: 'Done.',
    history: [{ role: 'assistant', content: 'Done.' }],
    interruptions,
    state: { name: 'state' },
  };
}

describe('settle', () => {
  it('a completed run keeps its history', () => {
    const outcome = settle(runResult([]));

    assert.strictEqual(outcome.finalOutput, 'Done.');
    assert.strictEqual(outcome.needsApproval, false);
    assert.deepStrictEqual(outcome.history, [{ role: 'assistant', content: 'Done.' }]);
  });

  it('a paused run answers the pending call in its history', () => {
    const item = {
      rawItem: { type: 'function_call', name: 'run_command', callId: 'call_1' },
      arguments: JSON.stringify({ command: 'rm -rf build' }),
    };
    const result = runResult([item]);

    const outcome = settle(result);

    assert.strictEqual(outcome.paused.item, item);
    assert.strictEqual(outcome.paused.state, result.state);
    assert.strictEqual(outcome.command, 'rm -rf build');
    // A stopped or replaced run leaves this history behind, and every call
    // in it needs an output or the next request fails.
    assert.deepStrictEqual(outcome.history, [
      { role: 'assistant', content: 'Done.' },
      {
        type: 'function_call_result',
        name: 'run_command',
        callId: 'call_1',
        status: 'completed',
        output: "Not run. The user didn't approve this command.",
      },
    ]);
  });
});

describe('resumeRun', () => {
  /**
   * Pause a real run on a command, then resume it with `approved`.
   * @param {import('node:test').TestContext} t
   * @param {boolean} approved
   */
  async function resume(t, approved) {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-test-'));
    t.after(() => fs.rmSync(workdir, { recursive: true, force: true }));
    const original = agent.model;
    agent.model = new FakeModel((n) =>
      n === 1 ? call('run_command', { command: 'touch x', directory: null }) : say('Ok.'),
    );
    t.after(() => {
      agent.model = original;
    });
    const deps = new AgentDeps({ client: fakeClient(), session: new CodeChannelSession({ channelId: 'C1', workdir }) });
    const { paused } = await startRun([], '<@U123>: go', deps);
    const approve = t.mock.method(paused.state, 'approve');
    const reject = t.mock.method(paused.state, 'reject');
    await resumeRun(paused, approved, deps);
    return { paused, approve, reject };
  }

  it('approving approves the pending item', async (t) => {
    const { paused, approve, reject } = await resume(t, true);

    assert.strictEqual(approve.mock.callCount(), 1);
    assert.strictEqual(approve.mock.calls[0].arguments[0], paused.item);
    assert.strictEqual(reject.mock.callCount(), 0);
  });

  it('denying rejects the pending item', async (t) => {
    const { paused, approve, reject } = await resume(t, false);

    assert.strictEqual(reject.mock.callCount(), 1);
    assert.strictEqual(reject.mock.calls[0].arguments[0], paused.item);
    assert.strictEqual(approve.mock.callCount(), 0);
  });
});

describe('outOfTurns', () => {
  it('running out of turns ends with a message in history', () => {
    const result = outOfTurns();

    assert.ok(String(result.finalOutput).includes(String(MAX_TURNS)));
    assert.strictEqual(result.includeInHistory, true);
  });
});
