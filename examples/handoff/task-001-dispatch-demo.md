# task-001-dispatch · 示例派单：复核一份上游清单

> 派单方：agent-A　　承接方：agent-B
> 授权依据：示例文件，无真实授权。
> 效力口径：只允许在本目录写 `task-001-receipt.md`。

## 0. 硬边界

1. 只允许本目录内新增 `task-001-receipt.md`；不修改任何既有文件。
2. 不安装、不下载、不执行任何生产动作。
3. 无法完成的项如实标 `UNABLE`。

## 1. 任务

| 项 | 内容 | 预期 |
|---|---|---|
| M1 | 复算 `data/` 下每个文件的 SHA256 | 与 `data/SHA256SUMS.txt` 逐条一致，报失配数 |
| M2 | 检查上游文件是否被改写 | 任何 FAIL 立即上报 |

## 2. 回执要求

按 `docs/protocol.md` 第 3 节：`task_id` / `executor` / `model_id` / `overall` +
逐项表（结论 + 证据 + SHA256）。
