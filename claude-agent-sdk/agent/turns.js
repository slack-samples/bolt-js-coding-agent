/**
 * Turns in Slack: answer requests, run code channel turns, and handle approvals and stops.
 *
 * Listeners call these functions and never the agent framework directly. This file
 * doesn't import the framework either. It calls `runRequest`, `startRun`, and
 * `resumeRun` from `agent/agent.js`: `runRequest` returns the reply text, and the
 * other two return a `RunOutcome`. It passes `outcome.paused` back to
 * `resumeRun` without looking inside.
 */

import { WebAPIPlatformError } from '@slack/web-api';

import { resumeRun, runRequest, startRun } from './agent.js';
import { PendingApproval, pendingStore } from './approvals.js';
import { originContext, recentContext, threadContext } from './context.js';
import { AgentDeps, CodeChannelSession, RequestDeps, sessionStore } from './sessions.js';
import { clip } from './workspace.js';

/** @typedef {import('@slack/web-api').WebClient} WebClient */
/** @typedef {import('./outcome.js').RunOutcome} RunOutcome */

const EXPIRED = ':hourglass: This approval has expired — please ask me again.';

/**
 * The agent runs this file calls, held in one object so tests can stand in for them.
 */
export const runs = { resumeRun, runRequest, startRun };

/** Channels known not to be code channels, so a message there isn't looked up again. */
export const otherChannels = new Set();

/**
 * What went wrong, for a warning posted in Slack.
 * @param {unknown} error
 * @returns {string}
 */
function reason(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A command for a code block: short enough for a message, and unable to end the block early.
 * @param {string | null} command
 * @returns {string}
 */
function shown(command) {
  return clip((command ?? '').replaceAll('```', "'''"), 2500);
}

/**
 * Replace a message's blocks with `text`, so its buttons can't be clicked again.
 * @param {WebClient} client
 * @param {string} channelId
 * @param {string} ts
 * @param {string} text
 */
async function closeMessage(client, channelId, ts, text) {
  try {
    await client.chat.update({
      channel: channelId,
      ts,
      text,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
    });
  } catch (e) {
    console.error('Failed to update the approval message', e);
  }
}

/**
 * Report a turn that threw, and move the session out of `processing`.
 *
 * The session keeps the history from before this turn, so the next message
 * starts from the last turn that finished.
 *
 * @param {AgentDeps} deps
 * @param {unknown} error
 */
async function failTurn(deps, error) {
  const session = deps.session;
  if (session.archived) {
    sessionStore.discard(session.channelId);
    return;
  }
  try {
    // The stop handler already confirmed the stop, so only the status is left.
    if (!session.stopped) {
      await deps.client.chat.postMessage({
        channel: session.channelId,
        text: `:warning: Something went wrong (${reason(error)}). Send a message to try again.`,
      });
    }
    await deps.client.agents.sessions.setStatus({ channel_id: session.channelId, status: 'active' });
  } catch (e) {
    console.error('Failed to report the failed turn', e);
  }
}

/**
 * Post an agent run's outcome to the code channel. Returns whether it paused.
 *
 * If the run paused for approval, park it and post Approve/Deny buttons.
 * Otherwise post the final message top-level (the code channel convention)
 * and mark the session active again.
 *
 * @param {{ outcome: RunOutcome, deps: AgentDeps }} args
 * @returns {Promise<boolean>}
 */
export async function deliverOutcome({ outcome, deps }) {
  const client = deps.client;
  const session = deps.session;

  if (session.archived) {
    sessionStore.discard(session.channelId);
    return false;
  }
  // Persist conversation history so the next turn resumes with context.
  session.history = outcome.history;
  sessionStore.put(session);
  // After the stop button, post nothing. The stop handler already confirmed
  // the stop, but this turn may have set `processing` after it, so set
  // `active` again.
  if (session.stopped) {
    await client.agents.sessions.setStatus({ channel_id: session.channelId, status: 'active' });
    return false;
  }

  if (outcome.needsApproval) {
    // The agent can't continue until someone decides, so the session is suspended.
    await client.agents.sessions.setStatus({ channel_id: session.channelId, status: 'suspended' });
    // The button value carries only the decision. The channel and this
    // message's ts identify which paused run to resume.
    const posted = await client.chat.postMessage({
      channel: session.channelId,
      text: 'The agent needs approval to run a command.',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:lock: *The agent wants to run a command that needs your approval:*\n\`\`\`${shown(outcome.command)}\`\`\``,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Approve' },
              style: 'primary',
              action_id: 'approve_command',
              value: 'approve',
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Deny' },
              style: 'danger',
              action_id: 'deny_command',
              value: 'deny',
            },
          ],
        },
      ],
    });
    pendingStore.put(
      session.channelId,
      new PendingApproval({
        paused: outcome.paused,
        deps,
        command: outcome.command ?? '',
        messageTs: /** @type {string} */ (posted.ts),
      }),
    );
    return true;
  }

  const text = outcome.finalOutput || '(the agent finished without a message)';
  // The model writes standard markdown, not Slack mrkdwn.
  await client.chat.postMessage({ channel: session.channelId, markdown_text: text });
  await client.agents.sessions.setStatus({ channel_id: session.channelId, status: 'active' });
  return false;
}

