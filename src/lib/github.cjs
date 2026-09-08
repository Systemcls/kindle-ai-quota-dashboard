'use strict';

const { spawnSync } = require('node:child_process');
const { ROOT } = require('./config.cjs');

function createGitHubClient() {
  const result = spawnSync('git', ['-c', `safe.directory=${ROOT.replace(/\\/g, '/')}`, 'credential', 'fill'], {
    cwd: ROOT, input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', windowsHide: true,
    timeout: 30000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  });
  const match = result.stdout && result.stdout.match(/^password=(.*)$/m);
  if (result.error || result.status !== 0 || !match) throw new Error('请先在此电脑登录 GitHub');
  const token = match[1].trim();
  return async function github(route, method = 'GET', body) {
    if (!/^repos\/[\w.-]+\/[\w.-]+(?:\/|$)/.test(route)) throw new Error('无效的 GitHub 仓库接口路径');
    let response;
    try {
      response = await fetch('https://api.github.com/' + route, {
        method, redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json', 'User-Agent': 'kindle-ai-quota-dashboard', 'X-GitHub-Api-Version': '2026-03-10' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch { throw new Error('GitHub 接口连接失败，请稍后重试'); }
    if (!response.ok) {
      const error = new Error(`GitHub ${method} 请求失败（HTTP ${response.status}）`);
      error.status = response.status;
      throw error;
    }
    if (response.status === 204) return null;
    return response.json();
  };
}

module.exports = { createGitHubClient };
