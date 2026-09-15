/**
 * dsh-todo-continuity — keep an unfinished task list visible across turns.
 *
 * Verified end to end on real sessions, with a controlled A/B: two identical runs
 * differing only in whether this plugin was installed, folded through the real
 * `todos` projection definition. See EVIDENCE.md.
 *
 * The behaviour this addresses (mechanism confirmed by the curator of DSH
 * discussion #6520, community addition #21):
 *
 *   `packages/todo/tool-todo/src/index.ts:138-142` folds the `todos` projection
 *   as "latest todo/write list, cleared by the NEXT turn/start":
 *
 *     apply: (state, event) => {
 *       if (event.type === 'todo/write') return event.data.todos
 *       if (event.type === 'turn/start') return null
 *       return state
 *     }
 *
 *   That is deliberate — the tool description tells the model to send the whole
 *   list every call, so the list is expected to be rewritten each turn. But when
 *   a turn is interrupted (no `turn/end`), the next `turn/start` still clears the
 *   list, and nothing can bring it back: `todo_write` is write-only, so neither
 *   the user nor the model can read the previous list. The plan is durably in the
 *   log and visibly gone from the UI.
 *
 * Why this needs no fork, and no projection change:
 *
 *   A projection is a pure fold over the durable log, and the registry drives it
 *   on `session/event` (`session-projection/src/index.ts:220-222`). So the state
 *   can be restored by *appending the event the fold reacts to*, after the event
 *   that cleared it. That is what this plugin does, and it is why it registers
 *   nothing but one ordinary event listener.
 *
 *   Replacing the projection instead is not possible for a plugin: the registry
 *   refcounts a repeated key only when the `stateVersion` matches, and throws on
 *   a mismatch (`session-projection/src/index.ts:276-283`), so the original
 *   definition always wins. Appending is the reachable seam.
 *
 * This is a deliberate override of a designed behaviour, not a bug fix. It is
 * scoped as narrowly as possible: it re-appends only a list that still has
 * unfinished work, and only once per `turn/start`.
 */

/** Plugin name, as declared in this package's cordis.patch.yml entry. */
export const name = 'dsh-todo-continuity';

/** The logged event carrying a whole todo list. */
const TODO_WRITE = 'todo/write';

/** The logged event that clears the `todos` projection. */
const TURN_START = 'turn/start';

const DEFAULTS = {
  /** Set false to keep the plugin installed but inert. */
  enabled: true,
  /** Log each carry-over on the diagnostic channel. */
  verbose: false,
};

/**
 * Whether a remembered list is worth carrying into the next turn.
 *
 * A list with nothing left to do is intentionally left alone: the built-in
 * behaviour (cleared at the next `turn/start`) stays in force for finished
 * work, so the plugin only ever changes the case it exists for.
 *
 * @param {unknown} todos - the last list written for this session.
 * @returns {boolean} whether the list has at least one unfinished item.
 */
export function shouldCarryOver(todos) {
  if (!Array.isArray(todos) || todos.length === 0) return false;
  return todos.some((todo) => todo?.status !== 'completed');
}

/**
 * Register the carry-over against the host context.
 *
 * Only one seam is used: the ordinary `session/event` feed the projection
 * registry itself drives from. Nothing here is a waterfall, so there is no
 * `next()` obligation and no way to swallow another plugin's behaviour.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ enabled?: boolean, verbose?: boolean }} [config]
 * @returns {void}
 */
export function apply(ctx, config) {
  const options = { ...DEFAULTS, ...(config ?? {}) };
  if (!options.enabled) return;

  // Last whole list seen per session. Keyed by the session object, so an
  // evicted session drops its entry with it.
  const latest = new WeakMap();

  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type === TODO_WRITE) {
        latest.set(session, event.data?.todos);
        return;
      }
      if (event?.type !== TURN_START) return;

      const todos = latest.get(session);
      if (!shouldCarryOver(todos)) return;

      // The append MUST be deferred by a microtask. This is forced by source,
      // not a style choice:
      //
      //   Session.append sets `entry.appending = true` (:742), publishes the
      //   event to its `session/event` listeners (:752), and only clears the flag
      //   in `finally` (:755-757). A reentrant append is rejected outright —
      //   (:729-731) 'session append cannot reenter while another append is
      //   being published'. We are inside that window right now, because this
      //   handler IS one of those listeners.
      //
      // So an inline `session.append(...)` here would throw every time, and
      // because this handler fails open the plugin would silently do nothing at
      // all — the worst possible failure: no error, no effect. A microtask runs
      // after the publication boundary closes, and still long before the model's
      // next request is built, so the carried-over list reaches the projection in
      // time to be rendered.
      //
      // Ordering also works out: `emit` invokes listeners synchronously in array
      // order (vendor/cordis/src/events.ts:194-196), `dispatch` preserves that
      // order (:172-174), and `on` PUSHes unless `prepend` is set (:255). The
      // projection registry registers its listener in its own constructor
      // (session-projection/src/index.ts:220-222) while the base bundle loads, so
      // it runs before this handler and has already folded `turn/start` to null.
      //
      // The deferred append re-enters this listener for the new todo/write, which
      // only records the list again — that branch cannot reach another append, so
      // this cannot loop.
      queueMicrotask(() => {
        try {
          session.append(TODO_WRITE, { todos });
          if (options.verbose) {
            globalThis.console?.error?.(
              `[${name}] carried ${todos.length} todo(s) across turn/start for ${String(session?.id ?? '?')}`,
            );
          }
        } catch (_appendFailed) {
          // Fail open: a plugin that cannot restore a task list must never be the
          // reason a turn breaks. The caller simply keeps the built-in behaviour.
          // Reported under `verbose` only, because a silent no-op is the one
          // outcome nobody can debug: this branch is indistinguishable from "the
          // list was already complete" unless it says so.
          if (options.verbose) {
            globalThis.console?.error?.(`[${name}] could not carry the list across turn/start: ${String(_appendFailed)}`);
          }
        }
      });
    } catch (_carryOverFailed) {
      // Fail open. A plugin that cannot restore a task list must never be the
      // reason a turn does not start: the built-in behaviour is merely what the
      // caller already had before installing this.
    }
  });
}

export default { name, apply };
