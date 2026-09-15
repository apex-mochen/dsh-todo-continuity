// smoke.mjs — dsh-todo-continuity 的自检
//
// ⚠️ 尚未运行过（写它的时候 shell 不可用，见 lib/index.js 顶部横幅）。
//    环境恢复后第一件事就是 `node test/smoke.mjs`。
//
// 设计要点：假 session **如实实现**了真实的 append 重入守卫
// （packages/core/session/src/index.ts:729-731）——否则这个测试会给出假通过。
// 插件正是因为这个守卫才必须用 queueMicrotask 延后 append，所以测试里
// 专门有一条断言直接证明"同步 append 会被拒"。
//
//   node test/smoke.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { name, apply, shouldCarryOver } = await import(new URL('../lib/index.js', import.meta.url).href);

let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.log(`  ✗ ${label}${detail ? `  —— ${detail}` : ''}`); }
}
function section(title) { console.log(`\n${title}`); }

console.log('dsh-todo-continuity smoke test');

// ---- 与 tool-todo 完全一致的折叠 -------------------------------------------------
// 摘自 packages/todo/tool-todo/src/index.ts:134-145（stateVersion 2）。
// 独立复刻一份，是为了能分别算"上游折叠"和"装插件之后的折叠"。
function foldTodos(events, initial = null) {
  return events.reduce((state, event) => {
    if (event.type === 'todo/write') return event.data.todos;
    if (event.type === 'turn/start') return null;
    return state;
  }, initial);
}

/**
 * 假 session：append 会**同步**把事件回放给监听器，并在回放期间拒绝重入——
 * 与真实实现一致（:742 置位、:752 回放、:755-757 复位；:729-731 拒绝重入）。
 */
function makeRig(config) {
  const events = [];
  const listeners = [];
  let appending = false;
  const session = {
    id: 'session-test',
    append(type, data) {
      if (appending) throw new Error('session append cannot reenter while another append is being published');
      appending = true;
      try {
        const event = { type, data };
        events.push(event);
        for (const listener of listeners) listener(session, event);
        return event;
      } finally {
        appending = false;
      }
    },
  };
  const ctx = {
    on: (eventName, handler) => {
      if (eventName === 'session/event') listeners.push(handler);
      return () => {};
    },
  };
  apply(ctx, config);
  return { session, events, listeners };
}

/** 让插件排入的微任务跑完。 */
const tick = () => new Promise((resolve) => queueMicrotask(resolve));

/** 走完一串 append 并等微任务结算。 */
async function play(rig, steps) {
  for (const [type, data] of steps) rig.session.append(type, data);
  await tick();
  return rig.events;
}

const UNFINISHED = [
  { content: '写复现脚本', status: 'completed' },
  { content: '跑 BEFORE', status: 'in_progress' },
  { content: '跑 AFTER', status: 'pending' },
];
const ALL_DONE = [
  { content: '写复现脚本', status: 'completed' },
  { content: '跑 BEFORE', status: 'completed' },
];
const TURN = ['turn/start', {}];

section('shouldCarryOver：只有"还有没做完的"才值得带过去');
check('有未完成项 → 带', shouldCarryOver(UNFINISHED) === true);
check('全部 completed → 不带（保持内置行为）', shouldCarryOver(ALL_DONE) === false);
check('空数组 → 不带', shouldCarryOver([]) === false);
check('null / undefined / 非数组 → 不带',
  shouldCarryOver(null) === false && shouldCarryOver(undefined) === false && shouldCarryOver('x') === false);
check('状态字符串写错不算完成 → 带（保守）',
  shouldCarryOver([{ content: 'a', status: 'done' }]) === true);
check('不修改传入的数组', (() => {
  const input = [{ content: 'a', status: 'pending' }];
  shouldCarryOver(input);
  return input.length === 1 && input[0].status === 'pending';
})());

section('★ 为什么必须用微任务：真实守卫会拒绝同步重入');
check('在 append 发布期间再 append，会被明确拒绝', (() => {
  const rig = makeRig({});
  let message = '';
  rig.listeners.push(() => {
    try { rig.session.append('todo/write', { todos: [] }); } catch (error) { message = error.message; }
  });
  rig.session.append('turn/start', {});
  return message.includes('cannot reenter');
})());
check('正因为如此，插件不能在监听器里同步 append（微任务不是可选项）', (() => {
  // 把插件那个监听器单独跑在守卫窗口里，确认它不会当场抛错。
  const rig = makeRig({});
  rig.session.append('todo/write', { todos: UNFINISHED });
  let threw = false;
  try { rig.session.append('turn/start', {}); } catch { threw = true; }
  return threw === false;
})());

