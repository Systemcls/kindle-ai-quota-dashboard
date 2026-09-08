'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT } = require('../src/lib/config.cjs');

function refresh() {
  for (const script of ['src/collect.cjs', 'scripts/build-site.cjs']) {
    const result = spawnSync(process.execPath, [path.join(ROOT, script)], {
      cwd: ROOT, stdio: 'inherit', windowsHide: true, timeout: 90000,
    });
    if (result.error || result.status !== 0) {
      process.stderr.write('本轮更新失败，保留上次页面。\n');
      return false;
    }
  }
  return true;
}

function tick() {
  const ok = refresh();
  if (process.argv.includes('--watch')) setTimeout(tick, 3 * 60 * 1000);
  else if (!ok) process.exitCode = 1;
}

tick();
