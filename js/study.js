'use strict';

/**
 * 学习会话引擎:翻卡 → 评分 → 下一张。
 * 主窗口「学习」视图与托盘速记小窗共用同一套逻辑(compact 模式)。
 *
 * 用法:new StudySession(rootEl, { compact: false }).start()
 * 键盘:空格 翻面;1/2/3/4 评分。
 */

const RATING_DEFS = [
  { key: 'again', num: '1', label: '忘了', cls: 'again' },
  { key: 'hard', num: '2', label: '模糊', cls: 'hard' },
  { key: 'good', num: '3', label: '认识', cls: 'good' },
  { key: 'easy', num: '4', label: '秒懂', cls: 'easy' },
];

import { BASE_MAP } from './base-map.js';

const STATE_TEXT = { new: '新词', learning: '学习中', review: '复习中' };

// 同族派生词计算用的词库缓存
let wordsCache = null;
let wordsCacheAt = 0;

async function ensureWordsCache() {
  if (!wordsCache || Date.now() - wordsCacheAt > 60 * 1000) {
    try {
      wordsCache = await window.api.words.list();
      wordsCacheAt = Date.now();
    } catch { wordsCache = wordsCache || []; }
  }
  return wordsCache;
}

function commonPrefixLen(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}


/** 找当前词的"原词"(含释义):先查词典型映射(strength→strong 等拼写变化),前缀规则兜底 */
function baseWordOf(card, words) {
  if (!card || !words || !words.length) return null;
  const cur = card.word.toLowerCase();
  const mapped = BASE_MAP[cur];
  if (mapped) {
    const hit = words.find((w) => String(w.word || '').toLowerCase() === mapped);
    if (hit) return hit;
  }
  const tag = (card.tags || [])[0];
  let best = null;
  for (const w of words) {
    const w2 = String(w.word || '').toLowerCase();
    if (w2 === cur || w2.length >= cur.length || w2.length < 3) continue;
    if (tag && (w.tags || [])[0] !== tag) continue;
    if (w2.includes(' ')) continue;
    const prefixRel = cur.startsWith(w2);
    const cpl = commonPrefixLen(cur, w2);
    if (prefixRel || cpl >= 4) {
      if (!best || w2.length < best.word.length) best = w;
    }
  }
  return best;
}

