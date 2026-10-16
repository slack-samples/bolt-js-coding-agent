/**
 * Code channel sessions: their state, the deps each agent run gets, and the store.
 *
 * A code channel is one session, so state is keyed by the code channel's own
 * channel ID. Each entry tracks the temp working directory the agent cloned into,
 * the plan canvas attached to the channel, and the conversation history, so
 * follow-up turns in the channel resume the same context. A session is discarded
 * when its channel is archived.
 *
 * The deps passed to each agent run live here too: `AgentDeps` for a turn in a
 * code channel, and `RequestDeps` for a request outside one.
 */

import fs from 'node:fs';

/** One turn at a time per channel: each `run` waits for the ones before it to finish. */
export class TurnLock {
  /** @type {Promise<void>} */
  #last = Promise.resolve();
  #holders = 0;

  /** Whether a turn holds the lock or is waiting for it. */
  get locked() {
    return this.#holders > 0;
  }

  /**
   * Run `fn` once the turns before it finish.
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async run(fn) {
    this.#holders += 1;
    const previous = this.#last;
    /** @type {() => void} */
    let release = () => {};
    this.#last = new Promise((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      return await fn();
    } finally {
      this.#holders -= 1;
      release();
    }
  }
}

/** Per-code-channel working state. */
export class CodeChannelSession {
  /**
   * @param {Object} fields
   * @param {string} fields.channelId
   * @param {string | null} [fields.originChannelId]
   * @param {string | null} [fields.originMessageTs]
   * @param {string | null} [fields.originContext]
   * @param {string | null} [fields.workdir]
   * @param {string[]} [fields.inbox]
   * @param {boolean} [fields.stopped]
   */
  constructor({
    channelId,
    originChannelId = null,
    originMessageTs = null,
    originContext = null,
    workdir = null,
    inbox = [],
    stopped = false,
  }) {
    this.channelId = channelId;
    this.originChannelId = originChannelId;
    this.originMessageTs = originMessageTs;
    // The conversation the channel was started from, given to the first turn.
    this.originContext = originContext;
    this.workdir = workdir;
    /** @type {string | null} */
    this.repoUrl = null;
    /** @type {string | null} */
    this.baseBranch = null;
    // The commit that was cloned, which the published diff compares against.
    /** @type {string | null} */
    this.baseCommit = null;
    /** @type {string | null} */
    this.planCanvasId = null;
    /** @type {any[]} */
    this.history = [];
    // Messages waiting for the next turn, each starting with who sent it.
    this.inbox = inbox;
    // Set by the native stop button, or when the session is discarded. Checked
    // before posting and before every tool call so a stopped session goes quiet;
    // cleared when the user starts a new turn.
    this.stopped = stopped;
    // Set once the channel is archived, by the agent or from Slack; nothing more
    // is posted after that.
    this.archived = false;
    // One turn at a time per channel, so turns don't race on history.
    this.turnLock = new TurnLock();
  }
}

/**
 * Dependencies passed to the agent and its tools for one turn.
 *
 * In a code channel the agent works inside `session.workdir` (a temp clone)
 * and drives the channel chrome through `client` (the code channel Web API
 * methods).
 */
export class AgentDeps {
  /**
   * @param {Object} fields
   * @param {import('@slack/web-api').WebClient} fields.client
   * @param {CodeChannelSession} fields.session
   */
  constructor({ client, session }) {
    this.client = client;
    this.session = session;
  }

  get channelId() {
    return this.session.channelId;
  }
}

/**
 * Dependencies passed to the agent answering a request outside a code channel.
 *
 * The agent either replies in place or calls `create_code_channel`, which sets
 * `codeChannelId` so `answerRequest` knows the work moved there.
 */
export class RequestDeps {
  /**
   * @param {Object} fields
   * @param {import('@slack/web-api').WebClient} fields.client
   * @param {string} fields.channelId
   * @param {string} fields.messageTs
   * @param {string | null} fields.threadTs - The thread to reply in, or null to reply top-level, as in a direct message.
   */
  constructor({ client, channelId, messageTs, threadTs }) {
    this.client = client;
    this.channelId = channelId;
    this.messageTs = messageTs;
    this.threadTs = threadTs;
    /** @type {string | null} */
    this.codeChannelId = null;
  }
}

/** In-memory store of active code channel sessions. */
export class CodeChannelSessionStore {
  constructor() {
    /** @type {Map<string, CodeChannelSession>} */
    this.sessions = new Map();
  }

  /**
   * @param {string} channelId
   * @returns {CodeChannelSession | null}
   */
  get(channelId) {
    return this.sessions.get(channelId) ?? null;
  }

  /** @param {CodeChannelSession} session */
  put(session) {
    this.sessions.set(session.channelId, session);
  }

  /**
   * Remove a session and clean up its working directory.
   *
   * The session is also marked archived and stopped, so a turn still running
   * in it calls no more tools and doesn't put it back when it finishes.
   *
   * @param {string} channelId
   */
  discard(channelId) {
    const session = this.sessions.get(channelId);
    if (!session) return;
    this.sessions.delete(channelId);
    session.archived = true;
    session.stopped = true;
    if (session.workdir) {
      fs.rmSync(session.workdir, { recursive: true, force: true });
    }
  }
}

export const sessionStore = new CodeChannelSessionStore();
