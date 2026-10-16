import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { RunContext, setTracingDisabled } from '@openai/agents';

import { sessionStopped } from '../../agent/guardrails.js';
import { AgentDeps, CodeChannelSession, RequestDeps } from '../../agent/sessions.js';
import {
  archiveChannel,
  cloneRepo,
  createCodeChannel,
  editFile,
  listViews,
  publishDiff,
  publishHtmlView,
  readFile,
  readPlan,
  removeView,
  renameSession,
  runCommand,
  setCommands,
  setContextBar,
  writeFile,
  writePlan,
} from '../../agent/tools/index.js';
import { allArgs, answer, fakeClient, lastArgs, methodCalls, slackError } from '../helpers.js';
import { invoke } from '../invoke.js';

// Tests never reach OpenAI, so there are no traces to send.
setTracingDisabled(true);

/**
 * @param {string} workdir
 * @param {...string} args
 */
function git(workdir, ...args) {
  return execFileSync('git', ['-C', workdir, ...args], { encoding: 'utf-8' }).trim();
}

/**
 * Have git fetch `url` from the local repository at `origin`, since a local path isn't cloneable.
 * @param {string} origin
 * @param {string} url
 */
function serve(origin, url) {
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = `url.${origin}.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = url;
}

describe('tools', () => {
  /** @type {any} */
  let client;
  /** @type {CodeChannelSession} */
  let session;
  /** @type {AgentDeps} */
  let deps;
  /** @type {string} */
  let tmp;
  /** @type {NodeJS.ProcessEnv} */
  let env;

  beforeEach(() => {
    client = fakeClient();
    session = new CodeChannelSession({ channelId: 'C123' });
    deps = new AgentDeps({ client, session });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-test-'));
    env = { ...process.env };
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = env;
  });

  it('set_context_bar drops unset fields', async () => {
    await invoke(setContextBar, deps, {
      items: [
        { key: 'repo', label: 'borant/billing', icon: 'folder', url: 'https://github.com/borant/billing' },
        { key: 'ci', label: 'Tests pending', icon: 'terminal', url: null },
      ],
    });

    const args = lastArgs(client.agents.conversations.setProperties);
    assert.strictEqual(args.channel_id, 'C123');
    assert.deepStrictEqual(args.code_channel.context_bar_items[1], {
      key: 'ci',
      label: 'Tests pending',
      icon: 'terminal',
    });
  });

  it('write_plan returns why Slack rejected the markdown', async () => {
    answer(
      client.canvases.create,
      slackError('canvas_creation_failed', {
        detail: 'line 11: Unsupported list type (bullet) within numbered list',
      }),
    );

    const result = await invoke(writePlan, deps, { markdown: '# Plan\n\n1. Step\n   - Sub' });

    assert.ok(result.includes('Unsupported list type (bullet) within numbered list'));
    assert.ok(result.includes('call write_plan again'));
    assert.strictEqual(session.planCanvasId, null);
  });

  it('write_plan creates and attaches the canvas once', async () => {
    answer(client.canvases.create, { ok: true, canvas_id: 'F123' });

    await invoke(writePlan, deps, { markdown: '# Plan\n\n1. Read the code' });

    const view = lastArgs(client.agents.conversations.setView);
    assert.strictEqual(view.type, 'canvas');
    assert.strictEqual(view.canvas_id, 'F123');
    assert.strictEqual(view.access_level, 'comment');
    assert.strictEqual(session.planCanvasId, 'F123');

    answer(client.agents.conversations.setCanvasContent, { ok: true, sections_changed_count: 1 });
    const result = await invoke(writePlan, deps, { markdown: '# Plan\n\n1. Read the code\n2. Fix it' });

    assert.strictEqual(client.canvases.create.mock.callCount(), 1);
    assert.deepStrictEqual(lastArgs(client.agents.conversations.setCanvasContent), {
      channel: 'C123',
      canvas_id: 'F123',
      content: '# Plan\n\n1. Read the code\n2. Fix it',
    });
    assert.ok(result.includes('1 sections changed'));
  });

  it('read_plan includes open comments', async () => {
    session.planCanvasId = 'F123';
    answer(client.agents.conversations.getCanvas, {
      ok: true,
      content: '# Plan',
      comments: [
        { user_id: 'U2', text: 'Billing last?', quoted_text: '1. Inventory', replies: [{ user_id: 'U3', text: '+1' }] },
      ],
    });

    const result = await invoke(readPlan, deps);

    assert.strictEqual(lastArgs(client.agents.conversations.getCanvas).include_resolved, false);
    assert.ok(result.includes('Billing last?'));
    assert.ok(result.includes('+1'));
  });

  it('read_plan without a plan skips the API', async () => {
    assert.ok((await invoke(readPlan, deps)).includes('No plan yet'));
    assert.strictEqual(client.agents.conversations.getCanvas.mock.callCount(), 0);
  });

  it('publish_html_view', async () => {
    answer(client.agents.conversations.setView, { ok: true, view_id: 'Ct1' });

    await invoke(publishHtmlView, deps, { view_key: 'reports/tests.html', name: 'Tests', html: '<html></html>' });

    const args = lastArgs(client.agents.conversations.setView);
    assert.strictEqual(args.type, 'html');
    assert.strictEqual(args.view_key, 'reports/tests.html');
  });

  it('list_views', async () => {
    answer(client.agents.conversations.listViews, {
      ok: true,
      views: [{ view_id: 'T1', view_key: 'plan', label: 'Plan', content_version: 1 }],
    });

    const result = await invoke(listViews, deps);

    assert.ok(result.includes('1 of 5'));
    assert.ok(result.includes('view_id=T1'));
  });

  it('remove_view', async () => {
    await invoke(removeView, deps, { view_id: 'T1' });

    assert.deepStrictEqual(allArgs(client.agents.conversations.removeView), [{ channel_id: 'C123', view_id: 'T1' }]);
  });

  it('set_commands', async () => {
    answer(client.agents.conversations.setCommands, { ok: true, command_count: 1 });

    await invoke(setCommands, deps, {
      commands: [{ name: 'run-tests', description: 'Run the tests', argument_hint: null }],
    });

    assert.deepStrictEqual(lastArgs(client.agents.conversations.setCommands).commands, [
      { name: 'run-tests', description: 'Run the tests' },
    ]);
  });

  it('rename_session', async () => {
    await invoke(renameSession, deps, { title: 'Fix flaky login test' });

    assert.deepStrictEqual(allArgs(client.agents.sessions.rename), [
      { channel_id: 'C123', title: 'Fix flaky login test' },
    ]);
  });

  it('archive_channel shares the summary', async () => {
    answer(client.chat.postMessage, { ok: true, ts: '111.222' });

    await invoke(archiveChannel, deps, { summary: 'Fixed it.' });

    assert.deepStrictEqual(allArgs(client.agents.conversations.archive), [
      { channel_id: 'C123', summary_message_ts: '111.222' },
    ]);
    assert.strictEqual(session.archived, true);
  });

  it('archive_channel closes the session before archiving', async () => {
    answer(client.chat.postMessage, { ok: true, ts: '111.222' });

    await invoke(archiveChannel, deps, { summary: 'Fixed it.' });

    assert.deepStrictEqual(methodCalls(client), [
      'chat.postMessage',
      'agents.sessions.setStatus',
      'agents.conversations.archive',
    ]);
    assert.deepStrictEqual(allArgs(client.agents.sessions.setStatus), [{ channel_id: 'C123', status: 'closed' }]);
  });

  it('archive_channel without an origin link still archives', async () => {
    answer(client.chat.postMessage, { ok: true, ts: '111.222' });
    let calls = 0;
    answer(client.agents.conversations.archive, () => {
      calls += 1;
      if (calls === 1) throw slackError('no_origin_link');
      return { ok: true };
    });

    await invoke(archiveChannel, deps, { summary: 'Fixed it.' });

    assert.deepStrictEqual(lastArgs(client.agents.conversations.archive), { channel_id: 'C123' });
    assert.strictEqual(session.archived, true);
  });

  it('create_code_channel failure leaves the request in place', async () => {
    answer(client.agents.conversations.create, slackError('missing_scope'));
    const request = new RequestDeps({ client, channelId: 'C_ORIGIN', messageTs: '1.1', threadTs: '1.1' });

    assert.ok((await invoke(createCodeChannel, request, { title: 'x' })).includes('missing_scope'));
    assert.strictEqual(request.codeChannelId, null);
    assert.strictEqual(client.chat.postMessage.mock.callCount(), 0);
  });

  it('API errors are returned to the model', async () => {
    answer(client.agents.sessions.rename, slackError('not_authorized'));

    assert.ok((await invoke(renameSession, deps, { title: 'x' })).includes('not_authorized'));
  });

  it('a tool that throws tells the model why', async () => {
    answer(client.agents.sessions.rename, new Error('socket hang up'));

    const result = await invoke(renameSession, deps, { title: 'x' });

    assert.ok(result.includes('An error occurred while running the tool'));
    assert.ok(result.includes('socket hang up'));
  });

  it('a stopped session skips tool calls', async () => {
    const data = /** @type {any} */ ({
      context: new RunContext(deps),
      agent: {},
      toolCall: { type: 'function_call', name: 'set_context_bar', callId: 'call_1', arguments: '{}' },
    });

    assert.strictEqual((await sessionStopped.run(data)).behavior.type, 'allow');
    session.stopped = true;
    const rejected = /** @type {any} */ ((await sessionStopped.run(data)).behavior);
    assert.strictEqual(rejected.type, 'rejectContent');
    assert.ok(rejected.message.includes('stopped'));
  });

  it('clone_repo refuses local paths and options', async () => {
    for (const url of ['/etc', 'file:///etc', '--upload-pack=touch x', 'ext::sh']) {
      assert.ok((await invoke(cloneRepo, deps, { repo_url: url })).includes("Can't clone"), url);
    }
    assert.strictEqual(session.workdir, null);
  });

  it('clone_repo checks out symlinks as plain files', async () => {
    const origin = path.join(tmp, 'origin');
    fs.mkdirSync(origin);
    git(origin, 'init', '-q', '-b', 'main');
    fs.symlinkSync('/etc/passwd', path.join(origin, 'link'));
    git(origin, 'add', '.');
    git(origin, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    serve(origin, 'https://example.com/repo.git');

    const result = await invoke(cloneRepo, deps, { repo_url: 'https://example.com/repo.git' });

    assert.ok(result.startsWith('Cloned'), result);
    const link = path.join(/** @type {string} */ (session.workdir), 'link');
    assert.ok(fs.lstatSync(link).isFile());
    assert.strictEqual(fs.readFileSync(link, 'utf-8'), '/etc/passwd');
    fs.rmSync(/** @type {string} */ (session.workdir), { recursive: true, force: true });
  });

  it('cloning again replaces the earlier clone', async () => {
    const origin = path.join(tmp, 'origin');
    fs.mkdirSync(origin);
    git(origin, 'init', '-q', '-b', 'main');
    git(origin, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
    serve(origin, 'https://example.com/repo.git');
    const earlier = path.join(tmp, 'earlier');
    fs.mkdirSync(earlier);
    session.workdir = earlier;

    const result = await invoke(cloneRepo, deps, { repo_url: 'https://example.com/repo.git' });

    assert.ok(result.startsWith('Cloned'), result);
    assert.ok(!fs.existsSync(earlier));
    assert.notStrictEqual(session.workdir, earlier);
    assert.strictEqual(session.baseBranch, 'main');
    fs.rmSync(/** @type {string} */ (session.workdir), { recursive: true, force: true });
  });

  it('publish_diff includes commits on the default branch and new files', async () => {
    git(tmp, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(tmp, 'README.md'), 'hello\n');
    git(tmp, 'add', '.');
    git(tmp, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    session.workdir = tmp;
    session.baseBranch = 'main';
    session.baseCommit = git(tmp, 'rev-parse', 'HEAD');
    // A commit straight onto main, plus a file git doesn't track yet.
    fs.writeFileSync(path.join(tmp, 'README.md'), 'hello world\n');
    git(tmp, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'edit');
    fs.writeFileSync(path.join(tmp, 'NEW.md'), 'new\n');

    await invoke(publishDiff, deps);

    const content = lastArgs(client.agents.conversations.setView).content;
    assert.ok(content.includes('+hello world'));
    assert.ok(content.includes('+++ b/NEW.md'));
    assert.ok(content.includes('+new'));
  });

  it('read_file reads a range of lines', async () => {
    fs.writeFileSync(path.join(tmp, 'notes.txt'), 'one\ntwo\nthree\n');
    session.workdir = tmp;

    const result = await invoke(readFile, deps, { path: 'notes.txt', start_line: 2, end_line: 3 });

    assert.strictEqual(result, 'notes.txt (lines 2–3 of 3):\ntwo\nthree');
  });

  it('file tools stay inside the clone', async () => {
    const clone = path.join(tmp, 'clone');
    fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'secret.txt'), 'secret');
    session.workdir = clone;

    const read = await invoke(readFile, deps, { path: '../secret.txt', start_line: null, end_line: null });
    const wrote = await invoke(writeFile, deps, { path: '/tmp/x', content: 'x' });
    const hooked = await invoke(writeFile, deps, { path: '.git/hooks/pre-commit', content: 'x' });

    assert.ok(read.includes('outside the repository'));
    assert.ok(wrote.includes('outside the repository'));
    assert.ok(hooked.includes('inside `.git`'));
    assert.ok(!fs.existsSync(path.join(clone, '.git', 'hooks')));
  });

  it('write_file creates parent directories', async () => {
    session.workdir = tmp;

    await invoke(writeFile, deps, { path: 'src/app/main.py', content: 'x = 1\n' });

    assert.strictEqual(fs.readFileSync(path.join(tmp, 'src', 'app', 'main.py'), 'utf-8'), 'x = 1\n');
  });

  it('edit_file replaces text that appears once', async () => {
    fs.writeFileSync(path.join(tmp, 'app.py'), 'a = 1\nb = 1\n');
    session.workdir = tmp;

    const missing = await invoke(editFile, deps, { path: 'app.py', old_text: 'c = 1', new_text: 'c = 2' });
    const twice = await invoke(editFile, deps, { path: 'app.py', old_text: ' = 1', new_text: ' = 2' });
    const once = await invoke(editFile, deps, { path: 'app.py', old_text: 'b = 1', new_text: 'b = $&2' });

    assert.ok(missing.includes("Didn't find"));
    assert.ok(twice.includes('2 times'));
    assert.strictEqual(once, 'Edited app.py.');
    assert.strictEqual(fs.readFileSync(path.join(tmp, 'app.py'), 'utf-8'), 'a = 1\nb = $&2\n');
  });

  it('run_command keeps the end of long output', async () => {
    session.workdir = tmp;

    const result = await invoke(runCommand, deps, {
      command: `${process.execPath} -e "console.log('x'.repeat(10000)); console.log('3 failed, 9 passed')"`,
      directory: null,
    });

    assert.ok(result.includes('characters cut'));
    assert.ok(result.includes('3 failed, 9 passed'));
  });

  it('run_command hides the app secrets', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.GITHUB_TOKEN = 'ghp-test';
    session.workdir = tmp;

    const result = await invoke(runCommand, deps, { command: 'env', directory: null });

    assert.ok(result.includes('PATH='));
    for (const secret of ['sk-test', 'xoxb-test', 'ghp-test']) {
      assert.ok(!result.includes(secret), secret);
    }
  });

  it('run_command passes shell syntax to the program as text', async () => {
    session.workdir = tmp;

    const result = await invoke(runCommand, deps, { command: 'ls && touch made', directory: null });

    assert.ok(result.includes('exit='));
    assert.ok(!fs.existsSync(path.join(tmp, 'made')));
  });

  it('run_command runs in a directory inside the clone', async () => {
    fs.mkdirSync(path.join(tmp, 'packages', 'web'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'packages', 'web', 'package.json'), '{}');
    session.workdir = `${tmp}${path.sep}`;

    const inside = await invoke(runCommand, deps, { command: 'ls', directory: 'packages/web' });
    const outside = await invoke(runCommand, deps, { command: 'ls', directory: '..' });

    assert.ok(inside.includes('package.json'));
    assert.ok(outside.includes('not a directory in the repository'));
  });

  it('run_command explains a missing program', async () => {
    session.workdir = tmp;

    const result = await invoke(runCommand, deps, { command: 'no-such-program --help', directory: null });

    assert.strictEqual(result, "no-such-program isn't installed here.");
  });
});
