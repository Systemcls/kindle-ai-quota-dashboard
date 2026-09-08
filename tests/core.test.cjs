'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  demoSnapshot,
  preserveLastKnownGood,
  validateSnapshot,
  writeSnapshot,
} = require('../src/collect.cjs');
const { safeError } = require('../src/lib/common.cjs');
const { ROOT, validateConfig } = require('../src/lib/config.cjs');
const { collectProblems } = require('../scripts/check-public.cjs');
const { parseGlmQuota, collectGlm } = require('../src/collectors/glm.cjs');
const { parseCodexLimits } = require('../src/collectors/codex.cjs');
const { collectDeepSeek } = require('../src/collectors/deepseek.cjs');
const { loadLocalEnv } = require('../src/lib/local-env.cjs');
const { parseWeather, collectWeather } = require('../src/collectors/weather.cjs');
const { publishWeatherAssets } = require('../scripts/publish-weather.cjs');
const { publicSnapshot, prepareFiles, publishFiles, FILES } = require('../scripts/publish-pages.cjs');

test('Pages API creates and advances only the website branch without force', async () => {
  for (const exists of [false, true]) {
    const calls = [];
    const api = async (route, method = 'GET', body) => {
      calls.push({ route, method, body });
      if (route.endsWith('/ref/heads/gh-pages')) {
        if (exists) return { object: { sha: 'old-head' } };
        const error = new Error('missing'); error.status = 404; throw error;
      }
      if (route.endsWith('/commits/old-head')) return { tree: { sha: 'old-tree' } };
      if (route.endsWith('/trees/old-tree')) return { tree: FILES.map(name => ({ path: name, type: 'blob' })) };
      if (route.endsWith('/trees') && method === 'POST') return { sha: 'new-tree' };
      if (route.endsWith('/commits') && method === 'POST') return { sha: 'new-head' };
      return {};
    };
    const files = Object.fromEntries(FILES.map(name => [name, 'fixture']));
    assert.equal(await publishFiles(api, 'owner/dashboard', files), 'new-head');
    const commit = calls.find(call => call.route.endsWith('/commits'));
    assert.deepEqual(commit.body.parents, exists ? ['old-head'] : []);
    const update = calls.at(-1);
    assert.equal(update.method, exists ? 'PATCH' : 'POST');
    assert.deepEqual(update.body, exists ? { sha: 'new-head', force: false } : { ref: 'refs/heads/gh-pages', sha: 'new-head' });
  }
});

test('Pages API refuses a branch containing unrelated files', async () => {
  let writes = 0;
  const api = async (route, method = 'GET') => {
    if (method !== 'GET') writes += 1;
    if (route.endsWith('/ref/heads/gh-pages')) return { object: { sha: 'head' } };
    if (route.endsWith('/commits/head')) return { tree: { sha: 'tree' } };
    return { tree: [{ path: 'unrelated.txt', type: 'blob' }] };
  };
  await assert.rejects(publishFiles(api, 'owner/dashboard', Object.fromEntries(FILES.map(name => [name, '']))), /预期外文件/);
  assert.equal(writes, 0);
});

