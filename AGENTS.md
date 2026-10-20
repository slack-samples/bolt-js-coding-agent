# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

A monorepo for a **Coding Agent** sample for Slack, built with Bolt for JavaScript. Each framework lives in its own directory as a standalone sample:

- `openai-agents-sdk/` — built with the **OpenAI Agents SDK**

Implementations share a structure and user experience, not code. Keep each one obvious on its own, written in its framework's idiom, rather than adding shared helpers.

## Commands

Run these from inside an implementation directory, such as `openai-agents-sdk/`:

```sh
# Run the app (requires .env with the framework's API key; Slack tokens are optional with the CLI)
slack run          # via Slack CLI
npm start          # directly

# Lint and format (CI runs these on push to main and all PRs)
npm run lint

# Type check (JSDoc + TypeScript validation)
npm run check

# Run tests
npm test
```

## Code style

ES modules with kebab-case filenames, JSDoc types checked by `tsc --checkJs`, Biome for linting and formatting (single quotes, 2-space indent, 120 line width), and Node's built-in test runner.

## Repository structure

```
.github/             # Shared CI workflows and dependabot config
openai-agents-sdk/   # OpenAI Agents SDK implementation
```

CI runs Biome, the type check, and the tests against each directory with a matrix in `.github/workflows/lint.yml` and `.github/workflows/tests.yml`. Dependabot watches each directory separately. When adding an implementation, add its directory to both workflow matrices, to `.github/dependabot.yml`, and to the framework table in the root `README.md`.

## Architecture

Three layers: **app.js** -> **listeners/** -> **agent/**.

- **`app.js`** starts Bolt's `App` in Socket Mode and calls `registerListeners(app)`. **`app-oauth.js`** is the alternative entry point for OAuth over HTTP, where agent slash commands arrive at the manifest's `code_channels.slash_command_url`. Bolt handles each event as it arrives, so a long turn never holds up the stop button, an approval click, or another channel.
- **`listeners/`** holds Bolt handlers only, grouped by Slack feature (`actions/`, `commands/`, `events/`). Each sub-module has a `register(app)` function.
- **`agent/`** holds everything else: the agents and their prompts, one file per tool under `agent/tools/`, the turn handling, the sessions and the deps each run gets, and command approvals.

The flow: a mention or direct message outside a code channel runs a small routing agent that either replies in place or calls `create_code_channel`. Slack seeds the new channel with the request, and that mention starts the coding agent's first turn there, along with the conversation the request came from. Every later message, slash command, and approval in the channel runs a turn of the same session. Messages sent while a turn runs wait and go into the next turn together.

## Keeping implementations alike

Implementations share structure, not code, so these parts are kept the same by copying them and changing them everywhere at once:

- **The seam between `listeners/` and `agent/`.** Listeners import only from `agent/index.js`, never from the agent framework, so `listeners/` is the same in every implementation. `agent/index.js` exports `answerRequest`, `findSession`, `runTurn`, `resumeTurn`, `stopTurn`, and `endSession`.
- **Framework-free files.** `agent/turns.js`, `agent/context.js`, `agent/approvals.js`, `agent/sessions.js`, `agent/workspace.js`, `agent/outcome.js`, and `agent/prompts.js` don't import the agent framework. The framework lives in `agent/agent.js`, `agent/guardrails.js`, and `agent/tools/`. `turns.js` calls only `runRequest(prompt, deps)`, which returns the reply text, and `startRun(history, text, deps)` and `resumeRun(paused, approved, deps)`, which return the `RunOutcome` in `agent/outcome.js`. It calls them through its exported `runs` object, so tests can stand in for them. The paused run is a handle `turns.js` passes back without looking inside, so each framework's way of pausing fits behind it.
- **What the framework side keeps true.** `turns.js` relies on these, so every implementation keeps them: `create_code_channel` sets `deps.codeChannelId`, and `archive_channel` sets `session.archived`. Every code channel tool skips its call once `session.stopped` is set. A paused run's history already records the pending command as not run, so `turns.js` can drop a paused run without resuming it. Beyond that, `turns.js` only checks whether `history` is empty, to know a turn is the first.
- **Prompts.** `agent/prompts.js` is the same word for word in every implementation.
- **Tools.** Every implementation offers the same tools with the same names, arguments, and descriptions, written with its framework's tool helper. File tools stay inside the clone and can't write into `.git`. A tool that throws tells the model what went wrong.
- **Command approvals.** `commandNeedsApproval(command)` is plain JavaScript and the same in every implementation, wrapped in the framework's own approval hook. Read-only commands and local git changes run without asking. Anything that runs the repository's code or reaches outside the clone asks first. Commands run without a shell, and `splitCommand` in `agent/workspace.js` splits a command the same way for the check and the run. On Windows, Node won't start `.cmd` and `.bat` programs like `npm` without a shell, so those don't run there.
- **Tests.** Test files and names mirror each other, and `tests/agent/runs.test.js` drives real agent runs with a scripted model to cover pausing, resuming, stopping, and running out of turns. `tests/helpers.js` fakes the Slack client from the real one's method tree, so a call to a method that doesn't exist fails.

Refer to each implementation's README for its specifics.
