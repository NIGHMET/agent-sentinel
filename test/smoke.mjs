#!/usr/bin/env node
/**
 * agent-sentinel · 冒烟自测
 *
 * 不依赖任何测试框架，也不依赖网络：在临时目录里真跑一遍两个脚本，断言行为。
 *   node test/smoke.mjs
 *
 * 覆盖：
 *   1. watch.mjs --help / --version 正常
 *   2. watch.mjs 建基线 + 捕获 [NEW] + --exit-on-change 主动退出
 *   3. 日志文件自身不产生自噪声（不出现对日志自己的 [CHANGED]）
 *   4. patrol.mjs 正确识别「有派单无回执」
 *   5. 回执补齐后 patrol.mjs 判为已认领
 *   6. patrol.mjs --json 与 --fail-if-found 的退出码
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const WATCH = path.join(root, 'scripts', 'watch.mjs');
const PATROL = path.join(root, 'scripts', 'patrol.mjs');

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; console.log(`  PASS  ${name}`); };
const bad = (name, detail) => { fail++; console.log(`  FAIL  ${name}${detail ? ' :: ' + detail : ''}`); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sentinel-'));
const watchDir = path.join(tmp, 'handoff');
fs.mkdirSync(watchDir, { recursive: true });
const logPath = path.join(tmp, 'sentinel.log');

function run(args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('exit', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`agent-sentinel smoke test  (node ${process.version})\n临时目录: ${tmp}\n`);

  // 1. --help / --version
  const help = await run([WATCH, '--help']);
  if (help.code === 0 && /--exit-on-change/.test(help.out)) ok('watch.mjs --help');
  else bad('watch.mjs --help', `code=${help.code}`);

  const ver = await run([WATCH, '--version']);
  if (ver.code === 0 && /\d+\.\d+\.\d+/.test(ver.out)) ok('watch.mjs --version');
  else bad('watch.mjs --version', `code=${ver.code} out=${ver.out.trim()}`);

  const badArgs = await run([WATCH]);
  if (badArgs.code === 2) ok('无 --dir 时报用法错误并退出码 2');
  else bad('无 --dir 时报用法错误并退出码 2', `code=${badArgs.code}`);

  // 2~3. 真跑一次带 --exit-on-change 的哨兵
  const child = spawn(process.execPath, [
    WATCH, '--dir', watchDir, '--interval', '1', '--hours', '0.05',
    '--exit-on-change', '--out', logPath
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let sout = '';
  child.stdout.on('data', (d) => { sout += d.toString(); });
  child.stderr.on('data', (d) => { sout += d.toString(); });

  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));

  // 等基线出现
  for (let i = 0; i < 50 && !/BASELINE files=/.test(sout); i++) await sleep(100);
  if (/SENTINEL_START pid=\d+/.test(sout) && /BASELINE files=0/.test(sout)) ok('哨兵启动并建立基线');
  else bad('哨兵启动并建立基线', sout.split('\n').slice(0, 3).join(' | '));

  // 制造差异
  await sleep(300);
  fs.writeFileSync(path.join(watchDir, 'task-001-dispatch-demo.md'), '# 派单\n');
  await sleep(200);
  fs.writeFileSync(path.join(watchDir, 'ignored.tmp'), 'x\n'); // 顺带确认多次变更被合并成一批

  const code = await Promise.race([exited, sleep(15000).then(() => 'timeout')]);
  if (code === 0) ok('--exit-on-change 在捕获差异后自动退出（退出码 0）');
  else bad('--exit-on-change 在捕获差异后自动退出', `code=${code}`);

  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  if (/\[NEW\]\s+.*task-001-dispatch-demo\.md/.test(log)) ok('变更日志记录到 [NEW]');
  else bad('变更日志记录到 [NEW]', log || '(日志为空)');

  if (/SENTINEL_TRIGGERED/.test(log)) ok('变更日志记录到 SENTINEL_TRIGGERED');
  else bad('变更日志记录到 SENTINEL_TRIGGERED');

  const logName = path.basename(logPath);
  if (!new RegExp(`\\[CHANGED\\][^\\n]*${logName}`).test(log)) ok('日志文件自身无自噪声');
  else bad('日志文件自身无自噪声', '日志里出现对自身的 CHANGED');

  // 时间戳必须是本地时间 + 偏移，不能是裸 UTC
  if (/SENTINEL_START \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/.test(log)) ok('时间戳带时区偏移');
  else bad('时间戳带时区偏移', log.split('\n')[1] || '(no line)');

  // 4. patrol：有派单无回执
  const p1 = await run([PATROL, '--dir', watchDir, '--json']);
  let j1 = null;
  try { j1 = JSON.parse(p1.out); } catch { /* ignore */ }
  if (j1 && j1.pending_total === 1 && j1.dirs[0].pending[0].task_id === 'task-001')
    ok('patrol.mjs 识别出 1 件待领任务（task-001）');
  else bad('patrol.mjs 识别出 1 件待领任务（task-001）', p1.out.trim().slice(0, 300));

  // 5. 补上回执 → 认领完成
  fs.writeFileSync(path.join(watchDir, 'task-001-receipt.md'), '# 回执\n');
  const p2 = await run([PATROL, '--dir', watchDir, '--json']);
  let j2 = null;
  try { j2 = JSON.parse(p2.out); } catch { /* ignore */ }
  if (j2 && j2.pending_total === 0) ok('补齐回执后判定为已认领');
  else bad('补齐回执后判定为已认领', p2.out.trim().slice(0, 300));

  // 6. --fail-if-found 退出码
  const p3 = await run([PATROL, '--dir', watchDir, '--quiet']);
  if (p3.code === 0) ok('无待领任务时退出码 0');
  else bad('无待领任务时退出码 0', `code=${p3.code}`);

  fs.rmSync(path.join(watchDir, 'task-001-receipt.md'), { force: true });
  const p4 = await run([PATROL, '--dir', watchDir, '--quiet', '--fail-if-found']);
  if (p4.code === 10) ok('--fail-if-found 发现待领任务时退出码 10');
  else bad('--fail-if-found 发现待领任务时退出码 10', `code=${p4.code}`);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('SMOKE_TEST_CRASH', e);
  process.exit(1);
});
