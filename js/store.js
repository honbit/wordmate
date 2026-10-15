'use strict';

/**
 * Web/PWA 版数据层:用 localStorage 实现与桌面版 preload.js 完全同构的 window.api,
 * 渲染层 views 零改动复用。进度导出/导入(JSON)用于与桌面版互相同步。
 */

import * as srs from './srs.js';

window.IS_WEB = true;

const KEY = 'wordmate-store';
const listeners = [];

function defaults() {
  return {
    words: [],
    settings: {
      newPerDay: 120,
      reviewPerDay: 400,
      quizChoiceCount: 4,
      globalShortcut: '',
      sticky: { enabled: false, pinned: true, x: null, y: null },
      cloud: { token: '', repo: 'honbit/wordmate-sync', auto: true, lastSyncAt: 0 },
    },
    reviewLog: {},
  };
}

let data = (() => {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const def = defaults();
      return {
        ...def, ...parsed,
        // 旧数据补齐新增设置字段(顶层浅合并不深入 settings)
        settings: {
          ...def.settings, ...(parsed.settings || {}),
          sticky: { ...def.settings.sticky, ...((parsed.settings && parsed.settings.sticky) || {}) },
          cloud: { ...def.settings.cloud, ...((parsed.settings && parsed.settings.cloud) || {}) },
        },
      };
    }
  } catch (e) { console.error('本地数据损坏,重建:', e); }
  return defaults();
})();

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  data.updatedAt = Date.now();
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch (e) {
      console.error('保存失败(可能超出 localStorage 容量):', e);
      alert('本地存储空间不足,请导出进度后清理词库');
    }
  }, 300);
}

function emit(kind) {
  for (const cb of listeners) {
    try { cb({ kind }); } catch (e) { console.error(e); }
  }
}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : 'w-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// ---------- 与桌面版 main.js 对齐的业务逻辑 ----------

function normalizeWordInput(input) {
  return {
    word: String(input.word || '').trim(),
    meaning: String(input.meaning || '').trim(),
    phonetic: String(input.phonetic || '').trim(),
    mnemonic: String(input.mnemonic || '').trim(),
    collocations: String(input.collocations || '').trim(),
    example: String(input.example || '').trim(),
    tags: Array.isArray(input.tags) ? input.tags.map((t) => String(t).trim()).filter(Boolean) : [],
  };
}

function todayLog() {
  const key = srs.dayKey();
  if (!data.reviewLog[key]) {
    data.reviewLog[key] = { newLearned: 0, reviews: 0, again: 0, hard: 0, good: 0, easy: 0, quizCorrect: 0, quizWrong: 0 };
  }
  return data.reviewLog[key];
}

function currentCounts() {
  const log = data.reviewLog[srs.dayKey()] || {};
  return { newSeenToday: log.newLearned || 0, reviewsToday: log.reviews || 0 };
}

function buildQueueNow() {
  return srs.buildQueue(data.words, currentCounts(), data.settings);
}

function cardPayload(w) {
  const { id, word, meaning, phonetic, mnemonic, collocations, example, tags, createdAt } = w;
  const { state, interval, reps, lapses, ease } = w.srs;
  return {
    id, word, meaning, phonetic: phonetic || '',
    mnemonic: mnemonic || '', collocations: collocations || '',
    example: example || '', tags: tags || [], createdAt,
    state, interval, reps, lapses, ease,
    previews: srs.previewIntervals(w.srs),
  };
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- 进度导出 / 导入(与桌面版互传) ----------

function downloadText(content, name) {
  const blob = new Blob([content], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
}

function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept || '';
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) return resolve({ ok: false });
      const reader = new FileReader();
      reader.onload = () => resolve({ ok: true, name: file.name, content: String(reader.result || '') });
      reader.onerror = () => resolve({ ok: false });
      reader.readAsText(file, 'utf8');
    };
    input.click();
  });
}

// ---------- 暴露 window.api(与 preload.js 同构) ----------

// ---------- 云同步(GitHub 私有仓库,词级合并,与桌面版同构) ----------

const DEVICE_NAME = /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : 'Web';

