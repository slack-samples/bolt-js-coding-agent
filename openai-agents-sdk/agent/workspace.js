/**
 * The session's working directory: running commands in it and keeping file access inside it.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Environment variables kept from the app's environment are everything except
// the app's own tokens and anything that looks like a credential, so they aren't
// passed to a command from the repository.
const SECRET_PREFIXES = ['OPENAI_', 'SLACK_'];
const SECRET_MARKERS = ['API_KEY', 'CREDENTIAL', 'PASSWORD', 'PRIVATE_KEY', 'SECRET', 'TOKEN'];

// git never waits on a prompt or an editor, since nobody can answer one.
const GIT_DEFAULTS = {
  GIT_EDITOR: 'true',
  GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
  PAGER: 'cat',
};

/**
 * @typedef {Object} Output
 * @property {number | null} returncode - The exit code, or null if a signal ended the program.
 * @property {string} stdout
 * @property {string} stderr
 */

/** Raised by `run` when a program runs past its timeout. */
export class CommandTimeoutError extends Error {}

/**
 * Split a command into arguments the way a POSIX shell does, like Python's `shlex.split`.
 *
 * Whitespace separates arguments, quotes group them, and a backslash escapes the
 * next character outside single quotes. That's all: `&&`, `|`, `>`, and `$(...)`
 * are ordinary text, since commands run without a shell. Throws on an unclosed
 * quote or a trailing backslash.
 *
 * @param {string} command
 * @returns {string[]}
 */
export function splitCommand(command) {
  /** @type {string[]} */
  const args = [];
  let current = '';
  let inArgument = false;
  /** @type {"'" | '"' | null} */
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
    } else if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === '\\' && (command[i + 1] === '"' || command[i + 1] === '\\')) {
        // Inside double quotes, a backslash only escapes a quote or another backslash.
        current += command[++i];
      } else {
        current += char;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
      inArgument = true;
    } else if (char === '\\') {
      if (i + 1 >= command.length) throw new Error('No escaped character');
      current += command[++i];
      inArgument = true;
    } else if (' \t\r\n'.includes(char)) {
      if (inArgument) args.push(current);
      current = '';
      inArgument = false;
    } else {
      current += char;
      inArgument = true;
    }
  }
  if (quote) throw new Error('No closing quotation');
  if (inArgument) args.push(current);
  return args;
}

/**
 * The environment commands run with: the app's, minus its secrets.
 * @returns {Record<string, string>}
 */
function commandEnv() {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SECRET_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    if (SECRET_MARKERS.some((marker) => name.toUpperCase().includes(marker))) continue;
    env[name] = value;
  }
  return { ...env, ...GIT_DEFAULTS };
}

/**
 * Run a program with its arguments in `cwd`, without a shell.
 *
 * Without a shell, arguments like `&&`, `|`, or `$(...)` reach the program as
 * plain text. On Windows, Node won't start `.cmd` and `.bat` programs like `npm`
 * without a shell, so those don't run there. Rejects with an `ENOENT` error when
 * the program isn't installed, and a `CommandTimeoutError` past `timeout`
 * seconds.
 *
 * @param {string[]} args - The program and its arguments.
 * @param {{ cwd: string, timeout?: number }} options
 * @returns {Promise<Output>}
 */
export function run([program, ...rest], { cwd, timeout = 60 }) {
  return new Promise((resolve, reject) => {
    // A path like `./gradlew` runs relative to `cwd`, and a bare name is found on PATH.
    const child = spawn(program, rest, {
      cwd,
      env: commandEnv(),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    /** @type {Buffer[]} */
    const stdout = [];
    /** @type {Buffer[]} */
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new CommandTimeoutError(`Timed out after ${timeout}s`));
    }, timeout * 1000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (returncode) => {
      clearTimeout(timer);
      resolve({
        returncode,
        stdout: Buffer.concat(stdout).toString('utf-8'),
        stderr: Buffer.concat(stderr).toString('utf-8'),
      });
    });
  });
}

/**
 * The real path of `target`, following symlinks in the part of it that exists.
 * @param {string} target
 * @returns {string}
 */
function realpath(target) {
  const missing = [];
  let existing = target;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...missing);
}

/**
 * Whether `target` is `root` or inside it.
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Whether two existing paths are the same file or directory.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function sameFile(a, b) {
  const first = fs.statSync(a, { bigint: true });
  const second = fs.statSync(b, { bigint: true });
  return first.dev === second.dev && first.ino === second.ino;
}

/**
 * Whether `target` is in a `.git` directory, however its name is written.
 *
 * A case-insensitive filesystem, like macOS's default, treats `.GIT` as `.git`,
 * and Windows ignores trailing dots and spaces in names.
 *
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
function inGitDir(root, target) {
  const parts = path.relative(root, target).split(path.sep);
  if (parts.some((part) => part.toLowerCase().replace(/[. ]+$/, '') === '.git')) {
    return true;
  }
  const gitDir = path.join(root, '.git');
  if (!fs.existsSync(gitDir)) return false;
  // Catch any other name that leads to the same directory.
  for (let parent = target; isInside(root, parent); parent = path.dirname(parent)) {
    if (fs.existsSync(parent) && sameFile(parent, gitDir)) return true;
    if (parent === root) break;
  }
  return false;
}

/**
 * The absolute path for `filePath` inside `workdir`, or null if it's outside.
 *
 * Writes into `.git` are refused too: its config and hooks decide what git
 * runs, and git commands like `git commit` run without asking.
 *
 * @param {string} workdir
 * @param {string} filePath
 * @param {{ writing?: boolean }} [options]
 * @returns {string | null}
 */
export function resolvePath(workdir, filePath, { writing = false } = {}) {
  const root = realpath(workdir);
  const target = realpath(path.resolve(root, filePath));
  if (!isInside(root, target)) return null;
  if (writing && inGitDir(root, target)) return null;
  return target;
}

/**
 * Shorten `text` to about `limit` characters, keeping its start and its end.
 *
 * The end of command output usually matters most, like a test run's failures
 * and summary, so it gets most of the room.
 *
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
export function clip(text, limit) {
  if (text.length <= limit) return text;
  const head = Math.floor(limit / 4);
  const tail = limit - head;
  const cut = text.length - head - tail;
  return `${text.slice(0, head)}\n… ${cut} characters cut …\n${text.slice(-tail)}`;
}
