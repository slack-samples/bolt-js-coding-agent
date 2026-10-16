import assert from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { pendingStore } from '../../../agent/approvals.js';
import { RunOutcome } from '../../../agent/outcome.js';
import { CodeChannelSession, sessionStore } from '../../../agent/sessions.js';
import { runs } from '../../../agent/turns.js';
import { handleApprovalButtons } from '../../../listeners/actions/approval-buttons.js';
import { handleMessage } from '../../../listeners/events/message.js';
import { answer, fakeClient, fakeContext, forgetSessions, lastArgs } from '../../helpers.js';

const HISTORY = [{ role: 'assistant', content: 'Done.' }];

describe('handleApprovalButtons', () => {
  /** @type {any} */
  let client;
  /** @type {any} */
  let context;

  beforeEach(() => {
    client = fakeClient();
    context = fakeContext();
  });

  afterEach(forgetSessions);

  /**
   * Send a message in C_CODE whose turn ends with `outcome`.
   * @param {import('node:test').TestContext} t
   * @param {string} text
   * @param {RunOutcome} outcome
   * @param {string} [ts]
   */
  async function send(t, text, outcome, ts = '8.8') {
    answer(client.chat.postMessage, { ok: true, ts });
    const startRun = t.mock.method(runs, 'startRun', async () => outcome);
    await handleMessage(/** @type {any} */ ({ client, context, event: { ts: '5.5', channel: 'C_CODE', text } }));
    startRun.mock.restore();
  }

  /**
   * Run a turn in C_CODE that pauses on `command`, posting buttons at `messageTs`.
   * @param {import('node:test').TestContext} t
   * @param {string} command
   * @param {string} messageTs
   */
  async function pauseOn(t, command, messageTs) {
    sessionStore.put(sessionStore.get('C_CODE') ?? new CodeChannelSession({ channelId: 'C_CODE' }));
    const paused = { id: `paused at ${messageTs}` };
    await send(t, `run ${command}`, new RunOutcome({ paused, command, history: HISTORY }), messageTs);
    return paused;
  }

  /** @param {string} value @param {string} messageTs */
  async function click(value, messageTs) {
    await handleApprovalButtons(
      /** @type {any} */ ({
        ack: mock.fn(async () => {}),
        action: { value },
        body: { channel: { id: 'C_CODE' }, message: { ts: messageTs } },
        client,
      }),
    );
  }

  /** @param {import('node:test').TestContext} t @param {RunOutcome} [resumed] */
  function resumeWith(t, resumed = new RunOutcome({ finalOutput: 'Ran it.', history: HISTORY })) {
    return t.mock.method(runs, 'resumeRun', async () => resumed);
  }

  it('approving resumes the paused run', async (t) => {
    const paused = await pauseOn(t, 'rm -rf build', '9.1');
    const resumeRun = resumeWith(t);

    await click('approve', '9.1');

    assert.deepStrictEqual(resumeRun.mock.calls[0].arguments.slice(0, 2), [paused, true]);
    const update = lastArgs(client.chat.update);
    assert.strictEqual(update.ts, '9.1');
    assert.ok(update.text.includes('Approved'));
    assert.ok(update.text.includes('rm -rf build'));
  });

  it('denying resumes the paused run with a rejection', async (t) => {
    const paused = await pauseOn(t, 'rm -rf build', '9.1');
    const resumeRun = resumeWith(t);

    await click('deny', '9.1');

    assert.deepStrictEqual(resumeRun.mock.calls[0].arguments.slice(0, 2), [paused, false]);
    assert.ok(lastArgs(client.chat.update).text.includes('Denied'));
  });

  it('a stale approval never approves a newer command', async (t) => {
    await pauseOn(t, 'rm -rf build', '9.1');
    await pauseOn(t, 'git push --force', '9.2');
    const resumeRun = resumeWith(t);

    await click('approve', '9.1');

    assert.strictEqual(resumeRun.mock.callCount(), 0);
    const update = lastArgs(client.chat.update);
    assert.strictEqual(update.ts, '9.1');
    assert.ok(update.text.includes('expired'));
    assert.strictEqual(pendingStore.pop('C_CODE', '9.2')?.command, 'git push --force');
  });

  it('a newer message retires the pending approval', async (t) => {
    await pauseOn(t, 'rm -rf build', '9.1');
    const newer = [{ role: 'assistant', content: 'Newer.' }];

    await send(t, 'never mind', new RunOutcome({ finalOutput: 'Newer.', history: newer }));

    // The buttons say the command was skipped, and a late click resumes nothing.
    const skipped = lastArgs(client.chat.update);
    assert.strictEqual(skipped.ts, '9.1');
    assert.ok(skipped.text.includes('Skipped'));
    const resumeRun = resumeWith(t);
    await click('approve', '9.1');
    assert.strictEqual(resumeRun.mock.callCount(), 0);
    assert.deepStrictEqual(sessionStore.get('C_CODE')?.history, newer);
  });

  it('messages sent during a resumed command run next', async (t) => {
    await pauseOn(t, 'pytest', '9.1');
    /** @type {string[]} */
    const texts = [];
    t.mock.method(runs, 'resumeRun', async () => {
      await handleMessage(
        /** @type {any} */ ({ client, context, event: { ts: '5.6', channel: 'C_CODE', text: 'then lint' } }),
      );
      return new RunOutcome({ finalOutput: 'Tests pass.', history: HISTORY });
    });
    t.mock.method(runs, 'startRun', async (/** @type {any} */ _history, /** @type {string} */ text) => {
      texts.push(text);
      return new RunOutcome({ finalOutput: 'Linted.', history: HISTORY });
    });

    await click('approve', '9.1');

    assert.deepStrictEqual(texts, ['<@U123>: then lint']);
  });

  it('a failed resume leaves processing', async (t) => {
    await pauseOn(t, 'rm -rf build', '9.1');
    t.mock.method(runs, 'resumeRun', async () => {
      throw new Error('boom');
    });

    await click('approve', '9.1');

    assert.ok(lastArgs(client.chat.postMessage).text.includes('boom'));
    assert.deepStrictEqual(lastArgs(client.agents.sessions.setStatus), { channel_id: 'C_CODE', status: 'active' });
  });
});
