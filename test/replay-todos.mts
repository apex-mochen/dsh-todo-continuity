// replay-todos.mts — 用**真正的** todos 投影定义，折叠一份**真实**会话日志。
//
// 目的：证明「下一个 turn/start 一来，没做完的清单就没了」这件事发生在真实事件上，
// 而不是发生在我复刻的折叠逻辑上。
//
// 为什么这么绕：`tool-todo` 的投影定义是写在 apply() 内部的，没有单独导出
// （packages/todo/tool-todo/src/index.ts:134-145）。所以这里**调用真实的 apply()**，
// 用一个假的 sessionProjections 把它注册进去的定义抓出来 —— 拿到的就是真货。
//
// 运行（需要源码树里的 tsx）:
//   node --import <repo>/node_modules/tsx/esm test/replay-todos.mts <session.jsonl.zstd> [--json]
//   DSH_REPO 指向 deepseek-harness 源码目录
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const ZSTD_MAGIC = 0xfd2fb528;

/** 多帧 zstd 容器：一次性 API 只解第一帧，必须按结构切帧。 */
function readSessionEvents(file: string) {
  const raw = readFileSync(file);
  const frames: { start: number; end: number }[] = [];
  let offset = 0;
  while (offset < raw.length) {
    const start = offset;
    if (raw.length - offset < 4) break;
    if (raw.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`);
    offset += 4;
    if (offset === raw.length) break;
    const descriptor = raw.readUInt8(offset);
    offset += 1;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    for (;;) {
      if (raw.length - offset < 3) { offset = start; break; }
      const blockHeader = raw.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      offset += blockType === 0x01 ? 1 : blockSize;
      if (lastBlock) break;
    }
    if (offset === start) break;
    if (checksum) offset += 4;
    frames.push({ start, end: offset });
  }
  let text = '';
  for (const frame of frames) text += zstdDecompressSync(raw.subarray(frame.start, frame.end)).toString('utf8');
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* 非 JSON 行跳过 */ }
  }
  return events;
}

const sessionFile = process.argv[2];
if (sessionFile === undefined) {
  console.error('用法: node --import <repo>/node_modules/tsx/esm test/replay-todos.mts <session.jsonl.zstd> [--json]');
  process.exit(2);
}
const asJson = process.argv.includes('--json');
const repo = process.env.DSH_REPO ?? 'C:\\Users\\ASUS\\dsh-plugins\\_research\\deepseek-harness';

// ---- 1. 抓出真实的 todos 投影定义 ------------------------------------------------
const toolTodo = await import(pathToFileURL(join(repo, 'packages', 'todo', 'tool-todo', 'src', 'index.ts')).href);
let realDefinition: any = null;
toolTodo.apply({
  sessionProjections: { register: (definition: any) => { realDefinition = definition; return () => {}; } },
  tools: { register: () => () => {} },
}, { allowParallelInProgress: true });
if (realDefinition === null) throw new Error('没能从真实 apply() 里抓到 todos 投影定义');
if (realDefinition.key !== 'todos') throw new Error(`抓到的不是 todos 投影：${String(realDefinition.key)}`);

const foldReal = (events: any[], initial: any = null) =>
  events.reduce((state, event) => realDefinition.apply(state, event), initial);

// ---- 2. 从真实日志里取出相关事件 --------------------------------------------------
const log = readSessionEvents(sessionFile);
const relevant = log
  .filter((event) => ['turn/start', 'todo/write', 'turn/end'].includes(event.type))
  .map((event) => ({ type: event.type, data: event.data, seq: event.seq }));

const written = relevant.find((event) => event.type === 'todo/write')?.data?.todos;
if (!written) throw new Error('这份日志里没有 todo/write 事件');

// 下一次用户回合会再写一条 turn/start —— 这不需要第二个真实回合来证明：每一份会话
// 的第一个事件就是 turn/start（本文件读到的、以及本项目所有会话日志都一样）。
// 但若日志里**已经**有第二个回合（例如让 goal-round-driver 自动进的第二轮），
// 就用 --no-next-turn 直接折叠真实事件，不再合成。
const NEXT_TURN = { type: 'turn/start', data: {}, seq: -1 };
const synthesizeNextTurn = !process.argv.includes('--no-next-turn');
const folded = synthesizeNextTurn ? [...relevant, NEXT_TURN] : relevant;

// ---- 3. BEFORE：直接折叠真实日志（+ 可选的下一个 turn/start）------------------------
const beforeState = foldReal(folded);

// ---- 4. AFTER：把插件接到同一串事件上，再折叠 -------------------------------------
// 假 session 如实实现 append 的重入守卫（core/session/src/index.ts:729-731）。
const { apply: applyPlugin } = await import(new URL('../lib/index.js', import.meta.url).href);
const listeners: any[] = [];
let appending = false;
const afterEvents: any[] = [];
const session: any = {
  id: 'replay',
  append(type: string, data: any) {
    if (appending) throw new Error('session append cannot reenter while another append is being published');
    appending = true;
    try {
      const event = { type, data, seq: afterEvents.length };
      afterEvents.push(event);
      for (const listener of listeners) listener(session, event);
      return event;
    } finally { appending = false; }
  },
};
applyPlugin({
  on: (eventName: string, handler: any) => { if (eventName === 'session/event') listeners.push(handler); return () => {}; },
} as any, {});

for (const event of relevant) session.append(event.type, event.data);
await new Promise((resolve) => queueMicrotask(resolve));   // 等插件的微任务
if (synthesizeNextTurn) {
  session.append(NEXT_TURN.type, NEXT_TURN.data);
  await new Promise((resolve) => queueMicrotask(resolve));
}

// 当 --no-next-turn 时，日志本身就是一次**真实**运行，插件已经在里面生效过了：
// 这时 beforeState 就是"这份真实日志的终态"，再去模拟一遍是多余且会重复施加的。
const afterState = synthesizeNextTurn ? foldReal(afterEvents) : null;

// ---- 5. 报告 --------------------------------------------------------------------
const result = {
  session: sessionFile,
  realProjection: { key: realDefinition.key, stateVersion: realDefinition.stateVersion },
  realEvents: relevant.map((event) => ({ type: event.type, seq: event.seq })),
  written,
  beforeNextTurn: beforeState,
  afterNextTurn: afterState,
  beforeVerdict: beforeState === null ? '清单消失（缺陷）' : '清单还在',
  afterVerdict: afterState === null ? '清单消失' : '清单被带过来了',
};

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`会话文件      : ${sessionFile}`);
  console.log(`真实投影      : key="${realDefinition.key}" stateVersion=${realDefinition.stateVersion}`);
  console.log(`真实事件      : ${relevant.map((e) => `${e.type}#${e.seq}`).join(' → ')}${synthesizeNextTurn ? '  → (合成的下一个 turn/start)' : ''}`);
  console.log(`写入的清单    : ${written.length} 项，其中未完成 ${written.filter((t: any) => t.status !== 'completed').length} 项`);
  console.log('');
  if (synthesizeNextTurn) {
    console.log('BEFORE（无插件）下一个 turn/start 之后折叠终态:');
    console.log(`  ${JSON.stringify(beforeState)}   → ${result.beforeVerdict}`);
    console.log('AFTER（装插件）同一个下一个 turn/start 之后折叠终态:');
    console.log(`  ${JSON.stringify(afterState)}   → ${result.afterVerdict}`);
  } else {
    console.log('这是一份**真实运行**的日志（--no-next-turn），直接折叠它的真实事件：');
    console.log(`  折叠终态: ${JSON.stringify(beforeState)}`);
    console.log(`  → ${beforeState === null ? '清单消失（缺陷）' : '清单还在（插件在真实宿主里生效了）'}`);
  }
}
// 合成模式：要求"上游为 null、装插件后不为 null"。真实模式：要求这份真实日志的终态不为 null。
process.exit(synthesizeNextTurn ? (beforeState === null && afterState !== null ? 0 : 1) : (beforeState !== null ? 0 : 1));
