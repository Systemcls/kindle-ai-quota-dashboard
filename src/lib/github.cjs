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
    if (process.env.GITHUB_PROXY) {
      // curl reads authentication from stdin, never command arguments or a credential file.
      const options = {
        url: 'https://api.github.com/' + route, request: method, proxy: process.env.GITHUB_PROXY,
        'connect-timeout': '10', 'max-time': '30', 'write-out': '\n%{http_code}',
      };
      const config = Object.entries(options).map(([key, value]) => `${key} = ${JSON.stringify(value)}`);
      for (const header of ['Authorization: Bearer ' + token, 'Accept: application/vnd.github+json',
        'Content-Type: application/json', 'User-Agent: kindle-ai-quota-dashboard', 'X-GitHub-Api-Version: 2026-03-10']) {
        config.push('header = ' + JSON.stringify(header));
      }
      if (body !== undefined) config.push('data-binary = ' + JSON.stringify(JSON.stringify(body)));
      config.push('silent', 'show-error');
      const result = spawnSync(process.platform === 'win32' ? 'curl.exe' : 'curl', ['--config', '-'], {
        input: config.join('\n') + '\n', encoding: 'utf8', windowsHide: true, timeout: 35000, maxBuffer: 4 * 1024 * 1024,
      });
      if (result.error || result.status !== 0) throw new Error('GitHub 代理连接失败，请检查本地代理是否运行');
      const split = result.stdout.lastIndexOf('\n');
      const status = Number(result.stdout.slice(split + 1));
      if (status < 200 || status >= 300) {
        const error = new Error(`GitHub ${method} 请求失败（HTTP ${status}）`);
        error.status = status; throw error;
      }
      return status === 204 ? null : JSON.parse(result.stdout.slice(0, split));
    }
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
