'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT } = require('../src/lib/config.cjs');
const { loadLocalEnv } = require('../src/lib/local-env.cjs');
const { validateSnapshot } = require('../src/collect.cjs');

const FILES = ['index.html', 'dashboard-runtime.js', 'data.json', 'data.js', 'live-endpoint.js', '.nojekyll'];
const checkout = path.join(ROOT, 'state', 'pages-publish');

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

function main() {
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
    fs.mkdirSync(checkout, { recursive: true });
    if (!fs.existsSync(path.join(checkout, '.git'))) {
      git(['init', '--quiet'], checkout);
      git(['remote', 'add', 'origin', remote], checkout);
    }
    if (git(['remote', 'get-url', 'origin'], checkout) !== remote) throw new Error('发布目录的远程仓库不匹配');
    const remoteHead = git(['ls-remote', '--heads', 'origin', 'gh-pages'], checkout);
    if (remoteHead) {
      git(['fetch', '--quiet', 'origin', 'gh-pages'], checkout);
      const localHead = git(['branch', '--list', 'gh-pages'], checkout);
      if (localHead) {
        git(['checkout', 'gh-pages'], checkout);
        git(['merge', '--ff-only', 'FETCH_HEAD'], checkout);
      } else git(['checkout', '-b', 'gh-pages', 'FETCH_HEAD'], checkout);
    } else if (!git(['branch', '--list', 'gh-pages'], checkout)) {
      git(['checkout', '--orphan', 'gh-pages'], checkout);
    }
    const tracked = git(['ls-files'], checkout).split('\n').filter(Boolean);
    if (tracked.some(file => !FILES.includes(file))) throw new Error('gh-pages 存在预期外文件，已停止自动发布');
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(checkout, name), content);
    git(['add', '--', ...FILES], checkout);
    if (git(['diff', '--cached', '--name-only'], checkout)) {
      const userName = git(['config', 'user.name']);
      const userEmail = git(['config', 'user.email']);
      git(['-c', `user.name=${userName}`, '-c', `user.email=${userEmail}`, 'commit', '-m', 'Update dashboard snapshot'], checkout);
    }
    git(['push', 'origin', 'HEAD:refs/heads/gh-pages'], checkout);
    console.log('已推送网页和额度快照，等待 GitHub Pages 更新。');
  } finally {
    if (locked) fs.unlinkSync(lock);
  }
}

if (require.main === module) mainWrapper();
function mainWrapper() {
  try { main(); } catch (error) {
    console.error(error.code === 'EEXIST' ? '已有发布任务运行，跳过本轮。' : error.message);
    process.exitCode = 1;
  }
}

module.exports = { publicSnapshot, prepareFiles, FILES };
