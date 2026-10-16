import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { PendingApproval, pendingStore } from '../../../agent/approvals.js';
import { RunOutcome } from '../../../agent/outcome.js';
import { CodeChannelSession, sessionStore } from '../../../agent/sessions.js';
import { runs } from '../../../agent/turns.js';
import { handleAgentSessionStopped } from '../../../listeners/events/agent-session-stopped.js';
import { handleMessage } from '../../../listeners/events/message.js';
import { allArgs, fakeClient, fakeContext, forgetSessions, lastArgs } from '../../helpers.js';

describe('handleAgentSessionStopped', () => {
  /** @type {any} */
  let client;
  /** @type {any} */
  let context;

  beforeEach(() => {
    client = fakeClient();
    context = fakeContext();
  });

  afterEach(forgetSessions);

  async function stop() {
    await handleAgentSessionStopped(
      /** @type {any} */ ({ client, context, event: { channel: 'C_CODE', streaming_message_ts: [] } }),
    );
  }

  /** @param {string} text */
  async function send(text) {
    await handleMessage(/** @type {any} */ ({ client, context, event: { ts: '4.4', channel: 'C_CODE', text } }));
  }

  it('a stop confirms and leaves processing', async () => {
    const session = new CodeChannelSession({ channelId: 'C_CODE', inbox: ['<@U1>: queued'] });
    sessionStore.put(session);

    await stop();

    assert.strictEqual(session.stopped, true);
    assert.deepStrictEqual(session.inbox, []);
    assert.strictEqual(client.chat.postMessage.mock.callCount(), 1);
    assert.strictEqual(lastArgs(client.chat.postMessage).channel, 'C_CODE');
    assert.ok(lastArgs(client.chat.postMessage).text.includes('Stopped'));
    assert.deepStrictEqual(allArgs(client.agents.sessions.setStatus), [{ channel_id: 'C_CODE', status: 'active' }]);
  });

  it('a stop drops the pending approval and its buttons', async () => {
    sessionStore.put(new CodeChannelSession({ channelId: 'C_CODE' }));
    pendingStore.put(
      'C_CODE',
      new PendingApproval({ paused: {}, deps: /** @type {any} */ ({}), command: 'rm -rf build', messageTs: '9.1' }),
    );

    await stop();

    assert.strictEqual(pendingStore.pop('C_CODE', '9.1'), null);
    const update = lastArgs(client.chat.update);
    assert.strictEqual(update.ts, '9.1');
    assert.ok(update.text.includes('Stopped before running'));
    assert.ok(update.text.includes('rm -rf build'));
  });

  it('a stopped turn posts nothing more', async (t) => {
    sessionStore.put(new CodeChannelSession({ channelId: 'C_CODE' }));
    t.mock.method(runs, 'startRun', async () => {
      await stop();
      return new RunOutcome({ finalOutput: 'Done.' });
    });

    await send('keep going');

    // Only the stop confirmation is posted, not the turn's "Done.".
    const posts = allArgs(client.chat.postMessage).map((args) => args.text);
    assert.strictEqual(posts.length, 1);
    assert.ok(posts[0].includes('Stopped'));
    const statuses = allArgs(client.agents.sessions.setStatus).map((args) => args.status);
    // The stop sets active, and the stopped turn sets it again in case its
    // processing landed after the stop.
    assert.deepStrictEqual(statuses, ['processing', 'active', 'active']);
  });

  it('a message after the stop picks back up', async (t) => {
    sessionStore.put(new CodeChannelSession({ channelId: 'C_CODE' }));
    /** @type {string[]} */
    const texts = [];
    t.mock.method(runs, 'startRun', async (/** @type {any} */ _history, /** @type {string} */ text) => {
      texts.push(text);
      if (texts.length === 1) {
        await stop();
        await send('try this instead');
      }
      return new RunOutcome({ finalOutput: 'Done.' });
    });

    await send('keep going');

    assert.deepStrictEqual(texts, ['<@U123>: keep going', '<@U123>: try this instead']);
    assert.strictEqual(sessionStore.get('C_CODE')?.stopped, false);
  });
});
