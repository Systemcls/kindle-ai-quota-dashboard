'use strict';

const { failedWindows, fetchJson, isoBeijing, round1 } = require('../lib/common.cjs');

// Endpoint and Authorization format follow zai-org/zai-coding-plugins.
// Restrict credentials to the explicitly selected provider's official origin.
const ORIGINS = { bigmodel: 'https://open.bigmodel.cn', zai: 'https://api.z.ai' };

function numeric(value) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function windowName(item) {
  const count = numeric(item.number);
  const unit = numeric(item.unit);
  if (count > 0) {
    if (unit === 3) return `${count}小时`;
    if (unit === 6) return count === 1 ? '周' : `${count}周`;
    if (unit === 5) return item.type === 'TIME_LIMIT' ? 'MCP 月额度' : `${count}月`;
  }
  if (unit == null && item.type === 'TOKENS_LIMIT') return '5小时';
  if (unit == null && item.type === 'TIME_LIMIT') return 'MCP 月额度';
  return '套餐额度';
}

function parseGlmQuota(payload) {
  if (!payload || payload.success === false ||
      (payload.code != null && ![0, 200].includes(Number(payload.code)))) {
    throw new Error('GLM 额度查询被拒绝，请检查密钥和所属平台');
  }
  const data = payload.data || payload;
  if (!Array.isArray(data.limits)) throw new Error('GLM 响应缺少额度窗口');
  const windows = [];
  for (const item of data.limits) {
    if (!item || !['TOKENS_LIMIT', 'CREDIT_LIMIT', 'TIME_LIMIT'].includes(item.type)) continue;
    let used = numeric(item.percentage);
    if (used == null) {
      const total = numeric(item.usage);
      const current = numeric(item.currentValue);
      if (total > 0 && current != null && current >= 0) used = current / total * 100;
    }
    if (used == null || used < 0 || used > 100) continue;
    const reset = numeric(item.nextResetTime);
    windows.push({
      name: windowName(item),
      usedPct: round1(used),
      resetAt: reset > 0 ? isoBeijing(reset < 1e12 ? reset * 1000 : reset) : null,
    });
  }
  if (!windows.length) throw new Error('GLM 未返回有效用量，请确认已开通 Coding Plan');
  return windows;
}

async function collectGlm(config = {}) {
  const fetchedAt = isoBeijing();
  if (!config.enabled) return { ...failedWindows('GLM', '未启用', fetchedAt), disabled: true };
  const key = String(process.env[config.apiKeyEnv || 'GLM_API_KEY'] || '').trim();
  if (!key) return { ...failedWindows('GLM', '请配置 GLM Coding Plan 密钥', fetchedAt), needsSetup: true };
  try {
    const platform = process.env.GLM_PLATFORM || config.platform || 'bigmodel';
    if (!Object.prototype.hasOwnProperty.call(ORIGINS, platform)) throw new Error('GLM 平台应为 bigmodel 或 zai');
    const payload = await fetchJson(`${ORIGINS[platform]}/api/monitor/usage/quota/limit`, {
      headers: { Authorization: key, 'Content-Type': 'application/json', 'Accept-Language': 'en-US,en' },
      timeoutMs: Number(config.timeoutMs || 20000),
      redirect: 'error',
    });
    return { ok: true, label: 'GLM', windows: parseGlmQuota(payload), fetchedAt, error: null };
  } catch (error) {
    // Do not publish provider error bodies (they may echo authentication material).
    const message = String(error.message || '');
    return failedWindows('GLM', message.startsWith('GLM ')
      ? message : 'GLM 查询失败，请检查网络、密钥与平台设置', fetchedAt);
  }
}

module.exports = { collectGlm, parseGlmQuota, windowName };
