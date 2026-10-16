/**
 * The result of a (possibly paused) agent run.
 *
 * `startRun` and `resumeRun` in `agent/agent.js` return this and
 * `agent/turns.js` reads it, so turn handling never touches the agent
 * framework. At most one of `finalOutput` or `paused` is set, and neither is
 * after the agent archives the channel:
 *
 * - `finalOutput` — the run completed; this is the text to post.
 * - `paused` + `command` — the run paused on a command that needs approval.
 *   `paused` is the handle on the run, passed back to `resumeRun` unchanged
 *   once someone decides.
 */
export class RunOutcome {
  /**
   * @param {Object} fields
   * @param {string | null} [fields.finalOutput]
   * @param {any} [fields.paused]
   * @param {string | null} [fields.command] - The command waiting on approval, shown on the approval message.
   * @param {any[]} [fields.history] - Always set — the conversation so far, persisted so the next turn has context.
   */
  constructor({ finalOutput = null, paused = null, command = null, history = [] } = {}) {
    this.finalOutput = finalOutput;
    this.paused = paused;
    this.command = command;
    this.history = history;
  }

  get needsApproval() {
    return this.paused !== null;
  }
}
