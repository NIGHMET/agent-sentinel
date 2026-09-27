#!/usr/bin/env node
/**
 * agent-sentinel · watch.mjs
 *
 * 零依赖目录哨兵：轮询一个或多个目录，把每一次文件级变化（相对路径 + 字节 + mtime）
 * 追加到变更日志；配合 --exit-on-change 可在捕获到变化后主动退出，
 * 让宿主工具用「进程结束」当作唤醒信号去叫醒 AI 代理——这是绕开平台调度
 * 最小粒度限制（很多平台最低 1 小时）拿到近实时接手的唯一办法。
 *
 * 用法:
 *   node scripts/watch.mjs --dir <路径> [--dir <路径>...] \
 *        [--interval 30] [--hours 12] [--out <日志文件>] \
 *        [--ignore <子串>...] [--exit-on-change] [--json]
 *
 * 行为:
 *   - 首帧只建基线，不报差异
 *   - 之后每 interval 秒递归比对一次（相对路径 | 字节 | mtimeMs）
 *   - 差异（新增 / 删除 / 修改）立刻追加到 --out，并打到 stdout
 *   - 跑满 hours 小时，写一行 SENTINEL_TIMEOUT 后退出
 *
 * 时间戳口径：日志与 stdout 一律写**本地时间 + 时区偏移**
 * （例：2026-09-27 12:10:03+08:00）。不要改用 toISOString()，
 * 那是 UTC，会让"日志时间明显早于现在 = 已掉线"这条判据在 UTC+8 下恒误判。
 *
 * 为什么用轮询而不是 fs.watch：Windows 上对递归目录的 fs.watch 会漏事件、
 * 还会占住目录句柄。轮询笨，但跨平台准。
 */

import fs from 'node:fs';
import path from 'node:path';

const VERSION = '1.0.0';

const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`agent-sentinel watch v${VERSION}

用法:
  node scripts/watch.mjs --dir <路径> [--dir <路径>...] [选项]

选项:
  --dir <路径>        要监听的目录，可重复。必填，至少一个。
  --interval <秒>     轮询间隔，默认 30。
  --hours <小时>      自动退出时限，默认 12。跑满写 SENTINEL_TIMEOUT 后退出。
  --out <文件>        变更日志路径。省略则只打到 stdout。
  --ignore <子串>     相对路径命中该子串则跳过，可重复。日志文件自身自动忽略。
  --exit-on-change    捕获到第一批差异后写日志并退出（用进程结束当唤醒信号）。
  --json              stdout 以 JSON Lines 输出，便于程序消费（--out 仍写 markdown）。
  -h, --help          显示本帮助。
  -v, --version       显示版本。

示例:
  node scripts/watch.mjs --dir ./inbox --interval 30 --hours 8 --out ./sentinel.log
  node scripts/watch.mjs --dir ./inbox --exit-on-change --out ./sentinel.log
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
const interval = Number(getOne('interval', '30'));
const hours = Number(getOne('hours', '12'));
const outFile = getOne('out', '');
const exitOnChange = argv.includes('--exit-on-change');
const jsonMode = argv.includes('--json');

const ignore = getList('ignore');
// 日志文件自身必须排除，否则每 tick 都会报一次 [CHANGED] 自噪声。
if (outFile) ignore.push(path.basename(outFile));
ignore.push('.git/');
ignore.push('node_modules/');

if (!dirs.length || !Number.isFinite(interval) || interval <= 0 || !Number.isFinite(hours) || hours <= 0) {
  process.stderr.write(
    'USAGE: node scripts/watch.mjs --dir <路径> [--dir <路径>...] ' +
    '[--interval 30] [--hours 12] [--out <文件>] [--ignore <子串>...] [--exit-on-change] [--json]\n'
  );
  process.exit(2);
}

// 本地时间 + 时区偏移（不要用 toISOString：那是 UTC）
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
         `${sign}${p(Math.floor(a / 60))}:${p(a % 60)}`;
};

function walk(root) {
  const map = new Map();
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let ents;
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const full = path.join(cur, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (ignore.some((s) => rel.includes(s))) continue;
      if (e.isDirectory()) { stack.push(full); continue; }
      if (!e.isFile()) continue;
      try {
        const st = fs.statSync(full);
        map.set(rel, `${st.size}|${Math.floor(st.mtimeMs)}`);
      } catch { /* 正在被写入，下一帧再看 */ }
    }
  }
  return map;
}

function snap() {
  const m = new Map();
  for (const d of dirs) for (const [k, v] of walk(d)) m.set(`${d}>${k}`, v);
  return m;
}

function writeOut(text) {
  if (!outFile) return;
  try {
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    fs.appendFileSync(outFile, text, 'utf8');
  } catch (e) {
    process.stderr.write(`[${stamp()}] WRITE_FAIL ${e.message}\n`);
  }
}

function emit(lines) {
  writeOut(lines.join('\n') + '\n');
  if (!jsonMode) process.stdout.write(lines.join('\n') + '\n');
}

if (outFile) {
  writeOut(
    `\n## SENTINEL_START ${stamp()} interval=${interval}s hours=${hours} pid=${process.pid}\n` +
    dirs.map((d) => `- WATCH: ${d}`).join('\n') + '\n'
  );
}
process.stdout.write(
  `[${stamp()}] SENTINEL_START pid=${process.pid} interval=${interval}s hours=${hours} dirs=${dirs.length}\n`
);

