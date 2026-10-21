/* 由 lib/srs.js 自动生成(追加 ESM 导出),修改请改源文件后重新生成 */
'use strict';

/**
 * SM-2 改良版间隔重复调度(艾宾浩斯遗忘曲线的工程化实现)。
 * 纯函数、无 IO,主进程与单测共用。
 */

const MIN = 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

// 学习阶段两步制(Anki 式):1 分钟 → 10 分钟,两步都答「认识」才毕业。
// 侧重当日内反复重现,适合需要大量重复巩固的记忆场景。
const LEARNING_STEPS_MS = [1 * MIN, 10 * MIN];
const HARD_REPEAT_MS = 5 * MIN;
// 毕业:Good → 1 天后复习,Easy → 4 天后复习
const GRADUATE_GOOD_DAYS = 1;
const GRADUATE_EASY_DAYS = 4;

const MIN_EASE = 1.3;
const MAX_INTERVAL_DAYS = 365;
const EASE_DELTA = { again: -0.20, hard: -0.15, good: 0, easy: 0.15 };
const HARD_FACTOR = 1.2;
const EASY_BONUS = 1.3;
// 统计口径:复习间隔 ≥ 21 天视为"已掌握"
const MASTERED_INTERVAL_DAYS = 21;

const RATINGS = ['again', 'hard', 'good', 'easy'];

function round2(x) { return Math.round(x * 100) / 100; }
function round1(x) { return Math.round(x * 10) / 10; }

/** 新卡的初始调度状态 */
function newSrs(now = Date.now()) {
  return {
    state: 'new',        // new | learning | review
    ease: 2.5,
    interval: 0,         // 天(复习卡)
    step: 0,             // 学习阶段步索引(0/1;≥步数表示已毕业)
    dueAt: now,
    reps: 0,
    lapses: 0,
    lastReviewedAt: 0,
  };
}

function clampEase(e) { return Math.max(MIN_EASE, round2(e)); }

/** 对一张卡评分,返回新的 srs 对象(不修改入参) */
function schedule(srs, rating, now = Date.now()) {
  if (!RATINGS.includes(rating)) throw new Error('无效评分: ' + rating);
  const prev = srs.state;
  const s = {
    ...srs,
    reps: srs.reps + 1,
    lastReviewedAt: now,
  };

  // 「忘了」:无论何阶段,回到学习阶段第一步;复习卡遗忘记一次 lapse
  if (rating === 'again') {
    s.ease = clampEase(srs.ease + EASE_DELTA.again);
    s.state = 'learning';
    s.interval = 0;
    s.step = 0;
    if (prev === 'review') s.lapses = srs.lapses + 1;
    s.dueAt = now + LEARNING_STEPS_MS[0];
    return s;
  }

  // 新卡 / 学习中卡:两步学习期走完才毕业
  if (prev === 'new' || prev === 'learning') {
    // 兼容无 step 字段的旧数据
    const step = Number.isInteger(srs.step) ? srs.step : 0;
    if (rating === 'hard') {
      s.state = 'learning';
      s.interval = 0;
      s.step = step;
      s.dueAt = now + HARD_REPEAT_MS;
    } else if (rating === 'good') {
      if (step + 1 >= LEARNING_STEPS_MS.length) {
        s.state = 'review';
        s.interval = GRADUATE_GOOD_DAYS;
        s.step = LEARNING_STEPS_MS.length;
        s.dueAt = now + GRADUATE_GOOD_DAYS * DAY;
      } else {
        s.state = 'learning';
        s.interval = 0;
        s.step = step + 1;
        s.dueAt = now + LEARNING_STEPS_MS[step + 1];
      }
    } else { // easy:跳过学习期直接毕业,间隔 4 天
      s.ease = clampEase(srs.ease + EASE_DELTA.easy);
      s.state = 'review';
      s.interval = GRADUATE_EASY_DAYS;
      s.step = LEARNING_STEPS_MS.length;
      s.dueAt = now + GRADUATE_EASY_DAYS * DAY;
    }
    return s;
  }

  // 复习卡 hard / good / easy
  s.ease = clampEase(srs.ease + EASE_DELTA[rating]);
  if (rating === 'hard') {
    s.interval = Math.max(1, round1(srs.interval * HARD_FACTOR));
  } else if (rating === 'good') {
    s.interval = Math.max(srs.interval + 1, round1(srs.interval * s.ease));
  } else {
    s.interval = Math.max(srs.interval + 1, round1(srs.interval * s.ease * EASY_BONUS));
  }
  s.interval = Math.min(MAX_INTERVAL_DAYS, s.interval);
  s.state = 'review';
  s.dueAt = now + s.interval * DAY;
  return s;
}

/** 评分按钮上展示的各档预测间隔文本 */
function previewIntervals(srs, now = Date.now()) {
  const out = {};
  for (const r of RATINGS) {
    const next = schedule(srs, r, now);
    out[r] = humanizeInterval(next.dueAt - now);
  }
  return out;
}

function humanizeInterval(ms) {
  if (ms < MIN) return '<1分钟';
  if (ms < 60 * MIN) return Math.round(ms / MIN) + '分钟';
  if (ms < DAY) return Math.round(ms / (60 * MIN)) + '小时';
  const days = ms / DAY;
  return (days >= 10 ? Math.round(days) : round1(days)) + '天';
}