/**
 * Run one agent turn and post its outcome. Returns whether it paused on an approval.
 * @param {AgentDeps} deps
 * @param {() => Promise<RunOutcome>} run
 * @returns {Promise<boolean>}
 */
async function runAndDeliver(deps, run) {
  try {
    await deps.client.agents.sessions.setStatus({ channel_id: deps.channelId, status: 'processing' });
    const outcome = await run();
    return await deliverOutcome({ outcome, deps });
  } catch (e) {
    console.error('Agent turn failed', e);
    await failTurn(deps, e);
    return false;
  }
}

/**
 * Run turns until the inbox is empty or a turn pauses on an approval.
 * @param {WebClient} client
 * @param {CodeChannelSession} session
 */
async function runInbox(client, session) {
  while (session.inbox.length > 0 && !session.archived) {
    // A stop clears the inbox, so anything here was sent after it and picks
    // the session back up.
    session.stopped = false;
    const messages = session.inbox;
    session.inbox = [];
    let text = messages.join('\n\n');
    if (session.originContext && session.history.length === 0) {
      text = `This code channel was started from this conversation:\n${session.originContext}\n\n${text}`;
      session.originContext = null;
    }

    const deps = new AgentDeps({ client, session });
    const history = session.history;
    const paused = await runAndDeliver(deps, () => runs.startRun(history, text, deps));
    if (paused) return;
  }
}

/**
 * Reply to a mention or direct message outside a code channel, or create one for it.
 *
 * A mention in a channel is answered in its thread. A direct message is answered
 * where it was sent. The agent gets the conversation before the request, from
 * the thread or from the direct message, so it can follow along.
 *
 * @param {Object} args
 * @param {WebClient} args.client
 * @param {string} args.channelId
 * @param {string} args.messageTs
 * @param {string | null} args.threadTs
 * @param {string} args.text
 * @param {string} args.userId
 * @param {boolean} args.inDm
 */
export async function answerRequest({ client, channelId, messageTs, threadTs, text, userId, inDm }) {
  const replyTs = threadTs || (inDm ? null : messageTs);
  if (!text) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: replyTs ?? undefined,
      text: 'Mention me with a question or a coding task and a repo.',
    });
    return;
  }

  try {
    let earlier = '';
    if (threadTs) {
      earlier = await threadContext(client, channelId, threadTs, { beforeTs: messageTs });
    } else if (inDm) {
      earlier = await recentContext(client, channelId, { beforeTs: messageTs });
    }
    let prompt = `<@${userId}>: ${text}`;
    if (earlier) {
      prompt = `Earlier in this conversation:\n${earlier}\n\n${prompt}`;
    }

    const deps = new RequestDeps({ client, channelId, messageTs, threadTs: replyTs });
    const reply = await runs.runRequest(prompt, deps);
    // When the agent created a code channel, the work continues there.
    if (deps.codeChannelId === null) {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: replyTs ?? undefined,
        markdown_text: reply || '(the agent finished without a message)',
      });
    }
  } catch (e) {
    console.error('Failed to answer the request', e);
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: replyTs ?? undefined,
      text: `:warning: Something went wrong (${reason(e)}).`,
    });
  }
}

/**
 * The session for a code channel, starting one if the app has no state for it yet.
 *
 * That's every new channel the agent creates, once its seeded request arrives,
 * plus channels started from Slack's own UI or forgotten after a restart.
 * `record_channel.record_type` is set on every code channel at creation, so
 * it's the reliable way to recognize one. A new session gets the conversation
 * the channel was started from, for its first turn.
 *
 * @param {WebClient} client
 * @param {string} channelId
 * @returns {Promise<CodeChannelSession | null>}
 */