test('Pages publication includes only display files and removes raw account errors', () => {
  const snapshot = demoSnapshot();
  assert.throws(() => publicSnapshot(snapshot), /只发布真实/);
  snapshot.mode = 'live';
  snapshot.sources.codex.error = 'private diagnostic';
  snapshot.sources.codex.accountId = 'private account';
  snapshot.sources.glm.windows[0].accessToken = 'private token';
  const clean = publicSnapshot(snapshot);
  assert.doesNotMatch(JSON.stringify(clean), /private/);
  assert.equal(clean.sources.codex.ok, true);
  assert.equal(clean.sources.glm.windows[0].usedPct, 32);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kindle-pages-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify(snapshot));
    fs.writeFileSync(path.join(dir, 'index.html'), '<html>dashboard</html>');
    fs.writeFileSync(path.join(dir, 'dashboard-runtime.js'), 'window.ready=true;');
    fs.writeFileSync(path.join(dir, '.env'), 'local-only');
    const files = prepareFiles(dir);
    assert.deepEqual(Object.keys(files).sort(), [...FILES].sort());
    assert.equal(files['live-endpoint.js'], 'window.DASH_LIVE_ENDPOINT = "data.js";\n');
    assert.deepEqual(JSON.parse(files['data.json']), clean);
    assert.throws(() => prepareFiles(dir, ['dashboard']), /包含本地凭据/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('demo snapshot passes the public schema', () => {
  const snapshot = demoSnapshot();
  assert.doesNotThrow(() => validateSnapshot(snapshot));
  assert.equal(snapshot.weather.place, '示例城市');
  assert.equal(snapshot.sources.deepseek.balance, 12.34);
});

test('weather preserves valid zero values, Beijing time and missing optional measurements', () => {
  const weather = parseWeather({ current: { time: 1788910200, temperature_2m: 0, relative_humidity_2m: 0, weather_code: 3, wind_direction_10m: 0 } }, '北京市海淀区');
  assert.equal(weather.tempC, 0);
  assert.equal(weather.description, '阴');
  assert.equal(weather.windDir, '北风');
  assert.equal(weather.humidity, 0);
  assert.equal(weather.feelsLikeC, null);
  assert.equal(weather.observedAt, '2026-09-09T07:30:00.000+08:00');
  assert.throws(() => parseWeather({ current: { time: 1788910200, temperature_2m: null } }, '海淀'), /不完整/);
  const snapshot = demoSnapshot(); snapshot.mode = 'live';
  snapshot.weather = { ok: false, fetchedAt: '2026-01-01T08:00:00+08:00' };
  const screen = runBrowserRuntime(snapshot, new Map(), weather);
  assert.equal(screen.nodes.get('#weatherTemp').textContent, '0°');
  assert.match(screen.nodes.get('#weatherDetail').textContent, /北京市海淀区/);
  assert.doesNotMatch(screen.nodes.get('#weatherDetail').textContent, /体感/);
});

test('weather caches requests for 15 minutes and expires stale weather after two hours', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kindle-weather-test-'));
  const oldFetch = global.fetch;
  const file = path.join(dir, 'weather.json');
  const config = { place: '海淀', latitude: 39.99064, longitude: 116.28868 };
  let calls = 0;
  try {
    global.fetch = async url => {
      calls += 1;
      assert.match(url, /latitude=39.99064/);
      return { ok: true, text: async () => JSON.stringify({ current: { time: 1788910200, temperature_2m: 17.5, weather_code: 3 } }) };
    };
    assert.equal((await collectWeather(config, file)).ok, true);
    assert.equal((await collectWeather(config, file)).ok, true);
    assert.equal(calls, 1);
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    cached.weather.fetchedAt = new Date(Date.now() - 16 * 60000).toISOString();
    fs.writeFileSync(file, JSON.stringify(cached));
    global.fetch = async () => { throw new Error('offline'); };
    assert.equal((await collectWeather(config, file)).stale, true);
    cached.weather.fetchedAt = new Date(Date.now() - 3 * 3600000).toISOString();
    fs.writeFileSync(file, JSON.stringify(cached));
    assert.equal((await collectWeather(config, file)).ok, false);
    assert.equal((await collectWeather({ ...config, place: '另一个地区' }, file)).ok, false);
  } finally {
    global.fetch = oldFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('weather-only publication keeps the quota blobs unchanged and rejects quota edits', async () => {
  const files = { 'index.html': 'page', 'dashboard-runtime.js': 'runtime', 'weather.js': 'weather' };
  for (const altered of [false, true]) {
    const calls = [];
    const api = async (route, method = 'GET', body) => {
      calls.push({ route, method, body });
      if (route.endsWith('/ref/heads/gh-pages')) return { object: { sha: 'head' } };
      if (route.endsWith('/commits/head')) return { tree: { sha: 'old-tree' } };
      if (route.endsWith('/trees') && method === 'POST') return { sha: 'new-tree' };
      if (route.endsWith('/commits')) return { sha: 'new-commit' };
      if (route.endsWith('/refs/heads/gh-pages')) return {};
      return { tree: ['data.json', 'data.js'].map(name => ({ path: name, sha: altered && route.endsWith('/new-tree') ? 'changed' : name })) };
    };
    if (altered) await assert.rejects(publishWeatherAssets(api, 'owner/repo', files), /额度文件发生变化/);
    else await publishWeatherAssets(api, 'owner/repo', files);
    const tree = calls.find(call => call.method === 'POST' && call.route.endsWith('/trees'));
    assert.equal(tree.body.base_tree, 'old-tree');
    assert.deepEqual(tree.body.tree.map(item => item.path), Object.keys(files));
    assert.equal(calls.some(call => call.method === 'PATCH'), !altered);
  }
});

test('last known good data is preserved only for enabled failing providers', () => {
  const previous = demoSnapshot();
  const next = demoSnapshot();
  next.sources.claude = {
    ok: false,
    label: 'Claude',
    windows: [],
    fetchedAt: next.updatedAt,
    error: '临时失败',
  };
  next.sources.kimi = {
    ok: false,
    label: 'Kimi',
    windows: [],
    fetchedAt: next.updatedAt,
    error: '未启用',
    disabled: true,
  };
  preserveLastKnownGood(next, previous);
  assert.equal(next.sources.claude.ok, true);
  assert.equal(next.sources.claude.stale, true);
  assert.equal(next.sources.claude.error, '临时失败');
  assert.equal(next.sources.kimi.ok, false);
  assert.equal(next.sources.kimi.disabled, true);
});

test('safeError removes obvious credential material', () => {
  const secret = 'A'.repeat(90);
  const output = safeError(`authorization: bearer ${secret}`);
  assert.doesNotMatch(output, new RegExp(secret));
  assert.match(output, /已隐藏/);
});

test('config rejects inline secrets but accepts environment variable names', () => {
  assert.doesNotThrow(() => validateConfig({
    providers: { deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY' } },
  }));
  assert.throws(() => validateConfig({
    providers: { demo: { token: 'this-should-never-be-here' } },
  }), /不允许保存密钥值/);
});

test('snapshot writer emits JSON and old-browser JavaScript', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kindle-quota-test-'));
  try {
    writeSnapshot(demoSnapshot(), dir, false);
    const json = JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8'));
    const javascript = fs.readFileSync(path.join(dir, 'data.js'), 'utf8');
    assert.equal(json.sources.codex.ok, true);
    assert.match(javascript, /^window\.DASH_DATA = /);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('browser runtime is valid JavaScript', () => {
  for (const name of ['dashboard-runtime.js', 'app.js']) {
    const result = spawnSync(process.execPath, ['--check', path.join(ROOT, 'web', name)], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  }
});

function runBrowserRuntime(snapshot, storage, weather) {
  const nodes = new Map();
  function node() {
    const children = new Map();
    return {
      textContent: '',
      innerHTML: '',
      className: '',
      style: {},
      getAttribute() { return null; },
      setAttribute() {},
      querySelector(selector) {
        if (!children.has(selector)) children.set(selector, node());
        return children.get(selector);
      },
      querySelectorAll(selector) {
        if (!children.has(selector)) children.set(selector,
          Array.from({ length: selector === '.q-row' ? 3 : selector === '.q-label span' ? 2 : 0 }, node));
        return children.get(selector);
      },
    };
  }
  function namedNode(name) {
    if (!nodes.has(name)) nodes.set(name, node());
    return nodes.get(name);
  }
  const head = node();
  head.appendChild = (child) => { child.parentNode = head; };
  head.removeChild = (child) => { child.parentNode = null; };
  const document = {
    createElement: () => node(),
    getElementById: (id) => namedNode(`#${id}`),
    getElementsByTagName: () => [head],
    querySelector: (selector) => namedNode(selector),
  };
  const localStorage = {
    getItem: (key) => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  };
  const window = { DASH_DATA: snapshot, DASH_WEATHER: weather, localStorage };
  const source = fs.readFileSync(path.join(ROOT, 'web', 'dashboard-runtime.js'), 'utf8');
  vm.runInNewContext(source, {
    window,
    document,
    location: { search: '' },
    setTimeout: () => 1,
  });
  return { nodes, window };
}

test('browser runtime restores a valid cache and rejects older replacement data', () => {
  const storage = new Map();
  const fresh = demoSnapshot();
  fresh.mode = 'live';
  runBrowserRuntime(fresh, storage);
  const cacheKey = 'kindle_ai_quota_cache_v2';
  const cached = storage.get(cacheKey);
  assert.ok(cached, 'fresh data should be cached');

  const restored = runBrowserRuntime(null, storage);
  assert.equal(restored.nodes.get('#deepSeekBalance').textContent, '¥ 12.34');

  const older = demoSnapshot();
  older.mode = 'live';
  older.updatedAt = '2025-01-01T00:00:00+08:00';
  runBrowserRuntime(older, storage);
  assert.equal(storage.get(cacheKey), cached, 'older data must not replace a newer cache');
});

test('GLM parses five-hour, weekly and MCP windows without inventing reset times', () => {
  const windows = parseGlmQuota({ code: 200, success: true, data: { limits: [
    { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 0, nextResetTime: 1800000000000 },
    { type: 'CREDIT_LIMIT', unit: 6, number: 1, percentage: '42.5', nextResetTime: 1800000000 },
    { type: 'TIME_LIMIT', currentValue: 20, usage: 100 },
  ] } });
  assert.deepEqual(windows.map(item => [item.name, item.usedPct]), [
    ['5小时', 0], ['周', 42.5], ['MCP 月额度', 20],
  ]);
  assert.equal(windows[0].resetAt, windows[1].resetAt);
  assert.equal(windows[2].resetAt, null);
  for (const percentage of [null, '', false, [], -1, 101]) {
    assert.throws(() => parseGlmQuota({ limits: [{ type: 'TOKENS_LIMIT', percentage }] }), /有效用量/);
  }
  assert.throws(() => parseGlmQuota({ code: 401, data: { limits: [] } }), /被拒绝/);
  assert.throws(() => parseGlmQuota({ success: false }), /被拒绝/);
});

test('Codex chooses its quota bucket and never interprets null as zero usage', () => {
  const payload = { rateLimitsByLimitId: {
    other: { primary: { usedPercent: 99 } },
    codex: { primary: { usedPercent: null }, secondary: { usedPercent: 14, windowDurationMins: 10080 } },
  } };
  assert.deepEqual(parseCodexLimits(payload), [{ name: '周', usedPct: 14, resetAt: null }]);
  delete payload.rateLimitsByLimitId.codex;
  assert.throws(() => parseCodexLimits(payload), /没有 rateLimits/);
  assert.equal(parseCodexLimits({ rateLimits: { primary: { usedPercent: 0, windowDurationMins: 300 } } })[0].usedPct, 0);
});

test('local env preserves process values and does not expand shell expressions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kindle-env-test-'));
  try {
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, '# comment\nEXISTING=file\nQUOTED="with # hash"\nPLAIN=value # comment\nLITERAL=$(example)\n');
    const env = { EXISTING: 'process' };
    loadLocalEnv(file, env);
    assert.deepEqual(env, { EXISTING: 'process', QUOTED: 'with # hash', PLAIN: 'value', LITERAL: '$(example)' });
    fs.writeFileSync(file, 'invalid line\n');
    assert.throws(() => loadLocalEnv(file, {}), /第 1 行格式错误/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GLM uses the selected official endpoint and does not expose provider errors', async () => {
  const oldFetch = global.fetch;
  const oldKey = process.env.QUOTA_TEST_CREDENTIAL;
  const oldPlatform = process.env.GLM_PLATFORM;
  const config = { enabled: true, apiKeyEnv: 'QUOTA_TEST_CREDENTIAL' };
  try {
    delete process.env.QUOTA_TEST_CREDENTIAL;
    global.fetch = () => { throw new Error('network must not be used'); };
    assert.equal((await collectGlm(config)).needsSetup, true);
    assert.equal((await collectDeepSeek(config)).needsSetup, true);
    process.env.QUOTA_TEST_CREDENTIAL = 'fixture';
    for (const [platform, origin] of [['bigmodel', 'https://open.bigmodel.cn'], ['zai', 'https://api.z.ai']]) {
      process.env.GLM_PLATFORM = platform;
      global.fetch = async (url, options) => {
        assert.equal(url, origin + '/api/monitor/usage/quota/limit');
        assert.equal(options.headers.Authorization, 'fixture');
        assert.equal(options.redirect, 'error');
        return { ok: true, text: async () => JSON.stringify({ data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 10 }] } }) };
      };
      assert.equal((await collectGlm(config)).ok, true);
    }
    process.env.GLM_PLATFORM = 'unsupported';
    global.fetch = () => { throw new Error('unexpected request'); };
    assert.match((await collectGlm(config)).error, /平台应为/);
    process.env.GLM_PLATFORM = 'bigmodel';
    global.fetch = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ message: 'fixture' }) });
    const failure = await collectGlm(config);
    assert.equal(failure.ok, false);
    assert.doesNotMatch(JSON.stringify(failure), /fixture/);
  } finally {
    global.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.QUOTA_TEST_CREDENTIAL;
    else process.env.QUOTA_TEST_CREDENTIAL = oldKey;
    if (oldPlatform === undefined) delete process.env.GLM_PLATFORM;
    else process.env.GLM_PLATFORM = oldPlatform;
  }
});

