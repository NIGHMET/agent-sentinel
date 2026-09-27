# 快速上手示例

## 1. 看看有没有该我干的活

```bash
node scripts/patrol.mjs --dir ./examples/handoff
```

预期输出（`task-001` 有派单无回执，`task-002` 已认领）：

```
== /abs/path/examples/handoff
   派单 2 件 / 已有回执 1 件 / 待领 1 件
   [待领] task-001-dispatch-demo.md  ->  期望回执 task-001-receipt.md  (814 B)

合计待领：1 件
```

想让脚本自己表达"有活"这件事（方便 cron / CI 分支）：

```bash
node scripts/patrol.mjs --dir ./examples/handoff --quiet --fail-if-found
echo $?      # 1 件待领 -> 10
```

## 2. 挂上哨兵，等对方落盘

```bash
node scripts/watch.mjs --dir ./examples/handoff --interval 5 --hours 1 --out ./sentinel.log
```

另开一个终端，模拟对方写文件：

```bash
echo "# 回执" > ./examples/handoff/task-001-receipt.md
```

`sentinel.log` 里会出现：

```markdown
## CHANGE 2026-09-27 12:10:04+08:00 tick=2 diff=1
- [NEW]     /abs/path/examples/handoff>task-001-receipt.md  (9|1790482204000)
```

此时再跑一次 `patrol.mjs`，待领数会变成 0 —— 派单已被认领。

## 3. 用「进程退出」当唤醒信号

```bash
node scripts/watch.mjs --dir ./examples/handoff --interval 30 --exit-on-change --out ./sentinel.log
```

把这条命令交给支持"后台任务结束通知"的宿主运行。对方一落盘，进程就退出，
你（或你的代理）会在一个轮询间隔内被叫醒，而不是等下一次定时任务。

处理完记得重挂。完整链路见 [`../docs/protocol.md`](../docs/protocol.md)。