export async function findSession(client, channelId) {
  const known = sessionStore.get(channelId);
  if (known !== null || otherChannels.has(channelId)) return known;
  let channel;
  try {
    channel = /** @type {any} */ ((await client.conversations.info({ channel: channelId })).channel);
  } catch (e) {
    if (!(e instanceof WebAPIPlatformError)) throw e;
    console.warn(`Couldn't look up ${channelId}: ${e.data.error}`);
    return null;
  }
  const properties = channel?.properties ?? {};
  if (properties.record_channel?.record_type !== 'agent_channel') {
    otherChannels.add(channelId);
    return null;
  }

  const origin = properties.agent_session?.origin_link ?? {};
  const session = new CodeChannelSession({
    channelId,
    originChannelId: origin.channel_id ?? null,
    originMessageTs: origin.ts ?? null,
  });
  if (session.originChannelId && session.originMessageTs) {
    session.originContext = (await originContext(client, session.originChannelId, session.originMessageTs)) || null;
  }
  // Another event may have started this session while the lookups ran.
  const existing = sessionStore.get(channelId);
  if (existing !== null) return existing;
  sessionStore.put(session);
  return session;
}

/**
 * Run a message or slash command in a code channel as a turn and post the outcome.
 *
 * Mentions, plain messages, and slash commands all funnel through here. A
 * message that arrives while a turn runs waits in the session's inbox, and
 * everything waiting runs together as the next turn.
 *
 * @param {{ client: WebClient, session: CodeChannelSession, text: string, userId: string }} args
 */
export async function runTurn({ client, session, text, userId }) {
  session.inbox.push(`<@${userId}>: ${text}`);
  if (session.turnLock.locked) {
    // The running turn takes this message when it finishes.
    return;
  }

  await session.turnLock.run(async () => {
    // A command still waiting on approval belongs to the old turn. Its history
    // already says it didn't run, so retire its buttons rather than let a late
    // click resume that older run over this one.
    const replaced = pendingStore.discard(session.channelId);
    if (replaced !== null) {
      await closeMessage(
        client,
        session.channelId,
        replaced.messageTs,
        `:fast_forward: *Skipped for a newer message:* \`\`\`${shown(replaced.command)}\`\`\``,
      );
    }
    await runInbox(client, session);
  });
}

/**
 * Resume the run paused on the approval message at `messageTs`, if it's current.
 *
 * The buttons are replaced with the decision, or a note that the approval
 * expired when the run was stopped or replaced by a newer message.
 *
 * @param {{ client: WebClient, channelId: string, messageTs: string, approved: boolean }} args
 */
export async function resumeTurn({ client, channelId, messageTs, approved }) {
  const session = sessionStore.get(channelId);
  if (session === null) {
    await closeMessage(client, channelId, messageTs, EXPIRED);
    return;
  }

  await session.turnLock.run(async () => {
    // Take the pending run inside the lock, so a newer turn that already
    // retired it wins and this click can't resume over it.
    const pending = pendingStore.pop(channelId, messageTs);
    if (pending === null) {
      await closeMessage(client, channelId, messageTs, EXPIRED);
      return;
    }
    const decision = approved ? ':white_check_mark: *Approved:*' : ':x: *Denied:*';
    await closeMessage(client, channelId, messageTs, `${decision} \`\`\`${shown(pending.command)}\`\`\``);

    const deps = pending.deps;
    const paused = await runAndDeliver(deps, () => runs.resumeRun(pending.paused, approved, deps));
    // Messages sent while the command ran come next.
    if (!paused) {
      await runInbox(client, session);
    }
  });
}

/**
 * Handle the native stop button.
 *
 * Slack doesn't change the session status on a stop, so stop the work, clean
 * up, confirm the stop, and move the session out of `processing` here.
 *
 * @param {{ client: WebClient, channelId: string }} args
 */
export async function stopTurn({ client, channelId }) {
  // Stop in-progress work: the running turn sees this flag, calls no more
  // tools, and posts nothing when it finishes. Messages waiting for the next
  // turn are dropped with it.
  const session = sessionStore.get(channelId);
  if (session !== null) {
    session.stopped = true;
    session.inbox.length = 0;
  }

  // Clean up a command waiting on approval so its buttons can't resume it.
  const pending = pendingStore.discard(channelId);
  if (pending !== null) {
    await closeMessage(
      client,
      channelId,
      pending.messageTs,
      `:octagonal_sign: *Stopped before running:* \`\`\`${shown(pending.command)}\`\`\``,
    );
  }

  await client.chat.postMessage({ channel: channelId, text: 'Stopped. Send a message to pick back up.' });
  await client.agents.sessions.setStatus({ channel_id: channelId, status: 'active' });
}

/**
 * Forget a code channel and delete its working directory.
 * @param {string} channelId
 */
export function endSession(channelId) {
  pendingStore.discard(channelId);
  sessionStore.discard(channelId);
}