function b64encodeUtf8(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
function b64decodeUtf8(b64) {
  return decodeURIComponent(escape(atob(String(b64).replace(/\n/g, ''))));
}

function pickStudyPrefs(settings) {
  return {
    newPerDay: settings.newPerDay,
    reviewPerDay: settings.reviewPerDay,
    quizChoiceCount: settings.quizChoiceCount,
    contentVersion: settings.contentVersion || 1,
  };
}

function mergeStore(local, remote) {
  const byWord = new Map();
  for (const w of remote.words) byWord.set(w.word.toLowerCase(), w);
  for (const w of local.words) {
    const key = w.word.toLowerCase();
    const r = byWord.get(key);
    if (!r) { byWord.set(key, w); continue; }
    const a = (w.srs.lastReviewedAt || 0) - (r.srs.lastReviewedAt || 0);
    if (a > 0 || (a === 0 && (w.srs.reps || 0) >= (r.srs.reps || 0))) byWord.set(key, w);
  }
  const words = [...byWord.values()].sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
  const reviewLog = {};
  const days = new Set([...Object.keys(local.reviewLog || {}), ...Object.keys(remote.reviewLog || {})]);
  for (const d of days) {
    const la = local.reviewLog[d] || {}, lb = remote.reviewLog[d] || {};
    const m = {};
    for (const k of new Set([...Object.keys(la), ...Object.keys(lb)])) m[k] = Math.max(la[k] || 0, lb[k] || 0);
    reviewLog[d] = m;
  }
  const settings = (remote.updatedAt || 0) > (local.updatedAt || 0)
    ? { ...pickStudyPrefs(local), ...pickStudyPrefs(remote) }
    : { ...pickStudyPrefs(remote), ...pickStudyPrefs(local) };
  return { words, reviewLog, settings };
}

async function cloudSync() {
  const cfg = data.settings.cloud;
  if (!cfg.token) return { ok: false, error: '请先在「统计 → 云同步」填入 GitHub 访问令牌' };
  const repo = cfg.repo || 'honbit/wordmate-sync';
  const headers = {
    Authorization: 'Bearer ' + cfg.token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  let remote = null;
  let sha = null;
  const getRes = await fetch(`https://api.github.com/repos/${repo}/contents/progress.json`, { headers });
  if (getRes.status === 200) {
    const j = await getRes.json();
    sha = j.sha;
    remote = JSON.parse(b64decodeUtf8(j.content));
    if (!remote || !Array.isArray(remote.words)) remote = null;
  } else if (getRes.status !== 404) {
    throw new Error('云端读取失败 HTTP ' + getRes.status);
  }

  const localPayload = {
    v: 1, device: DEVICE_NAME,
    updatedAt: data.updatedAt || 0,
    words: data.words, reviewLog: data.reviewLog,
    settings: pickStudyPrefs(data.settings),
  };
  const merged = remote ? mergeStore(localPayload, remote) : localPayload;

  data.words = merged.words;
  data.reviewLog = merged.reviewLog;
  Object.assign(data.settings, merged.settings);
  data.updatedAt = Date.now();
  save(); emit('cloud');

  const payload = { ...merged, v: 1, device: DEVICE_NAME, updatedAt: Date.now() };
  const putRes = await fetch(`https://api.github.com/repos/${repo}/contents/progress.json`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'sync ' + new Date().toISOString(), content: b64encodeUtf8(JSON.stringify(payload)), ...(sha ? { sha } : {}) }),
  });
  if (!putRes.ok) throw new Error('云端写入失败 HTTP ' + putRes.status);
  cfg.lastSyncAt = Date.now();
  save();
  return { ok: true, count: data.words.length, remoteDevice: remote ? remote.device : null };
}


