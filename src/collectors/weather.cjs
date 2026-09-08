'use strict';

const fs = require('node:fs');
const { fetchJson, isoBeijing, writeAtomic } = require('../lib/common.cjs');

const CODES = {
  0: ['晴', 'clear'], 1: ['晴间多云', 'partly-cloudy'], 2: ['多云', 'cloudy'], 3: ['阴', 'cloudy'],
  45: ['雾', 'fog'], 48: ['雾凇', 'fog'], 51: ['小毛毛雨', 'rain'], 53: ['毛毛雨', 'rain'], 55: ['强毛毛雨', 'rain'],
  56: ['冻毛毛雨', 'rain'], 57: ['强冻毛毛雨', 'rain'], 61: ['小雨', 'rain'], 63: ['中雨', 'rain'], 65: ['大雨', 'rain'],
  66: ['冻雨', 'rain'], 67: ['强冻雨', 'rain'], 71: ['小雪', 'snow'], 73: ['中雪', 'snow'], 75: ['大雪', 'snow'],
  77: ['雪粒', 'snow'], 80: ['小阵雨', 'rain'], 81: ['阵雨', 'rain'], 82: ['强阵雨', 'rain'],
  85: ['阵雪', 'snow'], 86: ['强阵雪', 'snow'], 95: ['雷雨', 'thunder'], 96: ['雷雨伴冰雹', 'thunder'], 99: ['强雷雨伴冰雹', 'thunder'],
};

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseWeather(payload, place, fetchedAt = isoBeijing()) {
  const current = payload && payload.current;
  if (!current || number(current.temperature_2m) === null || !(number(current.time) > 0)) throw new Error('天气数据不完整');
  const [description, iconKey] = CODES[current.weather_code] || ['天气未知', 'cloudy'];
  const direction = number(current.wind_direction_10m);
  return {
    ok: true, description, iconKey, place, tempC: current.temperature_2m,
    feelsLikeC: number(current.apparent_temperature), humidity: number(current.relative_humidity_2m),
    windKph: number(current.wind_speed_10m),
    windDir: direction == null ? '' : ['北风', '东北风', '东风', '东南风', '南风', '西南风', '西风', '西北风'][Math.round(direction / 45) % 8],
    observedAt: isoBeijing(current.time * 1000), fetchedAt, source: 'Open-Meteo', error: null,
  };
}

async function collectWeather(config, cachePath) {
  const fetchedAt = isoBeijing();
  const place = String(config.place || '').slice(0, 40);
  const latitude = number(config.latitude);
  const longitude = number(config.longitude);
  const failure = { ok: false, place, tempC: null, fetchedAt, error: '天气获取失败' };
  if (latitude == null || longitude == null || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    return { ...failure, error: '天气坐标无效' };
  }
  const locationKey = `${latitude},${longitude},${place}`;
  let cached;
  try {
    const saved = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (saved.locationKey === locationKey && saved.weather.ok && Number.isFinite(saved.weather.tempC)) cached = saved.weather;
  } catch {}
  const age = cached ? Date.now() - Date.parse(cached.fetchedAt) : Infinity;
  if (age >= 0 && age < 15 * 60 * 1000) return cached;
  const query = new URLSearchParams({
    latitude, longitude, current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m',
    timezone: 'Asia/Shanghai', timeformat: 'unixtime', forecast_days: '1', temperature_unit: 'celsius', wind_speed_unit: 'kmh',
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const payload = await fetchJson('https://api.open-meteo.com/v1/forecast?' + query, { timeoutMs: 10000 });
      const weather = parseWeather(payload, place, fetchedAt);
      if (cachePath) {
        try { writeAtomic(cachePath, JSON.stringify({ locationKey, weather }, null, 2) + '\n'); } catch {}
      }
      return weather;
    } catch {}
  }
  if (age >= 0 && age < 2 * 60 * 60 * 1000) return { ...cached, stale: true, error: failure.error };
  return failure;
}

module.exports = { collectWeather, parseWeather };
