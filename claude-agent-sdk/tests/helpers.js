/**
 * Fakes shared by the tests: a Slack client, a Bolt context, and Slack's responses.
 */

import { mock } from 'node:test';

import { WebAPIPlatformError, WebClient } from '@slack/web-api';

import { pendingStore } from '../agent/approvals.js';
import { sessionStore } from '../agent/sessions.js';
import { otherChannels } from '../agent/turns.js';

/** @type {WeakMap<object, string[]>} */
const clientLogs = new WeakMap();
/** @type {WeakMap<object, { log: string[], name: string }>} */
const methodNames = new WeakMap();

/**
 * Have a fake client method answer with `response`: a value, an error to throw,
 * or a function called with the method's arguments.
 * @param {any} method
 * @param {any} response
 */
export function answer(method, response) {
  const { log, name } = /** @type {{ log: string[], name: string }} */ (methodNames.get(method));
  method.mock.mockImplementation(async (/** @type {any} */ args) => {
    log.push(name);
    if (response instanceof Error) throw response;
    return typeof response === 'function' ? await response(args) : response;
  });
}

/**
 * Mirror a real client's method tree, with a mock in place of each method.
 * @param {Record<string, any>} methods
 * @param {string} prefix
 * @param {string[]} log
 * @returns {Record<string, any>}
 */
function mirror(methods, prefix, log) {
  /** @type {Record<string, any>} */
  const fake = {};
  for (const [key, value] of Object.entries(methods)) {
    const name = `${prefix}${key}`;
    if (typeof value === 'function') {
      fake[key] = mock.fn();
      methodNames.set(fake[key], { log, name });
      answer(fake[key], { ok: true });
    } else if (value && Object.getPrototypeOf(value) === Object.prototype) {
      fake[key] = mirror(value, `${name}.`, log);
    }
  }
  return fake;
}

/**
 * A Slack client whose methods match the real one's, so a call to a method that doesn't exist fails.
 * @returns {any}
 */
export function fakeClient() {
  /** @type {string[]} */
  const log = [];
  const client = mirror(/** @type {any} */ (new WebClient()), '', log);
  clientLogs.set(client, log);
  answer(client.chat.postMessage, { ok: true, ts: '8.8' });
  return client;
}

/**
 * The Web API methods a fake client called, in order.
 * @param {any} client
 * @returns {string[]}
 */
export function methodCalls(client) {
  return clientLogs.get(client) ?? [];
}

/**
 * The arguments of a mock's last call.
 * @param {any} method
 * @returns {any}
 */
export function lastArgs(method) {
  return method.mock.calls.at(-1)?.arguments[0];
}

/**
 * The arguments of every call to a mock.
 * @param {any} method
 * @returns {any[]}
 */
export function allArgs(method) {
  return method.mock.calls.map((/** @type {any} */ c) => c.arguments[0]);
}

/** A Bolt context for a message from U123. */
export function fakeContext() {
  return { botUserId: 'UBOT', userId: 'U123' };
}

/**
 * The error the Slack client throws when a method returns `ok: false`.
 * @param {string} error
 * @param {Record<string, any>} [extra]
 */
export function slackError(error, extra = {}) {
  return new WebAPIPlatformError({ ok: false, error, ...extra });
}

/**
 * A `conversations.info` response for a code channel started from a message.
 * @param {string} [originChannelId]
 * @param {string} [originTs]
 */
export function codeChannelInfo(originChannelId = 'C_ORIGIN', originTs = '1.1') {
  return {
    ok: true,
    channel: {
      properties: {
        record_channel: { record_type: 'agent_channel' },
        agent_session: { origin_link: { channel_id: originChannelId, ts: originTs } },
      },
    },
  };
}

/** Forget every session, approval, and known channel, so each test starts fresh. */
export function forgetSessions() {
  for (const channelId of [...sessionStore.sessions.keys()]) {
    sessionStore.discard(channelId);
  }
  pendingStore.pending.clear();
  otherChannels.clear();
}
