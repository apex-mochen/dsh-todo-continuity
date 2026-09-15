# Evidence

Raw output produced on this machine with DSH `0.1.2-rc.1`. Nothing here is reconstructed from memory.

> **Status: verified end to end on real sessions with a controlled A/B.** Two real headless runs,
> identical stub and prompt, differing only in whether the plugin was installed; both folded with the
> **real** projection definition. Without it the list is gone; with it the list survives.

## Summary

| Step | Result |
|---|---|
| Does a real session's unfinished list disappear at the next `turn/start`? | **Yes — reproduced**, folding real logs with the **real** projection definition |
| Does the plugin keep it in a **real host run**? | **Yes** — an extra `todo/write` appears right after the second `turn/start` |
| Is causation proven? | **Yes** — the identical run without the plugin has no such event |
| Does the plugin disturb a normal single turn? | **No** — identical session shape, exit 0 |

## 1. Unit checks

```
$ node test/smoke.mjs
24 checks passed.
```

Includes the fold comparison, the loop-freedom checks, fail-open behaviour, and an assertion that
directly demonstrates the re-entrancy guard that forces the microtask (below).

## 2. What the defect is, from source

`packages/todo/tool-todo/src/index.ts:130-145` — the fold is documented as intentional:

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

`todo_write` is write-only (`:203-222` appends a `todo/write` snapshot and returns counts), so once the
projection is cleared, neither the user nor the model can read the previous list back.

## 3. Reproducing on real data

A real session log was produced by pointing `dsh --profile headless` at
`test/todo-probe-server.mjs`, a deterministic stub that makes the "model" call `todo_write` once with
three items, two of them unfinished. The log contains:

```
turn/start#4 → todo/write#24 → turn/end#35
```

with

```json
{"todos":[{"content":"写复现脚本","status":"completed"},
          {"content":"跑 BEFORE 折叠","status":"in_progress"},
          {"content":"跑 AFTER 折叠","status":"pending"}]}
```

`test/replay-todos.mts` then folds that **real** event list with the **real** projection definition.
The definition is not exported on its own — it is registered inside `apply()` — so the replay calls
the real `apply()` with a stub registry and captures what it registers:

```
真实投影      : key="todos" stateVersion=2
真实事件      : turn/start#4 → todo/write#24 → turn/end#35  → (下一个 turn/start)
写入的清单    : 3 项，其中未完成 2 项

BEFORE（无插件）下一个 turn/start 之后折叠终态:
  null   → 清单消失（缺陷）
AFTER（装插件）同一个下一个 turn/start 之后折叠终态:
  [{...3 items...}]   → 清单被带过来了
```

The `AFTER` side reuses the same real fold; only the event list differs, because the plugin appended
one event.

## 4. Two source facts that forced the implementation

**The append must be deferred.** `Session.append` publishes its event to listeners while its own
acceptance boundary is still open, and rejects a reentrant append
(`packages/core/session/src/index.ts`):

```ts
// :729-731
if (entry?.appending) {
  throw new Error('session append cannot reenter while another append is being published')
}
```

```ts
entry.appending = true                                    // :742
try {
  this.log.push(event)
  invokeContainedSessionObservers(..., 'session/event', …) // :752  ← listeners run HERE
} finally {
  entry.appending = false                                 // :757  ← cleared after
}
```

A `session/event` listener runs inside that window, so an inline append here would throw every time —
and because this plugin fails open, it would have silently done nothing at all. `queueMicrotask`
lands after the boundary closes. An earlier version of this plugin made exactly that mistake; it was
caught by reading the source, before any run.

**Listeners run in registration order**, so the projection registry has already folded `turn/start` to
`null` by the time the plugin sees it: `on` pushes unless `prepend` is set
(`vendor/cordis/src/events.ts:255`), `dispatch` preserves that order (`:172-174`), and `emit` invokes
them synchronously, forward (`:194-196`). The registry registers in its own constructor
(`session-projection/src/index.ts:220-222`), while the base bundle loads; this plugin loads last.

**Replacing the projection is not available to a plugin.** The registry refcounts a repeated key only
at an equal `stateVersion`, and throws on a mismatch
(`session-projection/src/index.ts:276-283`), so the first definition always wins. Appending the event
the fold reacts to is the reachable seam — which is why this plugin needs no fork of `tool-todo`.

## 5. The controlled A/B on real sessions

The hard part of verifying this plugin is that it only acts on a `turn/start` that follows a
`todo/write`, and a single headless turn is always `turn/start` → `todo/write` → `turn/end`. Headless
has no `--resume`, so it cannot produce a second turn on its own.

The way through: have the stub call **`create_goal` as its second tool call** in turn 1. `goal-round-driver`
then continues into a second round, which emits a **real second `turn/start`** — no synthesis needed,
still fully headless. `test/todo-probe-server.mjs --tools todo_write,create_goal` does this.

Two runs, identical in every respect except one (whether the plugin was installed):

**Without the plugin** (exit 1 — the replay asserts a non-null final state):

```
真实事件      : turn/start#4 → todo/write#24 → turn/end#47 → turn/start#49 → turn/end#51
折叠终态: null
  → 清单消失（缺陷）
```

**With the plugin** (exit 0):

```
真实事件      : turn/start#4 → todo/write#24 → turn/end#47 → turn/start#49 → todo/write#51 → turn/end#52
折叠终态: [{"content":"写复现脚本","status":"completed"},
           {"content":"跑 BEFORE 折叠","status":"in_progress"},
           {"content":"跑 AFTER 折叠","status":"pending"}]
  → 清单还在（插件在真实宿主里生效了）
```

Both folds use the **real** projection definition, captured from the real `apply()` (section 3).

### Why the extra event is the plugin's, and not something else

`todo/write#51` in the plugin run is preceded **only** by `turn/start#49` — there is no `tool/call` and
no `tool/result` behind it. The first `todo/write#24` is preceded by `tool/call#22` with
`name: "todo_write"` and a matching `tool/result#25`. So the second event was not produced by the
tool; it was appended directly. And the control run — identical stub, identical prompt — has **no**
such event at all, which is what rules out "something else in DSH emits it".

## 6. The plugin does not disturb a normal turn

Same probe, single tool call, plugin installed: 37 events — one `turn/start`, one `todo/write`, one
`turn/end` — identical to the run without it, exit 0.

## Note on the host process

During this work the DSH host's ability to spawn subprocesses failed machine-wide from the agent's
side (`0xC0000142` on every `pwsh`/`grep`). Reading files still worked, and the independently
scheduled `_market-tools` tasks kept running normally (their log shows a successful run at 17:41:02
while the agent's shell was failing), which located the fault in the host process rather than the OS.
Restarting the host fixed it. A plausible but **unverified** cause is that the earlier runaway probe
had the host spawn 5,324 subprocesses in one session.

