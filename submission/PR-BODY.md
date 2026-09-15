# add dsh-todo-continuity

A plugin that keeps an unfinished task list visible across turns.

## The problem

DSH clears the `todos` projection at the start of every turn and expects the model to rewrite the whole
list. From `packages/todo/tool-todo/src/index.ts:130-145`, whose own comment describes it as intentional:

```ts
apply: (state, event) => {
  if (event.type === 'todo/write') return event.data.todos
  if (event.type === 'turn/start') return null
  return state
},
stateVersion: 2,
```

The interrupted case is what breaks: the next `turn/start` clears the list anyway, so a plan written
before an interrupted turn disappears permanently. It is not lost — it is durably in the log — but
`todo_write` (`:203-222`) only appends snapshots and returns counts, so there is no way to read it back
from the UI **or** from the model.

This is community addition #21 to the verified unfixed-issue list in discussion
[#6520](https://github.com/deepseek-ai/deepseek-harness/discussions/6520).

## What the plugin does

Registers one ordinary `session/event` listener. It remembers the last `todo/write` list per session
and, when a `turn/start` arrives whose remembered list still has unfinished items, re-appends that list
as a fresh `todo/write`. A projection is a pure fold over the durable log, so appending the event the
fold reacts to restores the state.

Deliberately narrow: only unfinished lists (a fully completed list keeps the built-in behaviour), at
most one extra event per `turn/start`, and it fails open if the append cannot be made.

## Why it does not fork `tool-todo`

It cannot replace the projection: the registry refcounts a repeated key only at an equal `stateVersion`
and throws on a mismatch (`session-projection/src/index.ts:276-283`), so the original definition always
wins. Appending the folded event is the reachable seam — which keeps this to one small file instead of
a fork of a built-in package.

## Verification

A controlled A/B on real sessions — two identical headless runs differing only in whether the plugin
was installed, both folded through the **real** `todos` projection definition. Raw output in
[`EVIDENCE.md`](https://github.com/apex-mochen/dsh-todo-continuity/blob/main/EVIDENCE.md):

| | real events | folded final state |
|---|---|---|
| without the plugin | `turn/start#4 → todo/write#24 → turn/end#47 → turn/start#49 → turn/end#51` | `null` — list gone |
| with the plugin | `… → turn/start#49 → **todo/write#51** → turn/end#52` | the 3-item list |

The extra event is preceded only by `turn/start` — no `tool/call`, no `tool/result` — while the model's
own write has both. The control run has no such event, which establishes causation.

Getting a real second turn headlessly needed a trick worth sharing: headless has no `--resume`, so the
stub calls `create_goal` as its second tool call and `goal-round-driver` continues into round two,
emitting a real second `turn/start`.

## Checks

- `dsh.bundle.patch` is declared, pointing at `./cordis.patch.yml`
- 24 unit checks pass (`npm test`); the fake session enforces the real append re-entrancy guard, so the
  suite cannot pass while the plugin makes the mistake an earlier revision made
- Zero dependencies; one implementation file; no process, filesystem, or network access

## This overrides a designed behaviour

Per-turn clearing is documented as intentional, so this is a deliberate product-semantics change, not
a bug fix — scoped as narrowly as it can be. The upstream alternative is to clear only when the list
has nothing left to do. DSH does not accept external pull requests today, so a plugin is the reachable
seam.
