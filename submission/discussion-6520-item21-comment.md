@PerryLink 给追加第 21 条（todo 投影）补一份可复现的夹具、真实 A/B，以及一条**不需要 fork `tool-todo`** 的接缝。先说清性质：这一条与清单里多数的"明确缺陷"不同，**它是被源码写成有意设计的行为**，所以下面给的是"一个可选语义 + 一个上游修法方向"，不是 bug 断言。

## 机制已确认，并且源码把它写成有意的

`packages/todo/tool-todo/src/index.ts:130-145`，连同它自己的注释：

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

而工具描述本身就叫模型"每次发送完整清单"。所以"每轮重写"是既定契约，不是漏了兜底。

**真正的问题是中断这种情形没有出口**：下一个 `turn/start` 照样清空，而 `todo_write`（`:203-222`）只追加 `todo/write` 快照并返回计数，**没有任何读回途径**。计划并没有丢——它以 `todo/write` 事件的形式 durable 地留在日志里——但界面拿不到，模型也恢复不了。这一条我补的就是这个"读不回"的事实：原条目写的是"投影永久消失"，更准确的杀伤力在于**连模型都无法取回**。

## 复现：真实会话上的受控 A/B

难点是插件只在"`todo/write` 之后又出现 `turn/start`"时才动作，而单个 headless 回合永远是 `turn/start → todo/write → turn/end`，且 headless 没有 `--resume`、跑不出第二个回合。解法：让桩把 **`create_goal` 作为第二个工具调用**，`goal-round-driver` 就会自动进入第二轮，产生**真实的**第二个 `turn/start`。

两次运行内容完全相同，唯一差别是装没装插件；都用**真正的** `todos` 投影定义折叠（该定义没有单独导出、写在 `apply()` 里，所以是调用真实 `apply()` 用一个假注册表把它抓出来）：

**无插件**（折叠终态 `null`）：

```
turn/start#4 → todo/write#24 → turn/end#47 → turn/start#49 → turn/end#51
```

**装插件**（折叠终态为该 3 项清单）：

```
turn/start#4 → todo/write#24 → turn/end#47 → turn/start#49 → todo/write#51 → turn/end#52
```

**为什么多出来的事件是插件造成的**：`todo/write#51` 前面**只有** `turn/start#49`，没有 `tool/call`、没有 `tool/result`；而模型自己那次 `todo/write#24` 前面明确有 `tool/call#22`（`name: "todo_write"`）和配对的 `tool/result#25`。对照组——同样的桩、同样的提示、只是没装插件——**完全没有**这条事件。

## 接缝：不用 fork

插件**换不掉**投影：注册表对重复 key 只在 `stateVersion` 相同时引用计数，不同直接抛错（`session-projection/src/index.ts:276-283`），所以第一个定义永远获胜（`tool-todo` 已占用 `todos` @ v2）。但投影是**日志的纯函数**，而注册表正是在 `session/event` 上驱动它（`:220-222`）——所以**补上折叠所反应的那条事件**就够了：记住每个会话最后一份 `todo/write` 清单，当 `turn/start` 到来且那份清单仍有未完成项时，把同样内容再追加一条。范围刻意收窄：只管未完成的清单、每次回合开始最多补一条、失败即放行。

**一个实现上的坑，值得写下来**：不能在 `session/event` 监听器里同步 append。`Session.append` 在向监听器发布事件时自己的接收边界仍然开着，并明确拒绝重入：

```ts
// core/session/src/index.ts:729-731
if (entry?.appending) {
  throw new Error('session append cannot reenter while another append is being published')
}
```

顺序是 `:742` 置位 → `:752` 调用 `session/event` 监听器 → `:757`（`finally`）复位。监听器正在那个窗口里，同步追加每次都会抛错。必须延后一拍（如 `queueMicrotask`）——否则一个"失败即放行"的插件会**一声不响地什么都不做**，而这和"清单本来就全做完了"在行为上完全无法区分。

插件与原始输出：https://github.com/apex-mochen/dsh-todo-continuity

## 给上游的修法方向（与 #6524 的方向一致）

`turn/start` **仅当清单全部 `completed` 才清空**，未完成清单跨回合保留；已完成清单行为与上游一致。**并且必须同时 bump `stateVersion` 2→3**：投影在本机有持久检查点，ver 不匹配才会丢弃重折叠，不 bump 的话已中断会话里旧的 `null` 检查点会继续生效。

## 请一并保留的边界

- 这是**语义主张**，不是缺陷断言。若维护者认为"每轮由模型重写"就是要的契约，那么这个插件只是一个可选的替代语义，治本方案也不成立——这也是为什么它不该被写成"DSH 的 bug"。
- 插件是**预防/恢复**性质的投影修正，不改变 `todo/write` 事件本身，模型仍按原契约每轮重写。
