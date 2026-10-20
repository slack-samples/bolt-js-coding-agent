import fs from 'node:fs';

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { WebAPIPlatformError } from '@slack/web-api';
import { toolResult } from '../runtime.js';
import { run } from '../workspace.js';

/** @param {import('../sessions.js').AgentDeps} deps */
export const publishDiff = (deps) =>
  tool(
    'publish_diff',
    "Publish the work so far as a diff in the code channel's code tab.\n" +
      '\n' +
      'The diff covers everything changed since the repository was cloned —\n' +
      'committed, uncommitted, and new files. Call this after making changes so the\n' +
      'user can review the work. Safe to call repeatedly — each call replaces the\n' +
      'code tab content.',
    {},
    async () => {
      const session = deps.session;
      if (!session.workdir || !fs.statSync(session.workdir, { throwIfNoEntry: false })?.isDirectory()) {
        return toolResult('No working directory yet — call clone_repo first.');
      }

      // Diff against the commit that was cloned, not the branch name, so commits
      // made straight onto the default branch still show.
      const diff = await run(['git', 'diff', session.baseCommit || 'HEAD'], { cwd: session.workdir });
      if (diff.returncode !== 0) return toolResult(`git diff failed: ${diff.stderr.trim().slice(0, 1000)}`);
      let content = diff.stdout;

      // `git diff` leaves out files git doesn't track yet, so add each new file.
      const untracked = await run(['git', 'ls-files', '--others', '--exclude-standard', '-z'], {
        cwd: session.workdir,
      });
      for (const file of untracked.stdout.split('\0').filter(Boolean)) {
        // Exits 1 when the files differ, which they always do here.
        const newFile = await run(['git', 'diff', '--no-index', '--', '/dev/null', file], { cwd: session.workdir });
        content += newFile.stdout;
      }

      if (!content.trim()) return toolResult('No changes to publish yet — the working tree matches the clone.');

      const head = await run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: session.workdir });
      const branch = head.stdout.trim();
      try {
        await deps.client.agents.conversations.setView({
          channel_id: deps.channelId,
          type: 'diff',
          content,
          base_branch: session.baseBranch ?? undefined,
          head_branch: branch,
        });
        return toolResult(`Published the diff (${session.baseBranch}...${branch}) to the code tab.`);
      } catch (e) {
        if (!(e instanceof WebAPIPlatformError)) throw e;
        return toolResult(`Could not publish the diff: ${e.data.error}`);
      }
    },
  );