/** 释义截断:v. 行动；充当 n. 行为… → 保留词性+第一义项 */
function shortMeaning(m, max = 14) {
  const s = String(m || '').trim();
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

/** 同 List 内的派生/同族词:前缀同族优先(actor/action←act),子串/词群匹配次之(enact、fact 群) */
function relatedWords(card, words) {
  if (!card || !words || !words.length) return [];
  const tag = (card.tags || [])[0];
  const w1 = card.word.toLowerCase();
  const out = [];
  for (const w of words) {
    const w2 = String(w.word || '').toLowerCase();
    if (w2 === w1 || w2.length < 3) continue;
    if (tag && (w.tags || [])[0] !== tag) continue;
    const prefixRel = w2.startsWith(w1) || w1.startsWith(w2);
    const substringRel = w2.includes(w1) || w1.includes(w2);
    const cpl = commonPrefixLen(w1, w2) >= 4;
    if (prefixRel || substringRel || cpl) {
      out.push({ w, score: (prefixRel ? 2 : 0) + (cpl ? 2 : 0) + (substringRel ? 1 : 0) });
    }
  }
  out.sort((a, b) => b.score - a.score || a.w.word.length - b.w.word.length);
  return out.slice(0, 10).map((x) => x.w);
}

export class StudySession {
  constructor(rootEl, { compact = false, onEmpty } = {}) {
    this.root = rootEl;
    this.compact = compact;
    this.onEmpty = onEmpty || null;
    this.card = null;       // 当前卡(study:next 返回)
    this.flipped = false;
    this.state = 'idle';    // idle | front | back | waiting | done
    this._pollTimer = null;
    this._keyHandler = null;
  }

  destroy() {
    this._clearPoll();
    if (this._keyHandler) document.removeEventListener('keydown', this._keyHandler);
    this._keyHandler = null;
    this.root.innerHTML = '';
  }

  _clearPoll() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  }

  async start() {
    this._clearPoll();
    this.state = 'idle';
    this.root.innerHTML = `<div class="empty"><div class="emoji">⏳</div><h2>加载中…</h2></div>`;
    await ensureWordsCache();
    const res = await window.api.study.next();
    if (res.card) {
      this.card = res.card;
      this._renderFront();
    } else if (res.waiting && res.waiting.length) {
      this._renderWaiting(res.waiting);
    } else {
      this._renderDone();
    }
  }

  // ---------- 渲染 ----------

  _renderFront() {
    this.state = 'front';
    this.flipped = false;
    const c = this.card;
    const related = this.compact ? [] : relatedWords(c, wordsCache);
    const base = baseWordOf(c, wordsCache);
    this.root.innerHTML = `
      <div class="flip-stage">
        <div class="flip-card" id="flip-card">
          <div class="flip-face front">
            <div class="tag-row">${(c.tags || []).map((t) => `<span class="pill gray">${t}</span>`).join('')}</div>
            <span class="state-chip pill ${c.state === 'new' ? 'gray' : c.state === 'learning' ? 'orange' : ''}">${STATE_TEXT[c.state] || c.state}</span>
            <div class="word-big">${this._esc(c.word)}</div>
            ${c.phonetic ? `<div class="phonetic">${this._esc(c.phonetic)}</div>` : ''}
            ${base ? `<div class="base-hint">↳ 源自 <b>${this._esc(base.word)}</b></div>` : ''}
            <div class="hint">空格 / 点击 查看释义</div>
          </div>
          <div class="flip-face back">
            <div class="meaning-big">${this._esc(c.meaning)}</div>
            ${c.mnemonic ? `<div class="card-extra mnemo">💡 ${this._esc(c.mnemonic)}</div>` : ''}
            ${c.collocations ? `<div class="card-extra colloc">🔗 ${this._esc(c.collocations)}</div>` : ''}
            ${(base || related.length) ? `<div class="related-row">${base ? `<span class="pill orange base-chip" title="${this._esc(base.word + ': ' + (base.meaning || ''))}">源自 ${this._esc(base.word)}${base.meaning ? '(' + this._esc(shortMeaning(base.meaning, 10)) + ')' : ''}</span>` : ''}${related.length ? `<span class="related-label">派生</span>${related.map((w) => `<span class="pill gray related-chip" title="${this._esc(w.word + ': ' + (w.meaning || ''))}">${this._esc(w.word)}</span>`).join('')}` : ''}</div>` : ''}
            ${c.example ? `<div class="example">${this._esc(c.example)}</div>` : ''}
            <div class="hint">${this._esc(c.word)}${c.phonetic ? ' · ' + this._esc(c.phonetic) : ''}</div>
          </div>
        </div>
      </div>
      <div class="rate-row">
        ${RATING_DEFS.map((r) => `
          <button class="rate-btn ${r.cls}" data-rating="${r.key}" disabled>
            <span class="r-label">${r.label}</span>
            <span class="r-ivl">${c.previews[r.key]}</span>
            <span class="r-key">${r.num}</span>
          </button>`).join('')}
      </div>`;

    const flipCard = this.root.querySelector('#flip-card');
    flipCard.addEventListener('click', () => this.flip());
    this.root.querySelectorAll('.rate-btn').forEach((btn) => {
      btn.addEventListener('click', () => this.rate(btn.dataset.rating));
    });
    this._bindKeys();
  }

  flip() {
    if (this.state !== 'front') return;
    this.state = 'back';
    this.flipped = true;
    this.root.querySelector('#flip-card').classList.add('flipped');
    this.root.querySelectorAll('.rate-btn').forEach((b) => (b.disabled = false));
  }

  async rate(rating) {
    if (this.state !== 'back' || !this.card) return;
    this.state = 'rating';
    this._clearPoll();
    this.root.querySelectorAll('.rate-btn').forEach((b) => (b.disabled = true));
    const res = await window.api.study.answer(this.card.id, rating);
    if (!res.ok) {
      // 词已被删除等异常:丢弃当前卡,重开会话自愈
      this.start();
      return;
    }
    if (res.card) {
      // 先翻回正面再换卡,避免背面闪现
      this.card = res.card;
      this._renderFront();
    } else if (res.waiting && res.waiting.length) {
      this._renderWaiting(res.waiting);
    } else {
      this._renderDone();
    }
  }

  _renderWaiting(waiting) {
    this.state = 'waiting';
    const next = waiting[0];
    const mins = Math.max(1, Math.ceil((next.srs.dueAt - Date.now()) / 60000));
    this.root.innerHTML = `
      <div class="empty">
        <div class="emoji">⏱</div>
        <h2>本批卡片已完成</h2>
        <p>还有 ${waiting.length} 张学习中的卡片,${mins} 分钟后到期<br>到时会自动出现,先去忙别的吧</p>
      </div>`;
    this._pollTimer = setInterval(async () => {
      const res = await window.api.study.next();
      if (res.card) {
        this.card = res.card;
        this._renderFront();
      } else {
        this._renderWaiting(res.waiting || []);
      }
    }, 10 * 1000);
    this._bindKeys();
  }

  _renderDone() {
    this.state = 'done';
    this._clearPoll();
    this.root.innerHTML = `
      <div class="empty">
        <div class="emoji">🎉</div>
        <h2>今日任务全部完成!</h2>
        <p>${this.compact ? '休息一下,明天再来' : '所有到期卡片都学完了,太棒了'}</p>
      </div>`;
    if (this.onEmpty) this.onEmpty();
  }

  // ---------- 键盘 ----------

  _bindKeys() {
    if (this._keyHandler) document.removeEventListener('keydown', this._keyHandler);
    this._keyHandler = (e) => {
      // 输入框聚焦时不抢按键
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        if (this.state === 'front') this.flip();
      } else if (['1', '2', '3', '4'].includes(e.key)) {
        if (this.state === 'back') this.rate(RATING_DEFS[Number(e.key) - 1].key);
      } else if (e.key === 'Escape' && this.compact) {
        window.api.app.hidePopup();
      }
    };
    document.addEventListener('keydown', this._keyHandler);
  }

  _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
}

export { RATING_DEFS };
