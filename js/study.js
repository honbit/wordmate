'use strict';

/**
 * 学习会话引擎:翻卡 → 评分 → 下一张;支持左右邻卡浏览(虚化缩略 + 键盘 ←/→)。
 * 主窗口「学习」视图与托盘速记小窗共用同一套逻辑(compact 模式)。
 *
 * 导航带模型:history(本会话已答过的卡,按序)+ queue(当前待学队列快照),
 * pos 指向当前显示位置;浏览切换不影响调度,评分照常记入间隔重复。
 *
 * 键盘:空格 翻面;1/2/3/4 评分;←/→ 切换上一张/下一张。
 */

import { BASE_MAP } from './base-map.js';

const RATING_DEFS = [
  { key: 'again', num: '1', label: '忘了', cls: 'again' },
  { key: 'hard', num: '2', label: '模糊', cls: 'hard' },
  { key: 'good', num: '3', label: '认识', cls: 'good' },
  { key: 'easy', num: '4', label: '秒懂', cls: 'easy' },
];

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

export class StudySession {
  constructor(rootEl, { compact = false, onEmpty } = {}) {
    this.root = rootEl;
    this.compact = compact;
    this.onEmpty = onEmpty || null;
    this.card = null;       // 当前显示的卡
    this.history = [];      // 本会话已答过的卡(按序)
    this.queue = [];        // 当前待学队列快照
    this.pos = 0;           // 导航带位置:0..history.length+queue.length-1
    this.peekCard = null;   // 浏览模式的卡(不在队列时从词库临时查看)
    this.peekStack = [];    // 跳转栈,支持逐层返回
    this.flipped = false;
    this.state = 'idle';    // idle | front | back | waiting | done | rating
    this._pollTimer = null;
    this._keyHandler = null;
  }

  get tapeLen() { return this.history.length + this.queue.length; }

  cardAt(i) {
    if (i < 0 || i >= this.tapeLen) return null;
    return i < this.history.length ? this.history[i] : this.queue[i - this.history.length];
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
    this.history = [];
    this.peekCard = null;
    this.peekStack = [];
    const q = await window.api.study.queue();
    this.queue = q.cards || [];
    this.pos = 0;
    if (this.queue.length) {
      this._renderFront();
    } else {
      const res = await window.api.study.next();
      if (res.waiting && res.waiting.length) {
        this._renderWaiting(res.waiting);
      } else {
        this._renderDone();
      }
    }
  }

  /** 点击原词/派生词跳转:在队列里则定位过去,否则进浏览模式(可逐层返回) */
  jumpTo(w) {
    if (!w || !w.id) return;
    const idx = this.tapeIndexOf(w.id);
    this._clearPoll();
    if (idx >= 0) {
      this.peekStack = [];
      this.peekCard = null;
      this.pos = idx;
      this._renderFront();
      return;
    }
    this.peekStack.push(this.peekCard
      ? { kind: 'peek', card: this.peekCard }
      : { kind: 'pos', pos: this.pos });
    this.peekCard = {
      id: w.id, word: w.word, meaning: w.meaning || '', phonetic: w.phonetic || '',
      mnemonic: w.mnemonic || '', collocations: w.collocations || '', example: w.example || '',
      tags: w.tags || [], state: (w.srs && w.srs.state) || 'new', previews: null,
    };
    this._renderFront();
  }

  /** 从浏览模式返回上一层 */
  returnFromPeek() {
    const top = this.peekStack.pop();
    if (!top) {
      this.peekCard = null;
      this._renderFront();
      return;
    }
    if (top.kind === 'pos') {
      this.peekCard = null;
      this.pos = top.pos;
    } else {
      this.peekCard = top.card;
    }
    this._renderFront();
  }

  tapeIndexOf(id) {
    for (let i = 0; i < this.tapeLen; i++) {
      const c = this.cardAt(i);
      if (c && c.id === id) return i;
    }
    return -1;
  }

  /** 左右切换(浏览,不影响调度) */
  nav(delta) {
    const np = Math.min(this.tapeLen - 1, Math.max(0, this.pos + delta));
    if (np === this.pos) return;
    this.pos = np;
    this._clearPoll();
    this._renderFront();
  }

  // ---------- 渲染 ----------

