'use strict';

const { spawn } = require('node:child_process');
const {
  clampPct,
  failedWindows,
  isoBeijing,
} = require('../lib/common.cjs');

function readCodexRateLimits(executable, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['app-server', '--listen', 'stdio://'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => finish(new Error('Codex app-server 查询超时')), timeoutMs);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { child.kill(); } catch {}
      if (error) reject(error);
      else resolve(value);
    }

    function send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    child.on('error', finish);
    child.stdin.on('error', finish);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-1200); });
    child.on('exit', (code) => {
      if (!settled) finish(new Error(stderr.trim() || `Codex app-server 提前退出（${code}）`));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      while (stdout.includes('\n')) {
        const end = stdout.indexOf('\n');
        const line = stdout.slice(0, end).trim();
        stdout = stdout.slice(end + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) return finish(new Error(message.error.message || 'Codex 初始化失败'));
          send({ method: 'initialized', params: {} });
          send({ method: 'account/rateLimits/read', id: 2, params: null });
        } else if (message.id === 2) {
          if (message.error) return finish(new Error(message.error.message || 'Codex 额度查询失败'));
          return finish(null, message.result || {});
        }
      }
    });
    send({
      method: 'initialize',
      id: 1,
      params: {
        clientInfo: {
          name: 'kindle-ai-quota-dashboard',
          title: 'Kindle AI 额度中控台',
          version: '0.1.0',
        },
        capabilities: null,
      },
    });
  });
}

function durationName(minutes, fallback) {
  const value = Number(minutes);
  if (value === 300) return '5小时';
  if (value === 10_080) return '周';
  if (value > 0 && value % 10_080 === 0) return `${value / 10_080}周`;
  if (value > 0 && value % 1_440 === 0) return `${value / 1_440}天`;
  if (value > 0 && value % 60 === 0) return `${value / 60}小时`;
  return fallback;
}

async function collectCodex(config = {}) {
  const fetchedAt = isoBeijing();
  if (!config.enabled) {
    return { ...failedWindows('Codex', '未启用', fetchedAt), disabled: true };
  }
  if (config.experimental !== true) {
    return failedWindows('Codex', '必须显式开启 experimental', fetchedAt);
  }
  const envName = String(config.executableEnv || 'CODEX_CLI_PATH');
  const executable = String(process.env[envName] || config.executable || 'codex').trim();
  try {
    const payload = await readCodexRateLimits(executable, Number(config.timeoutMs || 20_000));
    const windows = parseCodexLimits(payload);
    return { ok: true, label: 'Codex', windows, fetchedAt, error: null };
  } catch (error) {
    return failedWindows('Codex', error, fetchedAt);
  }
}

function parseCodexLimits(payload) {
  const byId = payload && payload.rateLimitsByLimitId;
  const bucket = byId && byId.codex || payload && payload.rateLimits;
  if (!bucket) throw new Error('Codex 响应中没有 rateLimits');
  const windows = [];
  for (const [key, fallback] of [['primary', '5小时'], ['secondary', '周']]) {
    const item = bucket[key];
    if (!item || !['number', 'string'].includes(typeof item.usedPercent) ||
        String(item.usedPercent).trim() === '') continue;
    const used = Number(item.usedPercent);
    if (!Number.isFinite(used) || used < 0 || used > 100) continue;
    windows.push({
      name: durationName(item.windowDurationMins, fallback),
      usedPct: clampPct(used),
      resetAt: item.resetsAt ? isoBeijing(Number(item.resetsAt) * 1000) : null,
    });
  }
  if (!windows.length) throw new Error('Codex 响应中没有可识别的额度窗口');
  return windows;
}

module.exports = { collectCodex, durationName, readCodexRateLimits, parseCodexLimits };
