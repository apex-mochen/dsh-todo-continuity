# Changelog

All notable changes to this plugin are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0]

First release.

### Added

- `lib/index.js`: a DSH plugin (`name` + `apply(ctx, config)`) that registers one ordinary
  `session/event` listener. It remembers the last `todo/write` list per session and, when a
  `turn/start` arrives whose remembered list still has unfinished items, re-appends that list so the
  `todos` projection stops reporting an empty plan.
- Options: `verbose` (default `false`), `enabled` (default `true`).
- `cordis.patch.yml`: the `dsh.bundle.patch` insert entry that makes the package installable. It
  deliberately does **not** disable `tool-todo` — a plugin cannot replace the projection (the registry
  throws on a `stateVersion` mismatch), so appending the folded event is the seam.
- `test/smoke.mjs`: 24 checks — the fold comparison, the loop-freedom checks, fail-open behaviour, and
  a check that demonstrates the re-entrancy guard which forces the deferred append. The fake session
  enforces that guard, so the suite cannot pass while the plugin makes the mistake it once made.
- `test/todo-probe-server.mjs`: a deterministic OpenAI-compatible stub that makes the "model" call
  `todo_write` and then `create_goal`, so `goal-round-driver` continues into a **real second turn** —
  the only way to exercise this plugin headlessly, since headless has no `--resume`.
- `test/replay-todos.mts`: folds a real session log with the **real** `todos` projection definition
  (captured by calling the real `apply()`), and with a faithful session stub for the plugin side.
- `EVIDENCE.md`: the controlled A/B raw output.
- `dev-install.ps1`: pack + install into a profile, with a composed-tree assertion.

### Notes

- **Verified by a controlled A/B on real sessions.** Two identical headless runs differing only in
  whether the plugin was installed: without it the folded `todos` state after the second `turn/start`
  is `null`; with it, the unfinished list survives. The extra `todo/write` event has no `tool/call`
  behind it, and the control run has no such event — that is what establishes causation.
- **The append is deferred by a microtask, and that is forced by source.** `Session.append` rejects a
  reentrant append (`core/session/src/index.ts:729-731`) and publishes to listeners while its boundary
  is still open (`:742` set, `:752` listeners, `:757` cleared). An inline append from a `session/event`
  listener throws every time; because this plugin fails open, it would have silently done nothing.
- **This overrides a designed behaviour.** Per-turn clearing is documented as intentional in
  `tool-todo`; the plugin narrows the change to unfinished lists and to one event per `turn/start`. The
  upstream alternative is to clear only when the list has nothing left to do. DSH does not accept
  external pull requests today, so a plugin is the reachable seam.
- Zero runtime dependencies: the implementation has no imports at all.
