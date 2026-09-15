# dsh-todo-continuity

**Keeps an unfinished task list visible across turns.**

DSH clears the `todos` projection at the start of every turn, expecting the model to rewrite the whole
list. When a turn is interrupted, the list is durably in the session log but gone from the UI — and
`todo_write` is write-only, so neither you nor the model can read it back. This plugin re-appends the
last list when a turn starts and that list still has unfinished work.

## The behaviour it addresses

`packages/todo/tool-todo/src/index.ts:130-145` — the fold, and its own comment describing it as
intentional:

```ts
// Standing-plan fold: latest whole todo/write list, cleared by the next
// turn/start (turn/end keeps the finished checklist visible); null before the
// first write or after a later turn begins; every other event returns the
// same state reference.
apply: (state, event) => {
  if (event.type === 'todo/write') return event.data.todos
  if (event.type === 'turn/start') return null
  return state
},
stateVersion: 2,
```

Rewriting each turn is a deliberate design — the tool description tells the model to send the entire
list every call. The problem is the interrupted case: the next `turn/start` clears the list anyway, and
`todo_write` (`:203-222`) only appends snapshots and returns counts, so there is no way to read the
previous list back. The plan is not lost — it is in the log — but it is unreachable from the UI, and
the model has no way to recover it either.

This is **community addition #21** to the verified unfixed-issue list in DSH discussion
[#6520](https://github.com/deepseek-ai/deepseek-harness/discussions/6520).

## What the plugin does

Registers one ordinary `session/event` listener. It remembers the last `todo/write` list per session,
and when a `turn/start` arrives whose remembered list still has unfinished items, it appends that list
back as a fresh `todo/write`. A projection is a pure fold over the durable log, so appending the event
the fold reacts to restores the state — nothing else needs to change.

Deliberately narrow:

- **Only unfinished lists.** A list with everything `completed` is left to the built-in behaviour, so
  the plugin changes nothing about the case it does not exist for.
- **Once per turn start.** At most one extra event per `turn/start`.
- **No fork.** It does not disable or replace `tool-todo`. It cannot: the projection registry
  refcounts a repeated key only at an equal `stateVersion` and throws on a mismatch
  (`session-projection/src/index.ts:276-283`), so the first definition always wins. Appending is the
  reachable seam.
- **No waterfall.** It registers no `pre-execute` / `pre-step` / `llm/stream` hook, so it has no
  `next()` obligation and cannot swallow another plugin's behaviour.
- **Fails open.** If the append cannot be made, the caller keeps exactly the built-in behaviour.

## Verified

A controlled A/B on real sessions — two identical headless runs differing only in whether this plugin
was installed, both folded through the **real** `todos` projection definition. Raw output in
[EVIDENCE.md](./EVIDENCE.md):

| | real events | folded final state |
|---|---|---|
| without the plugin | `turn/start#4 → todo/write#24 → turn/end#47 → turn/start#49 → turn/end#51` | `null` — list gone |
| with the plugin | `… → turn/start#49 → **todo/write#51** → turn/end#52` | the 3-item list |

The extra event has no `tool/call` or `tool/result` behind it (unlike the model's own `todo_write`),
and the control run has no such event at all — which is what establishes that the plugin caused it.

## Install

```bash
dsh plugin --profile web add github:apex-mochen/dsh-todo-continuity
```

Restart the profile afterwards.

## Configuration

```yaml
- id: dsh-todo-continuity
  config:
    verbose: false   # log each carry-over
    enabled: true    # set false to keep it installed but inert
```

## Two implementation notes worth knowing

**The append is deferred by a microtask, and that is required, not stylistic.** `Session.append`
publishes its event to listeners while its own acceptance boundary is still open, and rejects a
reentrant append (`core/session/src/index.ts:729-731`, *"session append cannot reenter while another
append is being published"*; the flag is set at `:742`, listeners run at `:752`, cleared in `finally` at
`:757`). A `session/event` listener runs inside that window, so an inline append throws every time — and
because this plugin fails open, it would have silently done nothing. An earlier version made exactly
that mistake; source reading caught it before any run.

**Listener order works out.** The projection registry has already folded `turn/start` to `null` by the
time this plugin's listener runs: `on` pushes unless `prepend` is set (`vendor/cordis/src/events.ts:255`),
`dispatch` preserves that order (`:172-174`), `emit` invokes them synchronously and forward (`:194-196`),
and the registry registers in its own constructor while the base bundle loads.

## Compatibility

- DSH `0.1.x` (peer: `@deepseek-ai/cordis ^4.0.1`)
- Node.js 20+
- One implementation file, zero dependencies, no process/filesystem/network access

## This overrides a designed behaviour

Per-turn clearing is documented as intentional, so this plugin is a deliberate product-semantics
change, not a bug fix — scoped as narrowly as it can be. The alternative fix is upstream: clear only
when the list has nothing left to do. DSH does not accept external pull requests today
(`CONTRIBUTING.md`), so a plugin is the reachable seam.

## License

MIT
