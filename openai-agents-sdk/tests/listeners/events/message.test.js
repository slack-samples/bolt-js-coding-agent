import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { RunOutcome } from '../../../agent/outcome.js';
import { CodeChannelSession, sessionStore } from '../../../agent/sessions.js';
import { runs } from '../../../agent/turns.js';
import { handleMessage } from '../../../listeners/events/message.js';
import { allArgs, answer, codeChannelInfo, fakeClient, fakeContext, forgetSessions } from '../../helpers.js';

describe('handleMessage', () => {
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
   * @param {string} text
   * @param {Record<string, any>} [event]
   */
  async function send(text, event = {}) {
    await handleMessage(
      /** @type {any} */ ({ client, context, event: { ts: '3.3', channel: 'C_CODE', text, ...event } }),
    );
  }

  it('a message in a code channel runs a turn', async (t) => {
    sessionStore.put(new CodeChannelSession({ channelId: 'C_CODE' }));
    const startRun = t.mock.method(runs, 'startRun', async () => new RunOutcome({ finalOutput: 'Done.' }));

    await send('keep going');

    assert.strictEqual(startRun.mock.calls[0].arguments[1], '<@U123>: keep going');
    assert.deepStrictEqual(allArgs(client.chat.postMessage), [{ channel: 'C_CODE', markdown_text: 'Done.' }]);
    const statuses = allArgs(client.agents.sessions.setStatus).map((args) => args.status);
    assert.deepStrictEqual(statuses, ['processing', 'active']);
  });

  it('a message with a mention is left to app_mention', async (t) => {
    sessionStore.put(new CodeChannelSession({ channelId: 'C_CODE' }));
    const startRun = t.mock.method(runs, 'startRun', async () => new RunOutcome());

    await send('<@UBOT> again');

    assert.strictEqual(startRun.mock.callCount(), 0);
  });

  it('messages during a turn run together next', async (t) => {
    sessionStore.put(new CodeChannelSession({ channelId: 'C_CODE' }));
    /** @type {string[]} */
    const texts = [];
    t.mock.method(runs, 'startRun', async (/** @type {any} */ _history, /** @type {string} */ text) => {
      texts.push(text);
      if (texts.length === 1) {
        // Two people follow up while the first turn is still running.
        await send('also this');
        context.userId = 'U456';
        await send('and this');
      }
      return new RunOutcome({ finalOutput: 'Done.' });
    });

    await send('start');

    assert.deepStrictEqual(texts, ['<@U123>: start', '<@U123>: also this\n\n<@U456>: and this']);
  });

  it('a direct message is answered in place', async (t) => {
    answer(client.conversations.history, {
      ok: true,
      messages: [{ ts: '2.2', user: 'U123', text: 'I use billing-service' }],
    });
    const runRequest = t.mock.method(runs, 'runRequest', async () => 'Sure.');

    await send("what's it written in?", { channel: 'D123', channel_type: 'im' });

    const prompt = runRequest.mock.calls[0].arguments[0];
    assert.ok(prompt.includes('<@U123>: I use billing-service'));
    assert.ok(prompt.endsWith("<@U123>: what's it written in?"));
    assert.deepStrictEqual(allArgs(client.chat.postMessage), [
      { channel: 'D123', thread_ts: undefined, markdown_text: 'Sure.' },
    ]);
  });

  it('a message in another channel is looked up once', async (t) => {
    answer(client.conversations.info, { ok: true, channel: { properties: {} } });
    const startRun = t.mock.method(runs, 'startRun', async () => new RunOutcome());

    await send('lunch?', { channel: 'C_GENERAL' });
    await send('anyone?', { channel: 'C_GENERAL' });

    assert.strictEqual(client.conversations.info.mock.callCount(), 1);
    assert.strictEqual(startRun.mock.callCount(), 0);
  });

  it('a message in a forgotten code channel picks it up', async (t) => {
    answer(client.conversations.info, codeChannelInfo());
    answer(client.conversations.replies, { ok: true, messages: [{ ts: '1.1', user: 'U123', text: 'fix it' }] });
    const startRun = t.mock.method(runs, 'startRun', async () => new RunOutcome({ finalOutput: 'Back.' }));

    await send('you there?');

    assert.strictEqual(startRun.mock.callCount(), 1);
    assert.strictEqual(sessionStore.get('C_CODE')?.originChannelId, 'C_ORIGIN');
  });
});
