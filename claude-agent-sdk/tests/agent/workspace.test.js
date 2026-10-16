import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { clip, resolvePath, run, splitCommand } from '../../agent/workspace.js';

describe('workspace', () => {
  /** @type {string} */
  let tmp;
  /** @type {NodeJS.ProcessEnv} */
  let env;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-test-'));
    env = { ...process.env };
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = env;
  });

  it('run drops secrets and keeps the rest', async () => {
    process.env.OPENAI_API_KEY = 'x';
    process.env.SLACK_APP_TOKEN = 'x';
    process.env.AWS_SECRET_ACCESS_KEY = 'x';
    process.env.DB_PASSWORD = 'x';
    process.env.JAVA_HOME = '/opt/java';

    const result = await run([process.execPath, '-e', 'console.log(JSON.stringify(process.env))'], { cwd: tmp });

    const childEnv = JSON.parse(result.stdout);
    for (const name of ['OPENAI_API_KEY', 'SLACK_APP_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'DB_PASSWORD']) {
      assert.ok(!(name in childEnv), name);
    }
    assert.strictEqual(childEnv.JAVA_HOME, '/opt/java');
    assert.strictEqual(childEnv.GIT_TERMINAL_PROMPT, '0');
  });

  it('resolvePath keeps paths inside the workdir', () => {
    assert.strictEqual(resolvePath(tmp, 'src/app.py'), path.join(fs.realpathSync(tmp), 'src/app.py'));
    assert.strictEqual(resolvePath(tmp, '../outside'), null);
    assert.strictEqual(resolvePath(tmp, '/etc/passwd'), null);
  });

  it('resolvePath refuses writes into git', () => {
    fs.mkdirSync(path.join(tmp, '.git'));
    assert.notStrictEqual(resolvePath(tmp, '.git/config'), null);
    for (const filePath of ['.git/config', 'src/.git/x', '.GIT/config', '.Git/hooks/x', '.git./x']) {
      assert.strictEqual(resolvePath(tmp, filePath, { writing: true }), null, filePath);
    }
    assert.notStrictEqual(resolvePath(tmp, 'src/git/x', { writing: true }), null);
  });

  it('clip keeps short text and the end of long text', () => {
    assert.strictEqual(clip('short', 100), 'short');
    const clipped = clip(`${'a'.repeat(1000)}END`, 100);
    assert.ok(clipped.startsWith('a'.repeat(25)));
    assert.ok(clipped.endsWith('END'));
    assert.ok(clipped.includes('characters cut'));
  });

  it('splitCommand splits like a POSIX shell without running one', () => {
    assert.deepStrictEqual(splitCommand('ls -la  src'), ['ls', '-la', 'src']);
    assert.deepStrictEqual(splitCommand("git commit -m 'Fix the login test'"), [
      'git',
      'commit',
      '-m',
      'Fix the login test',
    ]);
    assert.deepStrictEqual(splitCommand('echo "a \\"b\\" \\c" d'), ['echo', 'a "b" \\c', 'd']);
    assert.deepStrictEqual(splitCommand('a"b c"d \'\' e'), ['ab cd', '', 'e']);
    assert.deepStrictEqual(splitCommand('cat C:\\Windows\\win.ini'), ['cat', 'C:Windowswin.ini']);
    assert.deepStrictEqual(splitCommand('ls && rm $(x) | sh'), ['ls', '&&', 'rm', '$(x)', '|', 'sh']);
    assert.deepStrictEqual(splitCommand(''), []);
    assert.throws(() => splitCommand('echo "unbalanced'), /No closing quotation/);
    assert.throws(() => splitCommand('echo trailing\\'), /No escaped character/);
  });
});
