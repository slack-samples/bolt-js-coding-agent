/**
 * Real agent runs with a scripted model, covering the seams where the turn code meets the SDK.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { agent, MAX_TURNS, requestAgent, resumeRun, runRequest, startRun } from '../../agent/agent.js';
import { AgentDeps, CodeChannelSession, RequestDeps } from '../../agent/sessions.js';
import { call, FakeModel, say } from '../fake-model.js';
import { answer, fakeClient } from '../helpers.js';

/**
 * Have `target`'s runs call a scripted model for this test.
 * @param {import('node:test').TestContext} t
 * @param {import('@anthropic-ai/claude-agent-sdk').Options} target
 * @param {(callNumber: number) => any} script
 */
async function scripted(t, target, script) {
  const model = new FakeModel(script);
  await model.start();
  const original = target.env;
  target.env = model.env;
  t.after(async () => {
    target.env = original;
    await model.close();
  });
  return model;
}

/**
 * The tool results in a model call's messages.
 * @param {any[]} messages
 * @returns {any[]}
 */
function toolResults(messages) {
  return messages
    .filter((message) => Array.isArray(message.content))
    .flatMap((message) => message.content)
    .filter((block) => block.type === 'tool_result');
}

describe('runs', () => {
  /** @type {any} */
  let client;
  /** @type {string} */
  let tmp;

  beforeEach(() => {
    client = fakeClient();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('a command needing approval pauses and runs once approved', async (t) => {
    const session = new CodeChannelSession({ channelId: 'C_CODE', workdir: tmp });
    const deps = new AgentDeps({ client, session });
    await scripted(t, agent, (n) => (n === 1 ? call('run_command', { command: 'touch made' }) : say('Made it.')));

    const outcome = await startRun([], '<@U123>: make a file', deps);
    assert.ok(outcome.needsApproval);
    assert.strictEqual(outcome.command, 'touch made');
    assert.ok(!fs.existsSync(path.join(tmp, 'made')));

    const resumed = await resumeRun(outcome.paused, true, deps);

    assert.strictEqual(resumed.finalOutput, 'Made it.');
    assert.ok(fs.existsSync(path.join(tmp, 'made')));
  });

  it('a denied command never runs', async (t) => {
    const session = new CodeChannelSession({ channelId: 'C_CODE', workdir: tmp });
    const deps = new AgentDeps({ client, session });
    const model = await scripted(t, agent, (n) =>
      n === 1 ? call('run_command', { command: 'touch made' }) : say('Okay.'),
    );

    const outcome = await startRun([], '<@U123>: make a file', deps);
    const resumed = await resumeRun(outcome.paused, false, deps);

    assert.strictEqual(resumed.finalOutput, 'Okay.');
    assert.ok(!fs.existsSync(path.join(tmp, 'made')));
    assert.ok(JSON.stringify(toolResults(model.inputs.at(-1) ?? []).at(-1).content).includes('denied'));
  });

  it('a dropped approval leaves a history the next turn takes', async (t) => {
    const session = new CodeChannelSession({ channelId: 'C_CODE', workdir: tmp });
    const deps = new AgentDeps({ client, session });
    const model = await scripted(t, agent, (n) =>
      n === 1 ? call('run_command', { command: 'touch made' }) : say('Never mind, then.'),
    );

    const paused = await startRun([], '<@U123>: make a file', deps);
    // A newer message replaced the paused run instead of resuming it.
    const next = await startRun(paused.history, '<@U123>: never mind', deps);

    assert.strictEqual(next.finalOutput, 'Never mind, then.');
    assert.ok(!fs.existsSync(path.join(tmp, 'made')));
    // Closing out the old turn didn't call the model.
    assert.strictEqual(model.inputs.length, 2);
    assert.ok(JSON.stringify(toolResults(model.inputs.at(-1) ?? []).at(-1).content).includes('Not run'));
  });

  it('a stopped session skips tool calls', async (t) => {
    const session = new CodeChannelSession({ channelId: 'C_CODE', stopped: true });
    const deps = new AgentDeps({ client, session });
    const item = { key: 'repo', label: 'repo' };
    await scripted(t, agent, (n) => (n === 1 ? call('set_context_bar', { items: [item] }) : say('Stopped.')));

    const outcome = await startRun([], '<@U123>: go', deps);

    assert.strictEqual(outcome.finalOutput, 'Stopped.');
    assert.strictEqual(client.agents.conversations.setProperties.mock.callCount(), 0);
  });

  it('running out of turns ends with a message', async (t) => {
    const session = new CodeChannelSession({ channelId: 'C_CODE', workdir: tmp });
    const deps = new AgentDeps({ client, session });
    const model = await scripted(t, agent, (n) => (n <= 3 ? call('read_plan', {}) : say('Picked it up.')));
    // Each model call runs through the CLI, so allow fewer than MAX_TURNS to keep the test quick.
    agent.maxTurns = 3;
    t.after(() => {
      agent.maxTurns = MAX_TURNS;
    });

    const outcome = await startRun([], '<@U123>: go', deps);

    assert.strictEqual(model.inputs.length, 3);
    assert.ok(outcome.finalOutput?.includes('steps'));
    // The turn's work stays in the session for the next turn.
    const next = await startRun(outcome.history, '<@U123>: keep going', deps);
    assert.strictEqual(next.finalOutput, 'Picked it up.');
    assert.strictEqual(toolResults(model.inputs.at(-1) ?? []).length, 3);
  });

  it('archiving ends the turn', async (t) => {
    answer(client.chat.postMessage, { ok: true, ts: '9.9' });
    const session = new CodeChannelSession({ channelId: 'C_CODE' });
    const deps = new AgentDeps({ client, session });
    const model = await scripted(t, agent, (n) =>
      n === 1 ? call('archive_channel', { summary: 'Done.' }) : say('Extra.'),
    );

    await startRun([], "<@U123>: we're done", deps);

    assert.ok(session.archived);
    assert.strictEqual(model.inputs.length, 1);
  });

  it('creating a channel ends the request', async (t) => {
    answer(client.agents.conversations.create, { ok: true, channel_id: 'C_NEW' });
    const deps = new RequestDeps({ client, channelId: 'C_ORIGIN', messageTs: '1.1', threadTs: '1.1' });
    const model = await scripted(t, requestAgent, (n) =>
      n === 1 ? call('create_code_channel', { title: 'Fix it' }) : say('Extra.'),
    );

    await runRequest('<@U123>: fix the login test', deps);

    assert.strictEqual(deps.codeChannelId, 'C_NEW');
    assert.strictEqual(model.inputs.length, 1);
  });

  it('file tools work without approval', async (t) => {
    const session = new CodeChannelSession({ channelId: 'C_CODE', workdir: tmp });
    const deps = new AgentDeps({ client, session });
    const steps = [
      call('write_file', { path: 'src/hello.py', content: "print('hi')\n" }),
      call('edit_file', { path: 'src/hello.py', old_text: 'hi', new_text: 'hello' }),
      say('Wrote it.'),
    ];
    await scripted(t, agent, (n) => steps[n - 1]);

    const outcome = await startRun([], '<@U123>: write hello', deps);

    assert.strictEqual(outcome.finalOutput, 'Wrote it.');
    assert.strictEqual(fs.readFileSync(path.join(tmp, 'src', 'hello.py'), 'utf-8'), "print('hello')\n");
  });
});