test('DeepSeek keeps currency and valid zero balances but rejects missing balances', async () => {
  const oldFetch = global.fetch;
  const oldKey = process.env.QUOTA_TEST_CREDENTIAL;
  try {
    process.env.QUOTA_TEST_CREDENTIAL = 'fixture';
    for (const balance of ['0', '12.34', null, '', false]) {
      global.fetch = async (url, options) => {
        assert.equal(url, 'https://api.deepseek.com/user/balance');
        assert.equal(options.headers.Authorization, 'Bearer fixture');
        return { ok: true, text: async () => JSON.stringify({ balance_infos: [{ currency: 'USD', total_balance: balance }] }) };
      };
      const source = await collectDeepSeek({ enabled: true, apiKeyEnv: 'QUOTA_TEST_CREDENTIAL' });
      assert.equal(source.ok, typeof balance === 'string' && balance !== '');
      if (source.ok) {
        assert.equal(source.balance, Number(balance));
        assert.equal(source.currency, 'USD');
      }
    }
  } finally {
    global.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.QUOTA_TEST_CREDENTIAL;
    else process.env.QUOTA_TEST_CREDENTIAL = oldKey;
  }
});

test('live snapshots never fall back to demo data or disguise missing credentials', () => {
  const previous = demoSnapshot();
  const next = demoSnapshot();
  next.mode = 'live';
  next.sources.glm = { ok: false, windows: [], needsSetup: true };
  next.sources.codex = { ok: false, windows: [] };
  preserveLastKnownGood(next, previous);
  assert.equal(next.sources.codex.ok, false);
  previous.mode = 'live';
  preserveLastKnownGood(next, previous);
  assert.equal(next.sources.codex.stale, true);
  assert.equal(next.sources.glm.ok, false);
});

