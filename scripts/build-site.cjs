'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../src/lib/config.cjs');
const { writeAtomic } = require('../src/lib/common.cjs');

const webDir = path.join(ROOT, 'web');
const stateDir = path.join(ROOT, 'state');
const distDir = path.join(ROOT, 'dist');
const required = ['index.html', 'dashboard-runtime.js'];

for (const name of required) {
  const source = path.join(webDir, name);
  if (!fs.existsSync(source)) throw new Error(`缺少网页文件：${source}`);
}
for (const name of ['data.json', 'data.js']) {
  const source = path.join(stateDir, name);
  if (!fs.existsSync(source)) {
    throw new Error(`缺少 ${source}。先运行 npm run demo 或 npm run collect`);
  }
}

fs.mkdirSync(distDir, { recursive: true });
for (const name of required) {
  writeAtomic(path.join(distDir, name), fs.readFileSync(path.join(webDir, name)));
}
for (const name of ['data.json', 'data.js']) {
  writeAtomic(path.join(distDir, name), fs.readFileSync(path.join(stateDir, name)));
}
const weatherFile = path.join(stateDir, 'weather.js');
writeAtomic(path.join(distDir, 'weather.js'), fs.existsSync(weatherFile)
  ? fs.readFileSync(weatherFile) : 'window.DASH_WEATHER = null;\n');
const endpoint = process.env.DASHBOARD_URL
  ? process.env.DASHBOARD_URL.replace(/\/+$/, '') + '/data.js'
  : 'data.js';
writeAtomic(path.join(distDir, 'live-endpoint.js'),
  `window.DASH_LIVE_ENDPOINT = ${JSON.stringify(endpoint)};\n`);
fs.writeFileSync(path.join(distDir, '.nojekyll'), '', 'utf8');
process.stdout.write(`built ${distDir}\n`);