  _renderFront() {
    this._clearPoll(); // 防御:任何渲染入口都终止等待轮询,避免定时器把卡翻回正面
    if (this.peekCard) { this._renderPeek(); return; }
    this.state = 'front';
    this.flipped = false;
    const c = this.card = this.cardAt(this.pos);
    if (!c) { this._renderDone(); return; }
    const related = this.compact ? [] : relatedWords(c, wordsCache);
    const base = baseWordOf(c, wordsCache);
    const prev = this.cardAt(this.pos - 1);
    const next = this.cardAt(this.pos + 1);
    this.root.innerHTML = `
      <div class="car-stage">
        ${prev ? `<button class="car-side left" title="上一张(←)">
          <span class="car-card">
            <span class="car-tag">${this._esc((prev.tags || [])[0] || '')}</span>
            <span class="car-word">${this._esc(prev.word)}</span>
            ${prev.phonetic ? `<span class="car-ph">${this._esc(prev.phonetic)}</span>` : ''}
            <span class="car-arrow">‹</span>
          </span>
        </button>` : ''}
        <div class="flip-stage">
          <div class="flip-card" id="flip-card">
            <div class="flip-face front">
              <div class="tag-row">${(c.tags || []).map((t) => `<span class="pill gray">${t}</span>`).join('')}</div>
              <span class="state-chip pill ${c.state === 'new' ? 'gray' : c.state === 'learning' ? 'orange' : ''}">${STATE_TEXT[c.state] || c.state}</span>
              <div class="word-big">${this._esc(c.word)}</div>
              ${c.phonetic ? `<div class="phonetic">${this._esc(c.phonetic)}</div>` : ''}
              ${base ? `<div class="base-hint">↳ 源自 <b>${this._esc(base.word)}</b></div>` : ''}
              <div class="hint">空格 / 点击 查看释义 · ←/→ 切换</div>
            </div>
            <div class="flip-face back">
              <div class="back-word">${this._esc(c.word)}${c.phonetic ? ` <span class="bw-ph">${this._esc(c.phonetic)}</span>` : ''}</div>
              <div class="meaning-big">${this._esc(c.meaning)}</div>
              ${c.mnemonic ? `<div class="card-extra mnemo">💡 ${this._esc(c.mnemonic)}</div>` : ''}
              ${c.collocations ? `<div class="card-extra colloc">🔗 ${this._esc(c.collocations)}</div>` : ''}
              ${(base || related.length) ? `<div class="related-row">${base ? `<span class="pill orange base-chip chip-jump" data-jump="${base.id}" title="${this._esc(base.word + ': ' + (base.meaning || ''))}">源自 ${this._esc(base.word)}${base.meaning ? '(' + this._esc(shortMeaning(base.meaning, 10)) + ')' : ''}</span>` : ''}${related.length ? `<span class="related-label">派生</span>${related.map((w) => `<span class="pill gray related-chip chip-jump" data-jump="${w.id}" title="${this._esc(w.word + ': ' + (w.meaning || ''))}">${this._esc(w.word)}</span>`).join('')}` : ''}</div>` : ''}
              ${c.example ? `<div class="example">${this._esc(c.example)}</div>` : ''}
            </div>
          </div>
        </div>
        ${next ? `<button class="car-side right" title="下一张(→)">
          <span class="car-card">
            <span class="car-tag">${this._esc((next.tags || [])[0] || '')}</span>
            <span class="car-word">${this._esc(next.word)}</span>
            ${next.phonetic ? `<span class="car-ph">${this._esc(next.phonetic)}</span>` : ''}
            <span class="car-arrow">›</span>
          </span>
        </button>` : ''}
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
    this.root.querySelector('.car-side.left')?.addEventListener('click', () => this.nav(-1));
    this.root.querySelector('.car-side.right')?.addEventListener('click', () => this.nav(1));
    this.root.querySelectorAll('.rate-btn').forEach((btn) => {
      btn.addEventListener('click', () => this.rate(btn.dataset.rating));
    });
    this._bindJumps();
    this._bindKeys();
  }

  /** 浏览模式:从词库临时查看一张卡,顶部带返回,不参与调度 */
  _renderPeek() {
    this.state = 'front';
    this.flipped = false;
    const c = this.peekCard;
    const related = this.compact ? [] : relatedWords(c, wordsCache);
    const base = baseWordOf(c, wordsCache);
    this.root.innerHTML = `
      <div class="peek-bar">
        <button class="btn sm" id="peek-back">↩ 返回</button>
        <span class="peek-note">浏览模式 · 仅查看(Esc 返回)</span>
      </div>
      <div class="flip-stage">
        <div class="flip-card card-pop" id="flip-card">
          <div class="flip-face front">
            <div class="tag-row">${(c.tags || []).map((t) => `<span class="pill gray">${t}</span>`).join('')}</div>
            <span class="state-chip pill ${c.state === 'new' ? 'gray' : c.state === 'learning' ? 'orange' : ''}">${STATE_TEXT[c.state] || c.state}</span>
            <div class="word-big">${this._esc(c.word)}</div>
            ${c.phonetic ? `<div class="phonetic">${this._esc(c.phonetic)}</div>` : ''}
            ${base ? `<div class="base-hint">↳ 源自 <b>${this._esc(base.word)}</b></div>` : ''}
            <div class="hint">空格 / 点击 查看释义</div>
          </div>
          <div class="flip-face back">
            <div class="back-word">${this._esc(c.word)}${c.phonetic ? ` <span class="bw-ph">${this._esc(c.phonetic)}</span>` : ''}</div>
            <div class="meaning-big">${this._esc(c.meaning)}</div>
            ${c.mnemonic ? `<div class="card-extra mnemo">💡 ${this._esc(c.mnemonic)}</div>` : ''}
            ${c.collocations ? `<div class="card-extra colloc">🔗 ${this._esc(c.collocations)}</div>` : ''}
            ${(base || related.length) ? `<div class="related-row">${base ? `<span class="pill orange base-chip chip-jump" data-jump="${base.id}" title="${this._esc(base.word + ': ' + (base.meaning || ''))}">源自 ${this._esc(base.word)}${base.meaning ? '(' + this._esc(shortMeaning(base.meaning, 10)) + ')' : ''}</span>` : ''}${related.length ? `<span class="related-label">派生</span>${related.map((w) => `<span class="pill gray related-chip chip-jump" data-jump="${w.id}" title="${this._esc(w.word + ': ' + (w.meaning || ''))}">${this._esc(w.word)}</span>`).join('')}` : ''}</div>` : ''}
            ${c.example ? `<div class="example">${this._esc(c.example)}</div>` : ''}
          </div>
        </div>
      </div>`;
    this.root.querySelector('#flip-card').addEventListener('click', () => this.flip());
    this.root.querySelector('#peek-back')?.addEventListener('click', () => this.returnFromPeek());
    this._bindJumps();
    this._bindKeys();
  }

  /** 绑定词条 chip 跳转 */
  _bindJumps() {
    this.root.querySelectorAll('[data-jump]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const w = (wordsCache || []).find((x) => x.id === el.dataset.jump);
        if (w) this.jumpTo(w);
      });
    });
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
    const rated = this.card;
    const wasHistory = this.pos < this.history.length;
    const res = await window.api.study.answer(rated.id, rating);
    if (!res.ok) {
      // 词已被删除等异常:丢弃当前卡,重开会话自愈
      this.start();
      return;
    }
    if (!wasHistory) this.history.push(rated);

    // 刷新队列并对齐到新队首
    const q = await window.api.study.queue();
    this.queue = q.cards || [];
    if (this.queue.length) {
      const headId = res.card ? res.card.id : this.queue[0].id;
      const idx = this.queue.findIndex((c) => c.id === headId);
      this.pos = this.history.length + Math.max(0, idx);
      this._renderFront();
    } else if (res.waiting && res.waiting.length) {
      this._renderWaiting(res.waiting);
    } else {
      this._renderDone();
    }
  }

  _renderWaiting(waiting) {
    this._clearPoll(); // 清旧轮询,防止叠加
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
      const q = await window.api.study.queue();
      if (q.cards && q.cards.length) {
        this._clearPoll();
        this.queue = q.cards;
        this.pos = this.history.length;
        this._renderFront();
      } else {
        const res = await window.api.study.next();
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
      } else if (e.key === 'ArrowLeft') {
        if (!this.peekCard && (this.state === 'front' || this.state === 'back')) { e.preventDefault(); this.nav(-1); }
      } else if (e.key === 'ArrowRight') {
        if (!this.peekCard && (this.state === 'front' || this.state === 'back')) { e.preventDefault(); this.nav(1); }
      } else if (e.key === 'Escape') {
        if (this.compact) { window.api.app.hidePopup(); }
        else if (this.peekCard) { this.returnFromPeek(); }
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
