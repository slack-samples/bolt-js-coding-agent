import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { tool } from '@openai/agents';
import { z } from 'zod';

import { sessionStopped, toolFailed } from '../guardrails.js';
import { CommandTimeoutError, run } from '../workspace.js';

// Cap the clone so an unreachable or huge repository can't wedge the session.
const CLONE_TIMEOUT_SECONDS = 120;

// Remote URL forms the agent may clone. Local paths and `file://` would copy
// files off this machine, and other transports can run commands.
const CLONEABLE_URL_PREFIXES = ['git@', 'https://', 'ssh://'];

export const cloneRepo = tool({
  name: 'clone_repo',
  description:
    'Clone a git repository into a fresh temp directory for this session.\n' +
    '\n' +
    'Call this once before running commands or reading files. The clone becomes\n' +
    'the working directory for all later file and command tools and for the diff\n' +
    'published to the code channel. Cloning again replaces the earlier clone.',
  parameters: z.object({
    repo_url: z
      .string()
      .describe('A remote git URL for the repository to work on, starting with `https://`, `ssh://`, or `git@`.'),
  }),
  inputGuardrails: [sessionStopped],
  errorFunction: toolFailed,
  execute: async ({ repo_url }, context) => {
    if (!CLONEABLE_URL_PREFIXES.some((prefix) => repo_url.startsWith(prefix))) {
      return `Can't clone '${repo_url}'. Use a remote URL that starts with \`https://\`, \`ssh://\`, or \`git@\`.`;
    }

    const deps = /** @type {import('../sessions.js').AgentDeps} */ (context?.context);
    const session = deps.session;
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-agent-'));
    let clone;
    try {
      // The `--` keeps a URL from being read as an option like `--upload-pack`.
      // Symlinks check out as plain files, so a link in the repo can't point a
      // read-only command at a file outside the clone.
      clone = await run(['git', 'clone', '--config', 'core.symlinks=false', '--depth', '50', '--', repo_url, workdir], {
        cwd: path.dirname(workdir),
        timeout: CLONE_TIMEOUT_SECONDS,
      });
    } catch (e) {
      if (!(e instanceof CommandTimeoutError)) throw e;
      fs.rmSync(workdir, { recursive: true, force: true });
      return `Clone of ${repo_url} timed out after ${CLONE_TIMEOUT_SECONDS}s.`;
    }
    if (clone.returncode !== 0) {
      fs.rmSync(workdir, { recursive: true, force: true });
      return `Clone failed: ${clone.stderr.trim().slice(0, 1000)}`;
    }

    const head = await run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workdir });
    const commit = await run(['git', 'rev-parse', 'HEAD'], { cwd: workdir });
    if (session.workdir) {
      fs.rmSync(session.workdir, { recursive: true, force: true });
    }
    session.workdir = workdir;
    session.repoUrl = repo_url;
    session.baseBranch = head.stdout.trim();
    session.baseCommit = commit.stdout.trim();
    return (
      `Cloned ${repo_url} (default branch \`${session.baseBranch}\`) into the working ` +
      'directory. Create a branch with `git switch -c agent/<topic>` before editing.'
    );
  },
});
