import assert from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { RunOutcome } from '../../../agent/outcome.js';
import { CodeChannelSession, sessionStore } from '../../../agent/sessions.js';
import { runs } from '../../../agent/turns.js';
import { handleAgentCommand } from '../../../listeners/commands/agent-command.js';
import { answer, fakeClient, forgetSessions } from '../../helpers.js';

describe('handleAgentCommand', () => {
  /** @type {any} */
  let client;

  beforeEach(() => {
    client = fakeClient();
  });

  afterEach(forgetSessions);

  /** @param {Record<string, any>} command */
  async function runCommand(command) {
    const ack = mock.fn(async () => {});
    const respond = mock.fn(async () => {});
    await handleAgentCommand(
      /** @type {any} */ ({ ack, command: { user_id: 'U123', command: '/run-tests', ...command }, client, respond }),
    );
    return { ack, respond };
  }

  it('a command in a code channel runs a turn', async (t) => {
    sessionStore.put(new CodeChannelSession({ channelId: 'C_CODE' }));
    const startRun = t.mock.method(runs, 'startRun', async () => new RunOutcome({ finalOutput: 'Tests passed.' }));

    const { ack, respond } = await runCommand({ channel_id: 'C_CODE', text: 'unit' });

    assert.strictEqual(ack.mock.callCount(), 1);
    assert.strictEqual(startRun.mock.calls[0].arguments[1], '<@U123>: /run-tests unit');
    assert.strictEqual(respond.mock.callCount(), 0);
  });

  it('a command without a session explains itself', async (t) => {
    answer(client.conversations.info, { ok: true, channel: { properties: {} } });
    const startRun = t.mock.method(runs, 'startRun', async () => new RunOutcome());

    const { ack, respond } = await runCommand({ channel_id: 'C_OTHER' });

    assert.strictEqual(ack.mock.callCount(), 1);
    assert.strictEqual(startRun.mock.callCount(), 0);
    assert.ok(/** @type {any} */ (respond.mock.calls[0]).arguments[0].includes('Mention me'));
  });
});
