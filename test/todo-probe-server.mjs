// todo-probe-server.mjs — 让"模型"调用一次 todo_write 的确定性桩
//
// 目的：产出一份**真实**的会话日志，里面有真的 `todo/write` 事件，供
// replay-todos.mjs 用**真正的投影定义**去折叠。
//
// 判定：带非空 tools、历史里还没有 role:'tool' 的工具结果、且未超过上限 → 回工具调用。
// ⚠️ 次数上限不是装饰：早先一个按"请求里出现标记"判定的桩让 Agent 空转了 5,324 次
//    （见 dsh-sandbox-arg-guard 的 EVIDENCE.md）。
//
// 用法:
//   node test/todo-probe-server.mjs [--port 8141] [--tools todo_write,create_goal]
//
// --tools 按顺序发出多个工具调用：第一个主回合请求发第一个、收到工具结果后的请求发第二个……
// 发完就回纯文本。上限由列表长度决定，因此天然有界（早先一个按"请求里出现标记"判定的桩
// 让 Agent 空转了 5,324 次，见 dsh-sandbox-arg-guard 的 EVIDENCE.md）。
//
// 为什么需要第二个工具调用：headless 一个会话只能跑一个回合，而插件的正向路径需要
// "先写清单、再出现下一个 turn/start"。让第 1 轮 create_goal，goal-round-driver 就会
// 自动进入第 2 轮 —— 那就是真实的第二个 turn/start。
import { createServer } from 'node:http';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 || process.argv[index + 1] === undefined ? fallback : process.argv[index + 1];
}

const port = Number(arg('port', '8141'));

// 故意留两项没做完 —— 这正是插件应当接手的情形。
const TODOS = [
  { content: '写复现脚本', status: 'completed' },
  { content: '跑 BEFORE 折叠', status: 'in_progress' },
  { content: '跑 AFTER 折叠', status: 'pending' },
];

const ARGUMENTS_BY_TOOL = {
  todo_write: { todos: TODOS },
  create_goal: { objective: 'prove the second turn carries the list', max_goal_rounds: 2 },
};

const script = arg('tools', 'todo_write').split(',').map((s) => s.trim()).filter(Boolean);

function toolCallChunks(toolName, toolArguments) {
  const midpoint = Math.max(1, Math.floor(toolArguments.length / 2));
  return [
    {
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: `todo-probe-${toolName}`,
            type: 'function',
            function: { name: toolName, arguments: toolArguments.slice(0, midpoint) },
          }],
        },
        finish_reason: null,
      }],
    },
    {
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: toolArguments.slice(midpoint) } }] },
        finish_reason: null,
      }],
    },
  ];
}

let served = 0;
let toolCallsSent = 0;

const server = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!request.url.endsWith('/chat/completions')) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: `no stub route for ${request.url}` } }));
      return;
    }

    served += 1;
    let body = {};
    try { body = JSON.parse(raw); } catch { /* 非 JSON 体按纯文本处理 */ }
    // 只看 tools 是否非空：会话标题请求没有 tools，天然被排除；而主回合即使已经带回了
    // 工具结果也仍要发下一个脚本条目，所以这里**不能**再要求"历史里没有工具结果"。
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const nextTool = hasTools && toolCallsSent < script.length ? script[toolCallsSent] : undefined;

    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    });
    response.flushHeaders();
    const send = (payload) => {
      response.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`);
    };

    if (nextTool !== undefined) {
      toolCallsSent += 1;
      const toolArguments = JSON.stringify(ARGUMENTS_BY_TOOL[nextTool] ?? {});
      for (const chunk of toolCallChunks(nextTool, toolArguments)) send(chunk);
      send({
        choices: [{ index: 0, delta: { content: '' }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      });
      send('[DONE]');
      response.end();
      console.log(`[todo-probe] request #${served}: TOOL CALL ${nextTool} ${toolArguments}`);
      return;
    }

    send({ choices: [{ index: 0, delta: { content: 'todo probe finished' }, finish_reason: null }] });
    send({
      choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    });
    send('[DONE]');
    response.end();
    console.log(`[todo-probe] request #${served}: plain text`);
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[todo-probe] listening on http://127.0.0.1:${port}/v1/chat/completions`);
  console.log(`[todo-probe] tools=${script.join(',')}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[todo-probe] ${signal}: served=${served}`);
    server.close(() => process.exit(0));
  });
}
