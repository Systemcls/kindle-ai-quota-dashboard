'use strict';

const path = require('node:path');
const { loadConfig } = require('../src/lib/config.cjs');
const { collectWeather } = require('../src/collectors/weather.cjs');
const { writeAtomic } = require('../src/lib/common.cjs');

async function main() {
  const config = loadConfig();
  if (!config.weather || !config.weather.enabled) throw new Error('请先配置天气地区');
  const weather = await collectWeather(config.weather, path.join(config.outputDir, 'weather-cache.json'));
  if (!weather.ok) throw new Error(weather.error);
  writeAtomic(path.join(config.outputDir, 'weather.js'), `window.DASH_WEATHER = ${JSON.stringify(weather)};\n`);
  console.log(JSON.stringify({ place: weather.place, description: weather.description, tempC: weather.tempC, observedAt: weather.observedAt, stale: !!weather.stale }));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
