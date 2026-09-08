'use strict';

const {
  failedBalance,
  fetchJson,
  isoBeijing,
  round1,
} = require('../lib/common.cjs');

async function collectDeepSeek(config = {}) {
  const fetchedAt = isoBeijing();
  if (!config.enabled) {
    return { ...failedBalance('DeepSeek', '未启用', fetchedAt), disabled: true };
  }
  const envName = String(config.apiKeyEnv || 'DEEPSEEK_API_KEY');
  const key = String(process.env[envName] || '').trim();
  if (!key) return { ...failedBalance('DeepSeek', '请配置 DeepSeek API 密钥', fetchedAt), needsSetup: true };
  try {
    const payload = await fetchJson('https://api.deepseek.com/user/balance', {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      redirect: 'error',
    });
    const rows = Array.isArray(payload && payload.balance_infos) ? payload.balance_infos : [];
    const row = rows.find((item) => item && item.currency === 'CNY') || rows[0];
    const balance = row && ['number', 'string'].includes(typeof row.total_balance) && String(row.total_balance).trim() !== ''
      ? Number(row.total_balance) : NaN;
    if (!Number.isFinite(balance)) throw new Error('余额响应缺少 total_balance');
    const currency = String(row.currency || 'CNY');
    return {
      ok: true,
      label: 'DeepSeek',
      balance: round1(balance * 100) / 100,
      currency,
      detail: `余额 ${currency === 'CNY' ? '¥' : `${currency} `}${balance.toFixed(2)}`,
      fetchedAt,
      error: null,
    };
  } catch (error) {
    return failedBalance('DeepSeek', 'DeepSeek 查询失败，请检查网络与 API 密钥', fetchedAt);
  }
}

module.exports = { collectDeepSeek };
