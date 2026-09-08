'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Single-line dotenv values only; no shell expansion or command execution.
function loadLocalEnv(file = path.resolve(__dirname, '../../.env'), env = process.env) {
  if (!fs.existsSync(file)) return;
  for (const [index, line] of fs.readFileSync(file, 'utf8').split(/\r?\n/).entries()) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    const match = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) throw new Error(`.env 第 ${index + 1} 行格式错误`);
    let value = match[2];
    if (value.startsWith('"') || value.startsWith("'")) {
      if (value.length < 2 || value.at(-1) !== value[0]) throw new Error(`.env 第 ${index + 1} 行引号未闭合`);
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    if (env[match[1]] == null) env[match[1]] = value;
  }
}

module.exports = { loadLocalEnv };