section('★ 折叠对比：这就是缺陷与修复本身');
check('上游：清单写完，下一个 turn/start 一来就没了（缺陷）', (() => {
  const events = [
    { type: 'turn/start', data: {} },
    { type: 'todo/write', data: { todos: UNFINISHED } },
    { type: 'turn/start', data: {} },
  ];
  return foldTodos(events) === null;
})());

check('装上插件：同一序列，清单被带过去了', await (async () => {
  const rig = makeRig({});
  const events = await play(rig, [[
    'todo/write', { todos: UNFINISHED },
  ], TURN]);
  return JSON.stringify(foldTodos(events)) === JSON.stringify(UNFINISHED);
})());

check('全部完成时插件不动手，折叠仍为 null（不改变内置语义）', await (async () => {
  const rig = makeRig({});
  const events = await play(rig, [['todo/write', { todos: ALL_DONE }], TURN]);
  return foldTodos(events) === null;
})());

check('从未写过清单时不会凭空造一条', await (async () => {
  const rig = makeRig({});
  const events = await play(rig, [TURN, TURN]);
  return events.length === 2;
})());

section('不会自激循环');
check('一次 turn/start 只补一条事件', await (async () => {
  const rig = makeRig({});
  const events = await play(rig, [['todo/write', { todos: UNFINISHED }], TURN]);
  return events.filter((e) => e.type === 'todo/write').length === 2;   // 原始 + 补
})());

check('连续三轮 turn/start：每轮各补一条，不爆炸', await (async () => {
  const rig = makeRig({});
  const events = await play(rig, [['todo/write', { todos: UNFINISHED }], TURN, TURN, TURN]);
  return events.filter((e) => e.type === 'todo/write').length === 4;   // 1 原始 + 3 补
})());

check('模型重写清单后，以最新那份为准（全完成 → 不补）', await (async () => {
  const rig = makeRig({});
  const events = await play(rig, [['todo/write', { todos: UNFINISHED }], ['todo/write', { todos: ALL_DONE }], TURN]);
  return events.filter((e) => e.type === 'todo/write').length === 2;
})());

section('失败即放行：append 抛错绝不能挡住宿主');
check('append 抛错时监听器不向外抛', await (async () => {
  const listeners = [];
  const session = { id: 's', append() { throw new Error('session is closed'); } };
  apply({ on: (n, h) => { if (n === 'session/event') listeners.push(h); return () => {}; } }, {});
  try {
    for (const listener of listeners) listener(session, { type: 'turn/start', data: {} });
    await tick();
    return true;
  } catch { return false; }
})());

check('不认识的 session/event 一律忽略', await (async () => {
  const rig = makeRig({});
  const events = await play(rig, [['assistant/message', { message: {} }], ['session/title', {}]]);
  return events.length === 2;
})());

section('插件形状');
check('导出了 name', name === 'dsh-todo-continuity');
check('导出了 apply', typeof apply === 'function');
check('apply 只注册一个 session/event 监听器', (() => {
  const registered = [];
  apply({ on: (n) => { registered.push(n); return () => {}; } }, {});
  return registered.length === 1 && registered[0] === 'session/event';
})());
check('不注册任何 waterfall（没有 next() 义务，不可能吞掉别人的行为）', (() => {
  const registered = [];
  apply({ on: (n) => { registered.push(n); return () => {}; } }, {});
  return !registered.some((n) => n.includes('pre-execute') || n.includes('agent/pre-step') || n.includes('llm/stream'));
})());
check('enabled: false 时不注册任何监听器', (() => {
  const registered = [];
  apply({ on: (n) => { registered.push(n); return () => {}; } }, { enabled: false });
  return registered.length === 0;
})());

section('打包契约（市场要求）');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
check('package.json 声明了 dsh.bundle.patch', pkg.dsh?.bundle?.patch === './cordis.patch.yml');
check('lib/index.js 是 ESM 且没有裸 export default', (() => {
  const src = readFileSync(join(root, 'lib/index.js'), 'utf8');
  return src.includes('export const name') && !/^export default (?!\{)/m.test(src);
})());

console.log(`\n${passed} checks passed${failed ? `, ${failed} FAILED` : ''}.`);
process.exit(failed === 0 ? 0 : 1);