window.api = {
  words: {
    list: async () => [...data.words].sort((a, b) => b.createdAt - a.createdAt),
    add: async (input) => {
      const w = normalizeWordInput(input);
      if (!w.word || !w.meaning) return { ok: false, error: '单词和释义都不能为空' };
      if (data.words.some((x) => x.word.toLowerCase() === w.word.toLowerCase())) {
        return { ok: false, error: `「${w.word}」已存在于词库` };
      }
      const word = { id: uuid(), ...w, createdAt: Date.now(), srs: srs.newSrs() };
      data.words.push(word);
      save(); emit('words');
      return { ok: true, word };
    },
    update: async (id, patch) => {
      const t = data.words.find((x) => x.id === id);
      if (!t) return { ok: false, error: '词不存在' };
      const w = normalizeWordInput({ ...t, ...patch });
      if (!w.word || !w.meaning) return { ok: false, error: '单词和释义都不能为空' };
      if (data.words.some((x) => x.id !== id && x.word.toLowerCase() === w.word.toLowerCase())) {
        return { ok: false, error: `「${w.word}」已存在` };
      }
      Object.assign(t, w);
      save(); emit('words');
      return { ok: true, word: t };
    },
    remove: async (id) => {
      const before = data.words.length;
      data.words = data.words.filter((x) => x.id !== id);
      const ok = data.words.length < before;
      if (ok) { save(); emit('words'); }
      return { ok };
    },
    removeMany: async (ids) => {
      const set = new Set(ids);
      const before = data.words.length;
      data.words = data.words.filter((x) => !set.has(x.id));
      const removed = before - data.words.length;
      if (removed) { save(); emit('words'); }
      return { ok: true, removed };
    },
    reset: async (id) => {
      const t = data.words.find((x) => x.id === id);
      if (!t) return { ok: false, error: '词不存在' };
      t.srs = srs.newSrs();
      save(); emit('words');
      return { ok: true };
    },
    import: async (items) => {
      const added = [];
      const skipped = [];
      let seq = Date.now();
      for (const raw of items) {
        const w = normalizeWordInput(raw);
        if (!w.word || !w.meaning) { skipped.push({ word: w.word || '(空)', reason: '缺少单词或释义' }); continue; }
        const dup = data.words.find((x) => x.word.toLowerCase() === w.word.toLowerCase())
          || added.find((x) => x.word.toLowerCase() === w.word.toLowerCase());
        if (dup) { skipped.push({ word: w.word, reason: '已存在(重复)' }); continue; }
        added.push({ id: uuid(), ...w, createdAt: seq++, srs: srs.newSrs() });
      }
      data.words.push(...added);
      save(); emit('words');
      return { ok: true, added: added.length, skipped };
    },
    export: async () => {
      const esc = (v) => {
        const s = String(v == null ? '' : v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const rows = [['word', 'phonetic', 'meaning', 'example', 'tags', 'state', 'intervalDays', 'dueAt']];
      for (const w of data.words) {
        rows.push([w.word, w.phonetic || '', w.meaning, w.example || '', (w.tags || []).join('; '), w.srs.state, w.srs.interval, new Date(w.srs.dueAt).toISOString()]);
      }
      return rows.map((r) => r.map(esc).join(',')).join('\n');
    },
    exportSave: async (content, name) => {
      downloadText(content, name || 'wordmate-export.csv');
      return { ok: true, filePath: '已下载' };
    },
    importOpenFile: async () => pickFile('.txt,.csv,.md'),
    /** 批量更新词条内容(例句等),保留 id/srs/createdAt/tags —— 用于词表内容升级 */
    syncContent: async (items) => {
      let updated = 0;
      const missing = [];
      for (const raw of items) {
        const w = normalizeWordInput(raw);
        if (!w.word || !w.meaning) continue;
        const t = data.words.find((x) => x.word.toLowerCase() === w.word.toLowerCase());
        if (!t) { missing.push(w.word); continue; }
        t.meaning = w.meaning || t.meaning;
        t.phonetic = w.phonetic || t.phonetic;
        t.example = w.example || t.example;
        t.mnemonic = w.mnemonic || t.mnemonic;
        t.collocations = w.collocations || t.collocations;
        if (!(t.tags || []).length && w.tags.length) t.tags = w.tags;
        updated++;
      }
      save(); emit('words');
      return { ok: true, updated, missing };
    },
  },
  study: {
    summary: async () => ({
      queueLen: buildQueueNow().length,
      waiting: srs.waitingLearning(data.words),
      states: srs.summarizeStates(data.words),
      counts: currentCounts(),
      settings: { ...data.settings },
    }),
    next: async () => {
      const queue = buildQueueNow();
      if (!queue.length) return { card: null, waiting: srs.waitingLearning(data.words) };
      return { card: cardPayload(queue[0]), remaining: queue.length };
    },
    answer: async (id, rating) => {
      const t = data.words.find((x) => x.id === id);
      if (!t) return { ok: false, error: '词不存在' };
      const prev = t.srs.state;
      t.srs = srs.schedule(t.srs, rating);
      const log = todayLog();
      log[rating] = (log[rating] || 0) + 1;
      if (prev === 'new') log.newLearned = (log.newLearned || 0) + 1;
      else log.reviews = (log.reviews || 0) + 1;
      save(); emit('study');
      const queue = buildQueueNow();
      return {
        ok: true,
        card: queue.length ? cardPayload(queue[0]) : null,
        remaining: queue.length,
        waiting: queue.length ? [] : srs.waitingLearning(data.words),
      };
    },
  },
  quiz: {
    generate: async () => {
      const words = data.words;
      const choiceCount = Math.min(data.settings.quizChoiceCount || 4, 6);
      if (words.length < 4) return { ok: false, error: '词库至少需要 4 个词才能生成选择题' };
      const queue = buildQueueNow();
      const pool = queue.length ? queue : words;
      const target = pool[Math.floor(Math.random() * pool.length)];
      const direction = Math.random() < 0.5 ? 'w2m' : 'm2w';
      const distractors = shuffle(words.filter((w) => w.id !== target.id)).slice(0, choiceCount - 1);
      const options = shuffle([target, ...distractors]);
      return {
        ok: true,
        id: target.id,
        direction,
        prompt: direction === 'w2m' ? target.word : target.meaning,
        phonetic: direction === 'w2m' ? target.phonetic || '' : '',
        choices: options.map((w) => (direction === 'w2m' ? w.meaning : w.word)),
        correctIndex: options.findIndex((w) => w.id === target.id),
      };
    },
    answer: async (id, correct) => {
      const t = data.words.find((x) => x.id === id);
      if (!t) return { ok: false, error: '词不存在' };
      const prev = t.srs.state;
      t.srs = srs.schedule(t.srs, correct ? 'good' : 'again');
      const log = todayLog();
      if (correct) log.quizCorrect = (log.quizCorrect || 0) + 1;
      else log.quizWrong = (log.quizWrong || 0) + 1;
      if (prev === 'new') log.newLearned = (log.newLearned || 0) + 1;
      else log.reviews = (log.reviews || 0) + 1;
      save(); emit('study');
      return { ok: true };
    },
  },
  stats: {
    summary: async () => ({
      states: srs.summarizeStates(data.words),
      today: data.reviewLog[srs.dayKey()] || {},
      streak: srs.streakDays(data.reviewLog),
      last7: Array.from({ length: 7 }, (_, i) => {
        const key = srs.shiftDayKey(srs.dayKey(), i - 6);
        const l = data.reviewLog[key] || {};
        return { key, label: key.slice(5).replace('-', '/'), newLearned: l.newLearned || 0, reviews: l.reviews || 0, quizCorrect: l.quizCorrect || 0, quizWrong: l.quizWrong || 0 };
      }),
      settings: { ...data.settings },
    }),
  },
  settings: {
    get: async () => ({ ...data.settings, sticky: { ...data.settings.sticky } }),
    set: async (patch) => {
      const s = data.settings;
      if (Number.isFinite(+patch.newPerDay)) s.newPerDay = Math.min(500, Math.max(1, Math.round(+patch.newPerDay)));
      if (Number.isFinite(+patch.reviewPerDay)) s.reviewPerDay = Math.min(1000, Math.max(1, Math.round(+patch.reviewPerDay)));
      if (Number.isFinite(+patch.quizChoiceCount)) s.quizChoiceCount = Math.min(6, Math.max(2, Math.round(+patch.quizChoiceCount)));
      if (typeof patch.seeded === 'boolean') s.seeded = patch.seeded;
      if (patch.cloud && typeof patch.cloud === 'object') {
        if (typeof patch.cloud.token === 'string') s.cloud.token = patch.cloud.token.trim();
        if (typeof patch.cloud.auto === 'boolean') s.cloud.auto = patch.cloud.auto;
      }
      if (Number.isFinite(+patch.contentVersion)) s.contentVersion = Math.round(+patch.contentVersion);
      save(); emit('settings');
      return { ok: true, settings: { ...s } };
    },
  },
  /** 内置词表(冲分宝高频分册,随应用分发) */
  builtin: {
    wordlist: async () => {
      const res = await fetch('data/cfb-1442.txt');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return { ok: true, content: await res.text() };
    },
  },
  /** 进度导出/导入:与桌面版互相同步(JSON 含词库+进度+设置) */
  store: {
    export: async () => {
      downloadText(JSON.stringify(data, null, 1), `wordmate-progress-${srs.dayKey()}.json`);
      return { ok: true };
    },
    import: async () => {
      const res = await pickFile('.json');
      if (!res.ok) return { ok: false, error: '未选择文件' };
      try {
        const parsed = JSON.parse(res.content);
        if (!Array.isArray(parsed.words)) throw new Error('缺少 words 字段');
        data = { ...defaults(), ...parsed };
        save(); emit('words');
        return { ok: true, count: data.words.length };
      } catch (e) {
        return { ok: false, error: '文件解析失败: ' + e.message };
      }
    },
  },
  onDataChanged: (cb) => { listeners.push(cb); },
  cloud: {
    sync: async () => {
      try {
        return await cloudSync();
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
  },
};
