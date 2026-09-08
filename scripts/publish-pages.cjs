'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT } = require('../src/lib/config.cjs');
const { loadLocalEnv } = require('../src/lib/local-env.cjs');
const { validateSnapshot } = require('../src/collect.cjs');
const { createGitHubClient } = require('../src/lib/github.cjs');

const FILES = ['index.html', 'dashboard-runtime.js', 'data.json', 'data.js', 'live-endpoint.js', '.nojekyll'];

function git(args, cwd = ROOT) {
  const result = spawnSync('git', ['-c', `safe.directory=${cwd.replace(/\\/g, '/')}`, ...args], {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 90000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  });
  if (result.error || result.status !== 0) throw new Error(`Git ${args[0]} 失败，请检查登录、网络或分支状态`);
  return result.stdout.trim();
}

function publicSnapshot(input) {
  validateSnapshot(input);
  if (input.mode !== 'live') throw new Error('只发布真实采集结果，请先运行 npm run refresh');
  const data = { mode: 'live', updatedAt: input.updatedAt, weather: {}, quote: null, sources: {} };
  for (const key of ['ok', 'description', 'iconKey', 'tempC', 'feelsLikeC', 'humidity', 'windKph', 'windDir', 'place', 'observedAt', 'fetchedAt', 'stale']) {
    if (input.weather[key] !== undefined) data.weather[key] = input.weather[key];
  }
  if (input.quote && input.quote.text) data.quote = {
    text: String(input.quote.text).slice(0, 180), source: String(input.quote.source || '').slice(0, 80),
  };
  for (const name of ['claude', 'codex', 'kimi', 'deepseek', 'glm']) {
    const source = input.sources[name];
    const target = { ok: source.ok, label: source.label, fetchedAt: source.fetchedAt,
      stale: !!source.stale, disabled: !!source.disabled, needsSetup: !!source.needsSetup,
      error: source.ok ? null : source.needsSetup ? '请在电脑配置密钥' : source.disabled ? '未启用' : '本轮采集失败',
    };
    if (name === 'deepseek') {
      target.balance = source.balance;
      target.currency = source.currency;
    } else {
      target.windows = source.windows.map(item => ({ name: item.name, usedPct: item.usedPct, resetAt: item.resetAt }));
    }
    data.sources[name] = target;
  }
  return data;
}

function prepareFiles(dist, secrets = []) {
  const data = publicSnapshot(JSON.parse(fs.readFileSync(path.join(dist, 'data.json'), 'utf8')));
  const json = JSON.stringify(data, null, 2);
  const files = {
    'index.html': fs.readFileSync(path.join(dist, 'index.html'), 'utf8'),
    'dashboard-runtime.js': fs.readFileSync(path.join(dist, 'dashboard-runtime.js'), 'utf8'),
    'data.json': json + '\n',
    'data.js': 'window.DASH_DATA = ' + json + ';\n',
    'live-endpoint.js': 'window.DASH_LIVE_ENDPOINT = "data.js";\n',
    '.nojekyll': '',
  };
  for (const content of Object.values(files)) {
    if (secrets.some(secret => secret && content.includes(secret))) throw new Error('发布内容包含本地凭据，已停止上传');
  }
  return files;
}

async function publishFiles(api, repo, files) {
  if (Object.keys(files).some(name => !FILES.includes(name)) || FILES.some(name => !(name in files))) {
    throw new Error('发布文件列表不匹配');
  }
  const base = `repos/${repo}/git`;
  let head = null;
  let oldTree = null;
  try { head = (await api(`${base}/ref/heads/gh-pages`)).object.sha; }
  catch (error) { if (error.status !== 404) throw error; }
  if (head) {
    oldTree = (await api(`${base}/commits/${head}`)).tree.sha;
    const existing = await api(`${base}/trees/${oldTree}`);
    if (existing.truncated || existing.tree.some(item => !FILES.includes(item.path) || item.type !== 'blob')) {
      throw new Error('gh-pages 存在预期外文件，已停止自动发布');
    }
  }
  const tree = await api(`${base}/trees`, 'POST', {
    tree: Object.entries(files).map(([name, content]) => ({ path: name, mode: '100644', type: 'blob', content })),
  });
  if (tree.sha === oldTree) return head;
  const commit = await api(`${base}/commits`, 'POST', { message: 'Update dashboard snapshot', tree: tree.sha, parents: head ? [head] : [] });
  if (head) await api(`${base}/refs/heads/gh-pages`, 'PATCH', { sha: commit.sha, force: false });
  else await api(`${base}/refs`, 'POST', { ref: 'refs/heads/gh-pages', sha: commit.sha });
  return commit.sha;
}

async function main() {
  loadLocalEnv();
  fs.mkdirSync(path.join(ROOT, 'state'), { recursive: true });
  const lock = path.join(ROOT, 'state', 'pages-publish.lock');
  let locked = false;
  try {
    fs.closeSync(fs.openSync(lock, 'wx'));
    locked = true;
    if (process.argv.includes('--refresh')) {
      const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'refresh.cjs')], {
        cwd: ROOT, stdio: 'inherit', windowsHide: true, timeout: 120000,
      });
      if (result.error || result.status !== 0) throw new Error('采集失败，未发布');
    }
    const remote = git(['remote', 'get-url', 'origin']);
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(remote)) {
      throw new Error('origin 必须是未包含凭据的 GitHub HTTPS 仓库地址');
    }
    const secrets = Object.entries(process.env)
      .filter(([name]) => /(?:API_KEY|TOKEN|PASSWORD|SECRET)$/i.test(name))
      .map(([, value]) => value).filter(Boolean);
    const files = prepareFiles(path.join(ROOT, 'dist'), secrets);
    const repo = remote.slice('https://github.com/'.length).replace(/\.git$/, '');
    await publishFiles(createGitHubClient(), repo, files);
    console.log('已推送网页和额度快照，等待 GitHub Pages 更新。');
  } finally {
    if (locked) fs.unlinkSync(lock);
  }
}

if (require.main === module) mainWrapper();
async function mainWrapper() {
  try { await main(); } catch (error) {
    console.error(error.code === 'EEXIST' ? '已有发布任务运行，跳过本轮。' : error.message);
    process.exitCode = 1;
  }
}

module.exports = { publicSnapshot, prepareFiles, publishFiles, FILES };
