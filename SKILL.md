---
name: agent-sentinel
description: 会话内目录哨兵 + 任务巡查，用于多个 AI 代理/进程之间只有文件系统、没有 IPC 的协作场景。轮询指定目录，秒级记录新增/删除/改动；配合 --exit-on-change 可用「进程结束」当唤醒信号，把跨进程接手延迟压到一个轮询间隔。触发词：挂哨兵、盯目录、监听目录、目录监听、watch 目录、任务巡查、有没有新派单、对方落盘我要立刻知道、回执什么时候到、新文件什么时候出现、multi-agent handoff、agent sentinel。
version: 1.0.0
license: MIT
---

# agent-sentinel

## 它解决什么

另一个代理在本机另一个进程/会话里干活，双方只有文件系统、没有 IPC。
想知道"它什么时候写了东西"，靠人盯太累、靠平台定时任务太慢（常见下限 1 小时）。
本技能 = 一个零依赖轮询进程 + 一条巡查命令：

- `scripts/watch.mjs` — **捕获**：秒级发现差异并落日志，可配置成"抓到就退出"。
- `scripts/patrol.mjs` — **判断**：在交接目录里找出「有派单、没回执」的任务，即谁该干活。

## 先把三层说清楚，别混为一谈

| 层 | 粒度 | 谁驱动 | 跨会话存活 | 能主动接手吗 |
|---|---|---|---|---|
| **A. 哨兵轮询**（`watch.mjs`） | 秒级（默认 30s，可 1s） | 后台进程 | ❌ 活在发起它的会话/进程里 | ❌ 只写日志，被唤醒才读 |
| **B. 退出信号**（`--exit-on-change`） | ≈ 一个轮询间隔 | 进程退出 → 宿主通知 | ❌ 每次要重挂 | ✅ 最接近实时的一层 |
| **C. 平台定时任务** | 受平台最小粒度限制（常见 **1 小时**） | 平台调度器 | ✅ 独立存活 | ✅ 真正无人值守 |

**关键是诚实**：A 层负责"捕获"，不负责"唤醒"。所以对外只能说：
**30 秒内记录差异 + 会话内≈1 分钟唤醒（B 层）+ 最长 1 小时内自动接手（C 层）**。
不要说"30 秒自动接手"，那是假的。

## 挂载

```bash
node scripts/watch.mjs \
  --dir "/绝对/路径/handoff" \
  --dir "/绝对/路径/second-dir" \
  --interval 30 --hours 12 \
  --out "/绝对/路径/sentinel.log"
```

要点：

- **路径用绝对路径**。在某些 shell（Git Bash 等）里传 Windows 反斜杠路径会被转换弄坏，用**正斜杠**。
- 宿主支持后台任务时，用它的"后台运行"能力启动本进程，别自己 `nohup` 后立刻返回——
  那样最后一步可能收不到产物。
- 需要"落盘即叫醒我"时加 `--exit-on-change`，并确保你的宿主会在后台任务结束时通知你。
- `--hours` 是自动退出时限：跑满写一行 `SENTINEL_TIMEOUT` 后退出（语义 = 需重挂）。

## 挂完必做的验证（别跳过）

1. 立刻看一眼进程输出：必须出现 `SENTINEL_START pid=...` 和 `BASELINE files=N`。
   只有这两行才算挂上；没有就是没跑起来。
2. 在监听目录里写一个探针文件，等一个 tick，确认日志出现 `[NEW]`。
   **抓不到就别对外说"哨兵已挂"**。
3. 长驻实例（不带 `--exit-on-change`）同样要做活体验证：写探针 → 见 `[NEW]` → 删探针（会留一条 `[DELETED]`）。

## 变更日志长什么样

```markdown
## SENTINEL_START 2026-09-27 12:06:20+08:00 interval=30s hours=12 pid=16260
- WATCH: /abs/path/handoff

## CHANGE 2026-09-27 12:06:24+08:00 tick=2 diff=1
- [NEW]     /abs/path/handoff>task-003-dispatch-review.md  (1024|1790481982616)
- [CHANGED] /abs/path/handoff>x.md  (100|... -> 200|...)
- [DELETED] /abs/path/handoff>y.md
```

`<监听目录>><相对路径>` 的写法是为了多目录时不混淆；括号里是 `字节|mtimeMs`。

**时间戳是本地时间带偏移**，例 `2026-09-27 12:06:24+08:00`。
若你手上是旧版脚本写出的日志（裸 UTC，形如 `03:56:28`），读之前先 +8 再和现在比，
否则会把在线的哨兵误判成"掉线 8 小时"。

## 巡查：谁该干活

```bash
node scripts/patrol.mjs --dir "/绝对/路径/handoff"
node scripts/patrol.mjs --dir "/绝对/路径/handoff" --json --fail-if-found   # 有待领任务时退出码 10
```

默认约定（可用 `--dispatch-re` / `--receipt` 改）：

- 派单：`<task-id>-dispatch-<slug>.md`
- 回执：`<task-id>-receipt.md`
- 同一 task-id **有派单、无回执 ⇒ 未被认领**

字段与写回执的规矩见 `docs/protocol.md`。没有共同约定，光有哨兵也接不上手。

## 已挂实例怎么恢复（新会话/新窗口）

哨兵不跨会话。新会话里说"挂哨兵"时：

0. **先查有没有还活着的实例**——并行会话最容易重复挂，两个哨兵会双写同一份日志：

   ```bash
   ps -ef | grep watch.mjs            # macOS / Linux
   ```

   ```powershell
   Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
     Where-Object { $_.CommandLine -like '*watch.mjs*' } |
     ForEach-Object { $_.ProcessId.ToString() + ' | ' + $_.CreationDate + ' | ' + $_.CommandLine }
   ```

   已有同 `--dir` + `--out` 的实例 → **直接复用，别再挂第二个**。
   （注意：带 `--exit-on-change` 的实例抓一次差异就自退，属预期行为，不算掉线。）

1. 再读日志末尾判断在岗：出现 `SENTINEL_TIMEOUT` ⇒ 跑满时限已退出，需重挂；
   时间戳**注意时区**。别把某个快照当成全程在岗，掉线期间要如实说"未覆盖"。
2. 确认无存活实例后，再按上面的命令重新挂一次。

## 已知坑（都踩过）

- **自噪声**：`--out` 日志文件若落在监听目录里，每 tick 都会报一次 `[CHANGED]`（自己改自己）。
  脚本已自动把日志文件名加入忽略清单；另有其他日志请用 `--ignore <子串>` 追加。
- **不要拿 `fs.watch` 替代轮询**：Windows 上递归监听不可靠（漏事件、句柄占用）。轮询笨但准。
- **别把时间戳改成 `toISOString()`**：那是 UTC，会让"日志时间明显早于现在 = 已掉线"的判据恒误判。
- **有些沙箱里 coreutils 的 PATH 是坏的**：`ls` / `dirname` / `head` 可能全部 not found。
  只用绝对路径调用 node，别在命令里串 shell 工具；建测试文件用写文件工具，不要 `echo >`。
- **宿主可能吞掉 stdout**：所以关键内容一律落 `--out` 文件，读文件而不是读终端；
  Windows PowerShell 里用 `Out-File -Encoding utf8`，默认重定向是 UTF-16LE，会被判成二进制。
- **判断"对方代签/越权"之前先查自己的日志**：本方多会话并行时，很容易把自己在另一个会话做过的活
  误判成对方干的。先读自己的变更日志与工作记录再下结论。
