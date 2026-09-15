# dsh-todo-continuity

**让没做完的任务清单跨回合保留。**

DSH 在每个回合开始时清空 `todos` 投影，指望模型把整份清单重写一遍。可一旦某个回合被中断，
清单虽然durable 地留在会话日志里，界面上却永久消失——而 `todo_write` 是**只写**的，你和模型都
读不回来。本插件在回合开始、且上一份清单仍有未完成项时，把它补折回去。

## 它针对的行为

`packages/todo/tool-todo/src/index.ts:130-145`，源码自己把这段写成**有意设计**：

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

"每轮重写"确实是刻意的——工具描述就叫模型每次发送完整清单。问题出在**中断**这种情形：下一个
`turn/start` 照样把清单清掉，而 `todo_write`（`:203-222`）只追加快照并返回计数，没有任何读回的
途径。计划并没有丢——它在日志里——但界面上拿不到，模型也恢复不了。

这是 DSH discussion [#6520](https://github.com/deepseek-ai/deepseek-harness/discussions/6520)
社区核实清单的**追加第 21 条**。

## 它做什么

只注册一个普通的 `session/event` 监听器。它按会话记住最后一份 `todo/write` 清单；当 `turn/start`
到来、而记住的那份清单仍有未完成项时，就把这份清单作为一条新的 `todo/write` 追加回去。投影是
日志的纯函数，所以"补上折叠所反应的那条事件"就能恢复状态，别处什么都不用动。

刻意做得很窄：

- **只管未完成的清单**：全部 `completed` 的清单交给内置行为，插件在它不该管的场景里不改变任何东西。
- **每次 turn/start 最多补一条事件。**
- **不 fork**。它不 disable、也不替换 `tool-todo`——它也做不到：投影注册表对重复 key 只在
  `stateVersion` 相同时才引用计数，不同直接抛错（`session-projection/src/index.ts:276-283`），
  第一个定义永远获胜。追加事件才是够得着的那条缝。
- **不注册任何 waterfall**（`pre-execute` / `pre-step` / `llm/stream` 都没有），因此没有 `next()`
  义务，不可能吞掉别的插件的行为。
- **失败即放行**：补不上时，调用方拿到的就是原本的内置行为。

## 已验证

真实会话上的受控 A/B——两次内容完全相同的 headless 运行，唯一差别是插件装没装，都用**真正的**
`todos` 投影定义折叠。原始输出见 [EVIDENCE.md](./EVIDENCE.md)：

| | 真实事件序列 | 折叠终态 |
|---|---|---|
| 无插件 | `turn/start#4 → todo/write#24 → turn/end#47 → turn/start#49 → turn/end#51` | `null` —— 清单消失 |
| 装插件 | `… → turn/start#49 → **todo/write#51** → turn/end#52` | 那 3 项清单 |

多出来的那条事件后面**没有** `tool/call` 也没有 `tool/result`（模型自己那次 `todo_write` 是有配对的），
而对照组根本没有这条事件——这就是"是插件造成的"的依据。

## 安装

```bash
dsh plugin --profile web add github:apex-mochen/dsh-todo-continuity
```

装完重启该 profile。

## 配置

```yaml
- id: dsh-todo-continuity
  config:
    verbose: false   # 每次接续都打日志
    enabled: true    # 设 false 可保留安装但停用
```

## 两个值得知道的实现细节

**追加必须用微任务延后，这是源码强制的，不是风格问题。** `Session.append` 在向监听器发布事件时，
自己的接收边界仍然开着，并明确拒绝重入（`core/session/src/index.ts:729-731`，*"session append
cannot reenter while another append is being published"*；标志在 `:742` 置位、监听器在 `:752` 被调用、
`finally` 在 `:757` 复位）。`session/event` 监听器正是在那个窗口里跑的，所以同步追加每次都抛错——
而本插件失败即放行，结果就是**一声不响地什么都不做**。早先那版就犯了这个错，靠读源码在任何运行之前
抓住了它。

**监听器顺序正好合适。** 本插件的监听器跑到时，投影注册表已经把 `turn/start` 折成 `null` 了：
`on` 默认 `push`（`vendor/cordis/src/events.ts:255`）、`dispatch` 保持顺序（`:172-174`）、`emit` 同步
正向调用（`:194-196`），而注册表是在自己构造函数里注册的（base bundle 加载时）。

## 兼容性

- DSH `0.1.x`（peer：`@deepseek-ai/cordis ^4.0.1`）
- Node.js 20+
- 单文件实现、零依赖、不访问进程/文件系统/网络

## 这是覆盖一个设计决定，不是修 bug

"每轮清空"在源码里是有意为之，所以本插件是刻意的产品语义改动，只是范围收得尽可能窄。另一个方向的
修法在上游：仅当清单没有剩余工作可做时才清空。DSH 目前不接受外部 PR（`CONTRIBUTING.md`），插件是
够得着的那条缝。

## 许可

MIT