function isDue(srs, now = Date.now()) {
  if (srs.state === 'new') return true;
  return srs.dueAt <= now;
}

function isMastered(srs) {
  return srs.state === 'review' && srs.interval >= MASTERED_INTERVAL_DAYS;
}

/** 词的 List 编号(标签 "List N");无标签的自定义词返回 0(视为始终可用) */
function listNumOf(word) {
  for (const t of word.tags || []) {
    const m = /^List\s*(\d+)$/i.exec(String(t));
    if (m) return Number(m[1]);
  }
  return 0;
}

/**
 * 构建当前应学习的卡片队列。
 * 优先级:到期学习卡 > 到期复习卡(最旧优先)> 新卡。
 * 新卡投放两种模式:
 *   - counts/limits 固定词数:受 newPerDay 减去今日已学约束
 *   - limits.listBoundary > 0 按单元推进:只投放 ≤ listBoundary 的 List 新卡,
 *     边界由调用方计算(今日起点 + 每日目标 + 手动解锁;词表无 List 标签时自动回退固定词数)
 * @param {Array} words 词表(含 srs 字段)
 * @param {Object} counts 今日已学新卡/已完成复习数 { newSeenToday, reviewsToday }
 * @param {Object} limits { newPerDay, reviewPerDay, listPerDay }
 */
function buildQueue(words, counts = {}, limits = {}, now = Date.now()) {
  const { newSeenToday = 0, reviewsToday = 0 } = counts;
  const { newPerDay = 20, reviewPerDay = 200, listBoundary = 0 } = limits;

  const learning = [];
  const review = [];
  const fresh = [];
  for (const w of words) {
    const s = w.srs;
    if (!s) continue;
    if (s.state === 'new') fresh.push(w);
    else if (s.state === 'learning') { if (s.dueAt <= now) learning.push(w); }
    else if (s.dueAt <= now) review.push(w);
  }
  learning.sort((a, b) => a.srs.dueAt - b.srs.dueAt);
  review.sort((a, b) => a.srs.dueAt - b.srs.dueAt);
  fresh.sort((a, b) => a.createdAt - b.createdAt);

  const reviewBudget = Math.max(0, reviewPerDay - reviewsToday);

  let newCards;
  const hasListTags = fresh.some((w) => listNumOf(w) > 0);
  if (listBoundary > 0 && hasListTags) {
    newCards = fresh.filter((w) => listNumOf(w) <= listBoundary);
  } else {
    const newBudget = Math.max(0, newPerDay - newSeenToday);
    newCards = fresh.slice(0, Math.min(newBudget, fresh.length));
  }

  return [
    ...learning,
    ...review.slice(0, reviewBudget),
    ...newCards,
  ];
}

/** 学习中但尚未到期的卡(分钟级等待) */
function waitingLearning(words, now = Date.now()) {
  return words.filter((w) => w.srs && w.srs.state === 'learning' && w.srs.dueAt > now)
    .sort((a, b) => a.srs.dueAt - b.srs.dueAt);
}

/** 词库分布统计 */
function summarizeStates(words, now = Date.now()) {
  const summary = { total: 0, new: 0, learning: 0, review: 0, mastered: 0, dueNow: 0 };
  for (const w of words) {
    const s = w.srs;
    if (!s) continue;
    summary.total++;
    if (s.state === 'new') summary.new++;
    else if (s.state === 'learning') summary.learning++;
    else {
      summary.review++;
      if (isMastered(s)) summary.mastered++;
    }
    if (isDue(s, now)) summary.dueNow++;
  }
  return summary;
}

/** 本地时区日期键,供 reviewLog 聚合 */
function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 从今天往前数的连续活跃天数(今天无活动则从昨天算) */
function streakDays(reviewLog, todayKey = dayKey()) {
  let streak = 0;
  let key = todayKey;
  const has = (k) => {
    const l = reviewLog[k];
    return !!l && ((l.newLearned || 0) + (l.reviews || 0) + (l.quizCorrect || 0) + (l.quizWrong || 0)) > 0;
  };
  if (!has(key)) {
    // 今天还没学不算断,从昨天回溯
    key = shiftDayKey(key, -1);
  }
  while (has(key)) {
    streak++;
    key = shiftDayKey(key, -1);
  }
  return streak;
}

function shiftDayKey(key, deltaDays) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d + deltaDays);
  return dayKey(dt.getTime());
}

if (typeof module !== "undefined") module.exports = {
  MIN, DAY,
  MIN_EASE, MAX_INTERVAL_DAYS, MASTERED_INTERVAL_DAYS,
  RATINGS,
  newSrs, schedule, previewIntervals, humanizeInterval,
  isDue, isMastered,
  buildQueue, waitingLearning, summarizeStates, listNumOf,
  dayKey, shiftDayKey, streakDays,
};
export {
  MIN, DAY, MIN_EASE, MAX_INTERVAL_DAYS, MASTERED_INTERVAL_DAYS, RATINGS,
  newSrs, schedule, previewIntervals, humanizeInterval, isDue, isMastered,
  buildQueue, waitingLearning, summarizeStates, listNumOf, dayKey, shiftDayKey, streakDays,
};
