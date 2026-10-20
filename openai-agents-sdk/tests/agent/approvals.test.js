import assert from 'node:assert';
import { describe, it } from 'node:test';

import { commandNeedsApproval } from '../../agent/approvals.js';

/**
 * @param {string[]} commands
 * @param {boolean} expected
 */
function assertEach(commands, expected) {
  for (const command of commands) {
    assert.strictEqual(commandNeedsApproval(command), expected, command);
  }
}

describe('commandNeedsApproval', () => {
  it('read-only commands run freely', () => {
    assertEach(['ls -la', 'cat README.md', 'grep -r foo .', 'rg -n foo', 'wc -l x'], false);
  });

  it('git read subcommands run freely', () => {
    assertEach(['git status', 'git diff HEAD~1'], false);
  });

  it('local git changes run freely', () => {
    assertEach(['git switch -c agent/fix', 'git add -A', "git commit -m 'Fix the login test'", 'git branch'], false);
  });

  it('git that publishes or discards work needs approval', () => {
    assertEach(
      [
        'git push origin main',
        'git reset --hard',
        'git checkout -- app.py',
        'git switch --discard-changes main',
        'git switch -f main',
        'git branch -D agent/old',
        'git branch -M main',
        'git clean -fd',
      ],
      true,
    );
  });

  it('git options before the subcommand need approval', () => {
    assertEach(["git -c alias.x='!id' x", 'git -C /tmp status'], true);
  });

  it('running repo code needs approval', () => {
    assertEach(['pytest -q', "python -c 'print(1)'", 'npm test', 'make', 'pip install .'], true);
  });

  it('shell syntax is only text to the program', () => {
    // Commands run without a shell, so these are `ls` and `cat` with some
    // odd arguments, never a second command. run_command's tests show it.
    assertEach(['ls && rm -rf build', 'cat x | sh', 'ls $(rm -rf build)'], false);
    // A path outside the clone still asks, wherever it appears.
    assertEach(['cat README.md > /tmp/out'], true);
  });

  it('options that run or write need approval', () => {
    assertEach(
      [
        'find . -exec rm {} +',
        'find . -execdir rm {} +',
        'find . -delete',
        'rg --pre=./run foo',
        'tree -o out.txt',
        'git diff --output=/tmp/x',
      ],
      true,
    );
  });

  it('reading outside the clone needs approval', () => {
    assertEach(
      [
        'cat /etc/passwd',
        'cat ../../.env',
        "find / -name '*.pem'",
        'grep -f/etc/passwd x',
        'rg --file=/etc/passwd x',
        'cat C:\\Windows\\win.ini',
        'cat C:/Users/me/.ssh/id_rsa',
        'cat \\\\server\\share\\secret',
        'cat ..\\\\..\\\\.env',
      ],
      true,
    );
  });

  it('reading inside the clone runs freely', () => {
    assertEach(['cat src/app.py', 'git diff HEAD~1', 'ls ./tests', 'grep -rn foo src'], false);
  });

  it('non read-only commands need approval', () => {
    assertEach(['rm -rf build', 'curl http://example.com', 'chmod +x x'], true);
  });

  it('empty or unparseable needs approval', () => {
    assertEach(['', 'echo "unbalanced'], true);
  });
});