test('dashboard shows GLM setup hints, currency and a clear demo label', () => {
  const snapshot = demoSnapshot();
  const storage = new Map();
  const demo = runBrowserRuntime(snapshot, storage);
  assert.equal(storage.size, 0, 'demo must not enter the live cache');
  assert.match(demo.nodes.get('#dataAlert').textContent, /演示模式/);
  snapshot.mode = 'live';
  snapshot.sources.deepseek.currency = 'USD';
  snapshot.sources.glm = { ok: false, label: 'GLM', windows: [], fetchedAt: snapshot.updatedAt,
    needsSetup: true, error: '请配置 GLM Coding Plan 密钥' };
  const live = runBrowserRuntime(snapshot, storage);
  assert.equal(live.nodes.get('#deepSeekBalance').textContent, '$ 12.34');
  const rows = live.nodes.get('#cardGlm').querySelectorAll('.q-row');
  assert.equal(rows[0].querySelectorAll('.q-label span')[0].textContent, '待配置');
  assert.match(rows[0].querySelector('.q-refresh').textContent, /Coding Plan 密钥/);
  assert.equal(rows[1].style.display, 'none');
});

test('public checker skips ignored files on Windows paths but rejects exposed data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kindle-public-check-'));
  try {
    const initialized = spawnSync('git', ['init', '--quiet'], { cwd: dir, encoding: 'utf8' });
    assert.equal(initialized.status, 0, initialized.stderr);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'config.json\nprivate/\n.env\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'config.json'), '{"providers":{}}\n', 'utf8');
    fs.mkdirSync(path.join(dir, 'private'));
    fs.writeFileSync(path.join(dir, 'private', 'config.json'), '{"private":true}\n', 'utf8');
    const localSecret = ['API', '_KEY=', '"', 'this-is-a-local-secret', '"\n'].join('');
    fs.writeFileSync(path.join(dir, '.env'), localSecret, 'utf8');
    assert.deepEqual(collectProblems(dir), []);

    fs.writeFileSync(path.join(dir, 'data.json'), '{"public":true}\n', 'utf8');
    assert.ok(
      collectProblems(dir).some((problem) => problem.includes('data.json')),
      'unignored runtime data should be rejected',
    );

    const exposedSecret = ['API', '_KEY=', '"', 'this-is-an-exposed-secret', '"\n'].join('');
    fs.writeFileSync(path.join(dir, 'credentials.txt'), exposedSecret, 'utf8');
    assert.ok(
      collectProblems(dir).some((problem) => problem.includes('credentials.txt')),
      'unignored secrets should still be rejected',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
