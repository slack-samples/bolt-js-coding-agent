import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';

import { handleAppHomeOpened } from '../../../listeners/events/app-home-opened.js';
import { fakeClient, fakeContext, lastArgs } from '../../helpers.js';

describe('handleAppHomeOpened', () => {
  /** @type {any} */
  let client;

  beforeEach(() => {
    client = fakeClient();
  });

  it('publishes the home view when the tab is home', async () => {
    await handleAppHomeOpened(/** @type {any} */ ({ client, context: fakeContext(), event: { tab: 'home' } }));

    const publish = lastArgs(client.views.publish);
    assert.strictEqual(publish.user_id, 'U123');
    assert.strictEqual(publish.view.type, 'home');
  });

  it('does nothing when the tab is messages', async () => {
    await handleAppHomeOpened(/** @type {any} */ ({ client, context: fakeContext(), event: { tab: 'messages' } }));

    assert.strictEqual(client.views.publish.mock.callCount(), 0);
  });
});
