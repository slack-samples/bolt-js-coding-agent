import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { PendingApproval, pendingStore } from '../../../agent/approvals.js';
import { RunOutcome } from '../../../agent/outcome.js';
import { AgentDeps, CodeChannelSession, sessionStore } from '../../../agent/sessions.js';
import { deliverOutcome } from '../../../agent/turns.js';
import { handleChannelArchive } from '../../../listeners/events/channel-archive.js';
import { fakeClient, fakeContext, forgetSessions } from '../../helpers.js';

describe('handleChannelArchive', () => {
  afterEach(forgetSessions);

  it('archiving from Slack forgets the session', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-'));
    sessionStore.put(new CodeChannelSession({ channelId: 'C_CODE', workdir }));
    pendingStore.put(
      'C_CODE',
      new PendingApproval({ paused: {}, deps: /** @type {any} */ ({}), command: 'rm -rf build', messageTs: '9.1' }),
    );

    await handleChannelArchive(/** @type {any} */ ({ context: fakeContext(), event: { channel: 'C_CODE' } }));

    assert.strictEqual(sessionStore.get('C_CODE'), null);
    assert.strictEqual(pendingStore.pop('C_CODE', '9.1'), null);
    assert.ok(!fs.existsSync(workdir));
  });

  it('a turn running when Slack archives stays quiet', async () => {
    const client = fakeClient();
    const session = new CodeChannelSession({ channelId: 'C_CODE' });
    sessionStore.put(session);

    await handleChannelArchive(/** @type {any} */ ({ context: fakeContext(), event: { channel: 'C_CODE' } }));
    // The turn that was running finishes after the archive.
    await deliverOutcome({
      outcome: new RunOutcome({ finalOutput: 'Done.' }),
      deps: new AgentDeps({ client, session }),
    });

    assert.ok(session.archived && session.stopped);
    assert.strictEqual(sessionStore.get('C_CODE'), null);
    assert.strictEqual(client.chat.postMessage.mock.callCount(), 0);
  });
});
