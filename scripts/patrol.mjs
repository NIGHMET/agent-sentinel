#!/usr/bin/env node
/**
 * agent-sentinel · patrol.mjs
 *
 * 任务巡查：在一个共享交接目录里找出「已派单但还没有回执」的任务，
 * 也就是"谁该干活"。配合 watch.mjs 使用：
 *   - patrol.mjs 回答「现在有没有该我干的活」
 *   - watch.mjs  回答「活什么时候落盘」
 *
 * 约定的文件命名（可改，见 --dispatch-re / --receipt）：
 *   <task-id>-dispatch-<slug>.md   派单
 *   <task-id>-receipt.md           回执
 * 同一 task-id 的派单存在、回执不存在 ⇒ 该任务未被认领。
 *
 * 用法:
 *   node scripts/patrol.mjs --dir <目录> [--dir <目录>...] \
 *        [--dispatch-re <正则，第 1 个捕获组 = task-id>] \
 *        [--receipt <模板，{task} 会被替换>] [--json] [--quiet] [--fail-if-found]
 *
 * 退出码:
 *   0   正常（无论是否找到待领任务）
 *   2   参数错误
 *   10  找到待领任务，且指定了 --fail-if-found（便于 CI / cron 分支）
 */

import fs from 'node:fs';
import path from 'node:path';

const VERSION = '1.0.0';
const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`agent-sentinel patrol v${VERSION}

用法:
  node scripts/patrol.mjs --dir <目录> [--dir <目录>...] [选项]

选项:
  --dir <目录>         要巡查的交接目录，可重复。必填。
  --dispatch-re <正则> 派单文件名正则，第 1 个捕获组必须是 task-id。
                       默认 ^([A-Za-z0-9_.-]+?)-dispatch[^/]*\\.md$
  --receipt <模板>     回执文件名模板，{task} 会被替换为 task-id。
                       默认 {task}-receipt.md
  --json               以 JSON 输出结果。
  --quiet              只输出结论，不输出表头与统计。
  --fail-if-found      发现待领任务时以退出码 10 结束。
  -h, --help           显示本帮助。
  -v, --version        显示版本。

示例:
  node scripts/patrol.mjs --dir ./handoff
  node scripts/patrol.mjs --dir ./handoff --json --fail-if-found
`);
  process.exit(0);
}
if (argv.includes('--version') || argv.includes('-v')) {
  process.stdout.write(VERSION + '\n');
  process.exit(0);
}

function getList(name) {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === `--${name}`) out.push(argv[i + 1]);
  return out.filter(Boolean);
}
function getOne(name, dflt) {
  const v = getList(name);
  return v.length ? v[v.length - 1] : dflt;
}

const dirs = getList('dir').map((d) => path.resolve(d));
const dispatchSrc = getOne('dispatch-re', '^([A-Za-z0-9_.-]+?)-dispatch[^/]*\\.md$');
const receiptTpl = getOne('receipt', '{task}-receipt.md');
const jsonMode = argv.includes('--json');
const quiet = argv.includes('--quiet');
const failIfFound = argv.includes('--fail-if-found');

let dispatchRe;
try {
  dispatchRe = new RegExp(dispatchSrc);
} catch (e) {
  process.stderr.write(`BAD --dispatch-re: ${e.message}\n`);
  process.exit(2);
}
if (!dirs.length) {
  process.stderr.write('USAGE: node scripts/patrol.mjs --dir <目录> [--dir <目录>...] [--json] [--fail-if-found]\n');
  process.exit(2);
}

const results = [];
for (const dir of dirs) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    results.push({ dir, error: e.message, dispatches: 0, claimed: 0, pending: [] });
    continue;
  }
  const files = new Map();
  for (const e of entries) if (e.isFile()) files.set(e.name, e.name);

  const pending = [];
  let dispatches = 0;
  let claimed = 0;
  for (const name of files.keys()) {
    const m = dispatchRe.exec(name);
    if (!m || !m[1]) continue;
    dispatches++;
    const taskId = m[1];
    const receiptName = receiptTpl.replace(/\{task\}/g, taskId);
    if (files.has(receiptName)) { claimed++; continue; }
    let bytes = null;
    try { bytes = fs.statSync(path.join(dir, name)).size; } catch { /* ignore */ }
    pending.push({ task_id: taskId, dispatch: name, receipt_expected: receiptName, dispatch_bytes: bytes });
  }
  results.push({ dir, dispatches, claimed, pending });
}

const totalPending = results.reduce((n, r) => n + r.pending.length, 0);

if (jsonMode) {
  process.stdout.write(JSON.stringify({ pending_total: totalPending, dirs: results }, null, 2) + '\n');
} else if (!quiet) {
  for (const r of results) {
    process.stdout.write(`\n== ${r.dir}\n`);
    if (r.error) { process.stdout.write(`   ERROR: ${r.error}\n`); continue; }
    process.stdout.write(`   派单 ${r.dispatches} 件 / 已有回执 ${r.claimed} 件 / 待领 ${r.pending.length} 件\n`);
    for (const p of r.pending) {
      process.stdout.write(`   [待领] ${p.dispatch}  ->  期望回执 ${p.receipt_expected}` +
                           (p.dispatch_bytes != null ? `  (${p.dispatch_bytes} B)` : '') + '\n');
    }
  }
  process.stdout.write(`\n合计待领：${totalPending} 件\n`);
} else if (totalPending === 0) {
  process.stdout.write('无待领任务\n');
}

process.exit(failIfFound && totalPending > 0 ? 10 : 0);