let base = snap();
process.stdout.write(`[${stamp()}] BASELINE files=${base.size}\n`);

const deadline = Date.now() + hours * 3600 * 1000;
let ticks = 0;

const timer = setInterval(() => {
  ticks++;
  if (Date.now() >= deadline) {
    emit([`\n## SENTINEL_TIMEOUT ${stamp()} ticks=${ticks} — 跑满 ${hours}h 自动退出，需重挂`]);
    clearInterval(timer);
    process.exit(0);
  }
  let now;
  try { now = snap(); } catch (e) {
    process.stderr.write(`[${stamp()}] SNAP_FAIL ${e.message}\n`);
    return;
  }

  const changes = [];
  for (const [k, v] of now) {
    if (!base.has(k)) changes.push({ kind: 'NEW', key: k, value: v });
    else if (base.get(k) !== v) changes.push({ kind: 'CHANGED', key: k, from: base.get(k), to: v });
  }
  for (const k of base.keys()) if (!now.has(k)) changes.push({ kind: 'DELETED', key: k });

  if (changes.length) {
    const md = changes.map((c) =>
      c.kind === 'CHANGED' ? `- [CHANGED] ${c.key}  (${c.from} -> ${c.to})`
                           : `- [${c.kind}]${' '.repeat(6 - c.kind.length)} ${c.key}` +
                             (c.value ? `  (${c.value})` : '')
    );
    writeOut(`\n## CHANGE ${stamp()} tick=${ticks} diff=${changes.length}\n${md.join('\n')}\n`);
    if (jsonMode) {
      process.stdout.write(JSON.stringify({
        ts: stamp(), tick: ticks, diff: changes.length, changes
      }) + '\n');
    } else {
      process.stdout.write(`## CHANGE ${stamp()} tick=${ticks} diff=${changes.length}\n${md.join('\n')}\n`);
    }
    if (exitOnChange) {
      writeOut(`\n## SENTINEL_TRIGGERED ${stamp()} — 捕获差异后主动退出，` +
               `请以此进程结束为唤醒信号，处理完再重挂\n`);
      clearInterval(timer);
      process.exit(0);
    }
  }
  base = now;
}, interval * 1000);

const bye = (sig) => {
  emit([`\n## SENTINEL_STOP ${stamp()} ${sig}`]);
  process.exit(0);
};
process.on('SIGINT', () => bye('手动/信号终止 (SIGINT)'));
process.on('SIGTERM', () => bye('手动/信号终止 (SIGTERM)'));
