/**
 * ⚠️ SECURITY: `run_command` runs programs chosen by the language model on the
 * machine running this app. Read-only commands and local git changes run right
 * away, and anything else needs human approval in Slack first (see
 * `agent/approvals.js`) — only ever run this against trusted, throwaway
 * repositories in the session temp directory. See the README's Command approvals
 * section.
 */

import fs from 'node:fs';

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { CommandTimeoutError, clip, resolvePath, run, splitCommand } from '../workspace.js';
import { toolResult } from './tool-result.js';

// Cap any single command so a hung/looping command can't wedge the session.
const COMMAND_TIMEOUT_SECONDS = 120;

/** @param {import('../sessions.js').AgentDeps} deps */
export const runCommand = (deps) =>
  tool(
    'run_command',
    'Run one program in the cloned repository and return its output.\n' +
      '\n' +
      'Use it to search, build, test, and run git, like `pytest -q` or `git status`.\n' +
      'The program runs directly, without a shell, so pipes, `&&`, redirects, globs,\n' +
      "and variables don't work: run one program at a time, and use `directory`\n" +
      'instead of `cd`. Use `read_file`, `write_file`, and `edit_file` for files.\n' +
      'Read-only commands and local git changes like `git add`, `git commit`, and\n' +
      '`git switch -c` run immediately; anything else, including tests and builds,\n' +
      'asks the user to approve it in Slack before running.',
    {
      command: z.string().describe('The program and its arguments, such as `pytest -q tests/test_app.py`.'),
      directory: z
        .string()
        .optional()
        .describe(
          'A directory in the repository to run in, such as `packages/web`, or omit it for the repository root.',
        ),
    },
    async ({ command, directory }) => {
      const session = deps.session;
      if (!session.workdir || !fs.statSync(session.workdir, { throwIfNoEntry: false })?.isDirectory()) {
        return toolResult('No working directory yet — call clone_repo first.');
      }
      const cwd = resolvePath(session.workdir, directory || '.');
      if (cwd === null || !fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
        return toolResult(`Can't run in ${directory}: it's not a directory in the repository.`);
      }
      let args;
      try {
        args = splitCommand(command);
      } catch (e) {
        return toolResult(`Couldn't read the command: ${/** @type {Error} */ (e).message}.`);
      }
      if (args.length === 0) return toolResult('No command given.');

      let result;
      try {
        result = await run(args, { cwd, timeout: COMMAND_TIMEOUT_SECONDS });
      } catch (e) {
        if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT')
          return toolResult(`${args[0]} isn't installed here.`);
        if (e instanceof CommandTimeoutError)
          return toolResult(`Command timed out after ${COMMAND_TIMEOUT_SECONDS}s: ${command}`);
        throw e;
      }

      const out = result.stdout.trim();
      const err = result.stderr.trim();
      const parts = [`exit=${result.returncode}`];
      if (out) parts.push(`stdout:\n${clip(out, 4000)}`);
      if (err) parts.push(`stderr:\n${clip(err, 2000)}`);
      return toolResult(parts.join('\n'));
    },
  );
