import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { RunOutcome } from '../../../agent/outcome.js';
import { CodeChannelSession, sessionStore } from '../../../agent/sessions.js';
import { createCodeChannel } from '../../../agent/tools/index.js';
import { runs } from '../../../agent/turns.js';
import { handleAppMentioned } from '../../../listeners/events/app-mentioned.js';
import { allArgs, answer, codeChannelInfo, fakeClient, fakeContext, forgetSessions, lastArgs } from '../../helpers.js';
import { invoke } from '../../invoke.js';

describe('handleAppMentioned', () => {
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
  async function mention(text, event = {}) {
    await handleAppMentioned(
      /** @type {any} */ ({
        client,
        context,
        event: { ts: '1.1', channel: 'C_CODE', text: `<@UBOT> ${text}`, ...event },
      }),
    );
  }

  /**
   * Mention the agent in C_ORIGIN, a normal channel, where `respond` answers the request.
   * @param {import('node:test').TestContext} t
   * @param {(prompt: string, deps: any) => Promise<string | null | undefined>} respond
   * @param {string} [text]
   * @param {Record<string, any>} [event]
   */
  async function mentionInOrigin(t, respond, text = 'fix the login test', event = {}) {
    answer(client.conversations.info, { ok: true, channel: { properties: {} } });
    answer(client.agents.conversations.create, { ok: true, channel_id: 'C_CODE' });
    const runRequest = t.mock.method(runs, 'runRequest', respond);
    const startRun = t.mock.method(runs, 'startRun', async () => new RunOutcome());
    await mention(text, { channel: 'C_ORIGIN', ...event });
    return { runRequest, startRun };
  }

  it('a mention answered in place opens no channel', async (t) => {
    const { startRun } = await mentionInOrigin(t, async () => "It's a billing service.", 'what does billing do?');

    assert.strictEqual(client.agents.conversations.create.mock.callCount(), 0);
    assert.strictEqual(startRun.mock.callCount(), 0);
    assert.deepStrictEqual(lastArgs(client.chat.postMessage), {
      channel: 'C_ORIGIN',
      thread_ts: '1.1',
      markdown_text: "It's a billing service.",
    });
  });

  it('a mention in a thread gets the thread so far', async (t) => {
    answer(client.conversations.replies, {
      ok: true,
      messages: [
        { ts: '0.5', user: 'U9', text: 'the login test flakes on CI' },
        { ts: '1.1', user: 'U123', text: '<@UBOT> can you fix this?' },
      ],
    });

    const { runRequest } = await mentionInOrigin(t, async () => 'On it.', 'can you fix this?', { thread_ts: '0.5' });

    const prompt = runRequest.mock.calls[0].arguments[0];
    assert.ok(prompt.includes('<@U9>: the login test flakes on CI'));
    assert.ok(prompt.endsWith('<@U123>: can you fix this?'));
    assert.strictEqual(lastArgs(client.chat.postMessage).thread_ts, '0.5');
  });

  it('creating a channel leaves the first turn to the seeded mention', async (t) => {
    const { startRun } = await mentionInOrigin(t, async (_prompt, deps) => {
      await invoke(createCodeChannel, deps, { title: 'Fix login test' });
      return '';
    });

    const create = lastArgs(client.agents.conversations.create);
    assert.strictEqual(create.origin_channel_id, 'C_ORIGIN');
    assert.strictEqual(create.origin_message_ts, '1.1');
    assert.strictEqual(create.session_id, 'C_ORIGIN-1.1');
    // Slack seeds the new channel with the request, and that mention runs the turn.
    assert.strictEqual(startRun.mock.callCount(), 0);
    assert.deepStrictEqual(allArgs(client.chat.postMessage), [
      { channel: 'C_ORIGIN', thread_ts: '1.1', text: 'On it! Follow along in <#C_CODE>.' },
    ]);
  });

  it('creating a channel twice points to it once', async (t) => {
    await mentionInOrigin(t, async (_prompt, deps) => {
      await invoke(createCodeChannel, deps, { title: 'Fix login test' });
      await invoke(createCodeChannel, deps, { title: 'Fix the login test' });
      return '';
    });

    const sessions = allArgs(client.agents.conversations.create).map((args) => args.session_id);
    assert.deepStrictEqual(sessions, ['C_ORIGIN-1.1', 'C_ORIGIN-1.1']);
    assert.strictEqual(client.chat.postMessage.mock.callCount(), 1);
  });

  it('an empty mention explains itself', async () => {
    answer(client.conversations.info, { ok: true, channel: { properties: {} } });

    await handleAppMentioned(
      /** @type {any} */ ({ client, context, event: { ts: '1.1', channel: 'C_ORIGIN', text: '<@UBOT>' } }),
    );

    assert.ok(lastArgs(client.chat.postMessage).text.includes('Mention me'));
  });

  it('a failed turn in a code channel warns top-level', async (t) => {
    sessionStore.put(new CodeChannelSession({ channelId: 'C_CODE' }));
    t.mock.method(runs, 'startRun', async () => {
      throw new Error('boom');
    });

    await mention('keep going', { ts: '6.6' });

    const warning = lastArgs(client.chat.postMessage);
    assert.strictEqual(warning.channel, 'C_CODE');
    assert.ok(!('thread_ts' in warning));
    assert.ok(warning.text.includes('boom'));
    // The failed turn moves the session out of processing.
    assert.deepStrictEqual(lastArgs(client.agents.sessions.setStatus), { channel_id: 'C_CODE', status: 'active' });
  });

  it('a new code channel starts with the conversation it came from', async (t) => {
    answer(client.conversations.info, codeChannelInfo('C_ORIGIN', '1.1'));
    answer(client.conversations.replies, (/** @type {any} */ { channel, ts }) => {
      assert.strictEqual(channel, 'C_ORIGIN');
      if (ts === '1.1') {
        return { ok: true, messages: [{ ts: '1.1', thread_ts: '0.5', user: 'U123' }] };
      }
      return {
        ok: true,
        messages: [
          { ts: '0.5', user: 'U9', text: 'the login test flakes' },
          { ts: '1.1', user: 'U123', text: '<@UBOT> fix this' },
        ],
      };
    });
    const startRun = t.mock.method(
      runs,
      'startRun',
      async () => new RunOutcome({ finalOutput: 'Cloning.', history: ['turn'] }),
    );

    await mention('fix this', { ts: '7.7' });
    await mention('and add a test', { ts: '7.8' });

    const [first, second] = startRun.mock.calls.map((c) => c.arguments[1]);
    assert.ok(first.startsWith('This code channel was started from this conversation:'));
    assert.ok(first.includes('<@U9>: the login test flakes'));
    assert.ok(first.endsWith('<@U123>: fix this'));
    assert.strictEqual(second, '<@U123>: and add a test');
  });
});
