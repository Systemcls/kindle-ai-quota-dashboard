'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT, loadConfig } = require('../src/lib/config.cjs');
const { createGitHubClient } = require('../src/lib/github.cjs');

// Only public weather and presentation assets may change in this publisher.
const ASSETS = ['index.html', 'dashboard-runtime.js', 'weather.js'];
const UNCHANGED = ['data.json', 'data.js'];

async function publishWeatherAssets(api, repo, files) {
  if (Object.keys(files).length !== ASSETS.length || ASSETS.some(name => typeof files[name] !== 'string')) {
    throw new Error('天气发布文件列表不匹配');
  }
  const base = `repos/${repo}/git`;
  const head = (await api(`${base}/ref/heads/gh-pages`)).object.sha;
  const oldTree = (await api(`${base}/commits/${head}`)).tree.sha;
  const before = await api(`${base}/trees/${oldTree}`);
  if (before.truncated || UNCHANGED.some(name => !before.tree.find(item => item.path === name))) throw new Error('无法确认已有额度文件');
  const tree = await api(`${base}/trees`, 'POST', { base_tree: oldTree,
    tree: ASSETS.map(name => ({ path: name, mode: '100644', type: 'blob', content: files[name] })),
  });
  const after = await api(`${base}/trees/${tree.sha}`);
  if (after.truncated || UNCHANGED.some(name =>
    before.tree.find(item => item.path === name).sha !== (after.tree.find(item => item.path === name) || {}).sha)) {
    throw new Error('额度文件发生变化，天气发布已停止');
  }
  if (tree.sha === oldTree) return;
  const commit = await api(`${base}/commits`, 'POST', { message: 'Update weather and presentation', tree: tree.sha, parents: [head] });
  await api(`${base}/refs/heads/gh-pages`, 'PATCH', { sha: commit.sha, force: false });
}

async function main() {
  const config = loadConfig();
  const remote = spawnSync('git', ['-c', `safe.directory=${ROOT.replace(/\\/g, '/')}`, 'remote', 'get-url', 'origin'], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true,
  });
  const match = String(remote.stdout || '').trim().match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)$/);
  if (remote.status !== 0 || !match) throw new Error('无法确认 GitHub 目标仓库');
  const files = {
    'index.html': fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8'),
    'dashboard-runtime.js': fs.readFileSync(path.join(ROOT, 'web', 'dashboard-runtime.js'), 'utf8'),
    'weather.js': fs.readFileSync(path.join(config.outputDir, 'weather.js'), 'utf8'),
  };
  const encoded = files['weather.js'].match(/^window\.DASH_WEATHER = (.+);\s*$/);
  const weather = encoded && JSON.parse(encoded[1]);
  const allowed = ['ok', 'description', 'iconKey', 'place', 'tempC', 'feelsLikeC', 'humidity', 'windKph', 'windDir', 'observedAt', 'fetchedAt', 'source', 'error', 'stale'];
  if (!weather || !weather.ok || !Number.isFinite(weather.tempC) || Object.keys(weather).some(key => !allowed.includes(key))) throw new Error('天气文件不完整或包含额外字段');
  await publishWeatherAssets(createGitHubClient(), match[1].replace(/\.git$/, ''), files);
  console.log('天气和网页程序已更新，原有 AI 额度文件未改变。');
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { publishWeatherAssets };
