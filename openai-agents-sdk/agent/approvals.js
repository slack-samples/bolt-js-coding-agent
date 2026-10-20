/**
 * Command approvals for the coding agent.
 *
 * `run_command` runs programs the model chooses. To keep a human in the loop,
 * `commandNeedsApproval` decides which commands pause for a decision:
 *
 * - A command that only reads, such as `ls`, `grep`, or `git diff`, runs
 *   immediately. So do local git changes that git can undo, such as `git add`,
 *   `git commit`, and `git switch -c`.
 * - Anything else pauses the agent run. `agent/turns.js` posts Approve / Deny
 *   buttons in the code channel, parks the paused run in `pendingStore`, and
 *   resumes it once a human decides.
 *
 * Running the repository's own code, such as its tests, build, or package
 * installs, always asks, since a cloned repository is untrusted input. So does any
 * path that leaves the clone, like `/etc`, `C:\Windows`, or `../x`. Commands run
 * without a shell, and this splits a command into arguments with the same
 * `splitCommand` that `run_command` uses, so what's checked here is exactly what
 * runs: `&&`, `|`, or `$(...)` can't chain a second command, they're only text.
 * File edits don't go through here: the `write_file` and `edit_file` tools only
 * write inside the clone. Only ever run this against trusted, throwaway
 * repositories. See the README's Command approvals section.
 */

import { splitCommand } from './workspace.js';

// Programs that only read, so they run without asking.
const READ_ONLY_COMMANDS = new Set(['cat', 'find', 'git', 'grep', 'head', 'ls', 'pwd', 'rg', 'tail', 'tree', 'wc']);

// git subcommands that only read, or only change the local clone in ways git
// can undo. Any other subcommand, or an option before the subcommand like
// `git -c`, asks first.
const SAFE_GIT_SUBCOMMANDS = new Set([
  'add',
  'blame',
  'branch',
  'commit',
  'diff',
  'log',
  'ls-files',
  'rev-parse',
  'show',
  'status',
  'switch',
]);

// Options that make a safe program run something, write outside its own
// files, or throw away work, matched as a prefix so `-execdir` and `--pre=cmd`
// count too. For git that includes the forced `git branch -C`, `-D`, and `-M`,
// which also catches the harmless `git diff -C` and `-M`, to stay simple.
/** @type {Record<string, string[]>} */
const UNSAFE_OPTIONS = {
  find: ['-delete', '-exec', '-fls', '-fprint', '-ok'],
  git: ['--discard-changes', '--force', '--output', '-C', '-D', '-M', '-f'],
  rg: ['--pre'],
  tree: ['-o'],
};

/**
 * Whether an argument can point outside the working directory.
 *
 * That's a path from the root or a drive (`/etc`, `C:/Windows`, `//server`) or
 * one that climbs out (`../x`), with either kind of slash. An option carrying a
 * path, like `--file=/etc/x` or `-f/etc/x`, asks whenever it has a slash, to
 * stay simple.
 *
 * @param {string} arg
 * @returns {boolean}
 */
function readsOutsideTheClone(arg) {
  const path = arg.replaceAll('\\', '/');
  if (path.startsWith('-')) return path.includes('/');
  const hasDrive = path.length > 1 && path[1] === ':';
  return path.startsWith('/') || hasDrive || path.split('/').includes('..');
}

/**
 * Whether a command needs a human to approve it before it runs.
 * @param {string} command
 * @returns {boolean}
 */
export function commandNeedsApproval(command) {
  let args;
  try {
    args = splitCommand(command);
  } catch {
    // Unparseable (e.g. unbalanced quotes) — be safe and require approval.
    return true;
  }
  const [program, ...rest] = args;
  if (program === undefined || !READ_ONLY_COMMANDS.has(program)) return true;
  if (program === 'git' && (rest.length === 0 || !SAFE_GIT_SUBCOMMANDS.has(rest[0]))) return true;
  if (rest.some(readsOutsideTheClone)) return true;
  const unsafe = UNSAFE_OPTIONS[program] ?? [];
  return rest.some((arg) => unsafe.some((option) => arg.startsWith(option)));
}

/** A paused agent run and the approval message awaiting a human decision. */
export class PendingApproval {
  /**
   * @param {Object} fields
   * @param {any} fields.paused - The handle on the paused run, passed back to `resumeRun`.
   * @param {import('./sessions.js').AgentDeps} fields.deps
   * @param {string} fields.command
   * @param {string} fields.messageTs - The message with the Approve / Deny buttons.
   */
  constructor({ paused, deps, command, messageTs }) {
    this.paused = paused;
    this.deps = deps;
    this.command = command;
    this.messageTs = messageTs;
  }
}

/**
 * Paused runs, one per code channel.
 *
 * A newer paused run in the same channel replaces the older one, so a click
 * only resolves the run whose buttons it came from. State is held in-process
 * (fine for a single-instance sample); a multi-instance deployment would
 * persist the paused run to a shared store instead.
 */
export class PendingApprovalStore {
  constructor() {
    /** @type {Map<string, PendingApproval>} */
    this.pending = new Map();
  }

  /**
   * @param {string} channelId
   * @param {PendingApproval} pending
   */
  put(channelId, pending) {
    this.pending.set(channelId, pending);
  }

  /**
   * Take the paused run whose approval message is `messageTs`, if any.
   * @param {string} channelId
   * @param {string} messageTs
   * @returns {PendingApproval | null}
   */
  pop(channelId, messageTs) {
    const pending = this.pending.get(channelId);
    if (!pending || pending.messageTs !== messageTs) return null;
    this.pending.delete(channelId);
    return pending;
  }

  /**
   * Drop the channel's paused run, whatever its message, and return it.
   * @param {string} channelId
   * @returns {PendingApproval | null}
   */
  discard(channelId) {
    const pending = this.pending.get(channelId) ?? null;
    this.pending.delete(channelId);
    return pending;
  }
}

export const pendingStore = new PendingApprovalStore();
