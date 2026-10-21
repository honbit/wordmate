'use strict';

/**
 * 学习视图:今日进度头部 + StudySession 翻卡引擎。
 */

import { StudySession } from '../study.js';
import { toast } from '../app.js';

let session = null;
let headEl = null;

export function mountLearn(root) {
  root.innerHTML = `
    <div class="study-head">
      <h1 style="font-size:18px">今日学习</h1>
      <div class="progress-track" style="max-width:420px"><div class="progress-fill" id="learn-progress" style="width:0%"></div></div>
      <span class="sub" id="learn-progress-text" style="font-size:12.5px;color:var(--text-2)"></span>
    </div>
    <div id="learn-goal-banner"></div>
    <div id="learn-session"></div>`;
  headEl = root.querySelector('.study-head');
  session = new StudySession(root.querySelector('#learn-session'));
  session.start();
}

/** 数据变更时:刷新头部进度;会话已结束则续下一张;词库变更时校验当前卡仍存在 */
export async function refreshLearn(kind) {
  if (!session) return;
  await paintHead();
  if (session.state === 'done' || session.state === 'waiting' || session.state === 'idle') {
    session.start();
  } else if (kind === 'words' && session.card) {
    const words = await window.api.words.list();
    if (!words.some((w) => w.id === session.card.id)) session.start();
  }
}

async function paintHead() {
  const summary = await window.api.study.summary();
  const { counts, states, settings, queueLen, listProgress } = summary;
  const doneToday = (counts.newSeenToday || 0) + (counts.reviewsToday || 0);
  const total = doneToday + queueLen;
  const pct = total > 0 ? Math.round((doneToday / total) * 100) : 100;
  const bar = document.getElementById('learn-progress');
  const text = document.getElementById('learn-progress-text');
  if (bar) bar.style.width = `${pct}%`;
  if (text) {
    if (states.total === 0) {
      text.textContent = '词库为空,先去「词库」添加单词';
    } else if (settings.scheduleMode === 'list' && listProgress) {
      const adv = listProgress.advancedToday || 0;
      const goal = listProgress.listPerDay || 2;
      const goalText = adv >= goal ? `今日 List +${adv} ✓` : `今日 List +${adv}/${goal}`;
      text.textContent = `新学 ${counts.newSeenToday || 0} · 复习 ${counts.reviewsToday || 0} · ${goalText} · 待学 ${queueLen}`;
    } else {
      text.textContent = `新学 ${counts.newSeenToday || 0}/${settings.newPerDay} · 复习 ${counts.reviewsToday || 0} · 待学 ${queueLen}`;
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  const goal = (listProgress && listProgress.listPerDay) || 2;
  const adv = (listProgress && listProgress.advancedToday) || 0;

  // 达成时刻:彩带 + 提示(每设备每天一次)
  if (listProgress && adv >= goal && settings.goalToastDay !== today) {
    await window.api.settings.set({ goalToastDay: today });
    toast(`🎯 今日 List 目标达成(+${adv}),可以收工啦!想继续背也随意`);
    launchConfetti();
  }

  // 达标横幅:首次完整提示;之后最小化为右下角悬浮按钮
  const banner = document.getElementById('learn-goal-banner');
  if (banner) {
    const locked = (listProgress && listProgress.lockedNew) || 0;
    const queueNew = summary.queueNew || 0;
    const bonus = (listProgress && listProgress.bonusToday) || 0;
    const dismissed = settings.goalBannerDay === today;
    const maxStudied = (listProgress && listProgress.maxStudied) || 0;
    const allowedMax = (listProgress && listProgress.allowedMax) || 0;
    // 收回条件:解锁过且新解锁内容还没学 —— 与横幅条件独立,随时可收回
    const canRelock = bonus > 0 && maxStudied < allowedMax;
    // 解锁提示条件:今日配额已学完 + 还有锁着的 List
    const showUnlock = locked > 0 && queueNew === 0 && adv + bonus >= goal;
    const relock = async () => {
      await window.api.settings.set({ listUnlock: { day: today, bonus: bonus - 1 } });
      toast('已收回解锁,回到今日目标边界 🔒');
    };
    if (showUnlock) {
      const nextList = allowedMax + 1;
      const unlock = async () => {
        await window.api.settings.set({ listUnlock: { day: today, bonus: bonus + 1 } });
        toast(`已解锁 List ${nextList},量力而行 💪`);
      };
      if (!dismissed) {
        banner.innerHTML = `
          <div class="goal-banner">
            <span>🎯 今日目标已达成(List +${adv})。要继续解锁新 List 吗?</span>
            <span style="flex:1"></span>
            ${canRelock ? `<button class="btn ghost sm" id="banner-relock" title="收回已解锁的 List">🔒 收回</button>` : ''}
            <button class="btn primary sm" id="unlock-next">解锁 List ${nextList} →</button>
            <button class="btn ghost sm" id="banner-min" title="最小化到右下角">知道了</button>
          </div>`;
        banner.querySelector('#unlock-next')?.addEventListener('click', unlock);
        banner.querySelector('#banner-relock')?.addEventListener('click', relock);
        banner.querySelector('#banner-min')?.addEventListener('click', () =>
          window.api.settings.set({ goalBannerDay: today }));
      } else {
        banner.innerHTML = `
          <div class="corner-dock">
            ${canRelock ? `<button class="corner-lock" id="corner-relock" title="收回已解锁的 List">🔒</button>` : ''}
            <button class="corner-unlock" id="corner-unlock" title="解锁 List ${nextList}">🔓 List ${nextList}</button>
          </div>`;
        banner.querySelector('#corner-unlock')?.addEventListener('click', unlock);
        banner.querySelector('#corner-relock')?.addEventListener('click', relock);
      }
    } else if (canRelock) {
      // 解锁了但还没学完:不提示解锁,但提供随时收回入口
      banner.innerHTML = `
        <div class="corner-dock">
          <button class="corner-lock" id="corner-relock" title="收回已解锁的 List ${allowedMax}(其中新词 ${queueNew} 个)">🔒 收回 List ${allowedMax}</button>
        </div>`;
      banner.querySelector('#corner-relock')?.addEventListener('click', relock);
    } else {
      banner.innerHTML = '';
    }
  }
}

/** 达成庆祝:中央礼花 + 左右加农炮 + 双色渐变纸片 + GOAL 大字(纯前端,无依赖) */
export function launchConfetti() {
  const cv = document.createElement('canvas');
  Object.assign(cv.style, { position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 300 });
  const dpr = window.devicePixelRatio || 1;
  const W = innerWidth;
  const H = innerHeight;
  cv.width = W * dpr;
  cv.height = H * dpr;
  document.body.appendChild(cv);
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);

  const colors = ['#6366f1', '#8b5cf6', '#f59e0b', '#22c55e', '#ef4444', '#06b6d4', '#ec4899', '#facc15', '#38bdf8', '#a3e635'];
  const pick = () => colors[(Math.random() * colors.length) | 0];

  // 双色渐变(按色对缓存)
  const gradCache = new Map();
  function gradOf(c1, c2, h) {
    const key = c1 + '|' + c2;
    let g = gradCache.get(key);
    if (!g) {
      g = ctx.createLinearGradient(0, -14, 0, 14);
      g.addColorStop(0, c1);
      g.addColorStop(1, c2);
      gradCache.set(key, g);
    }
    return g;
  }

  const mk = (x, y, vx, vy) => ({
    x, y, vx, vy,
    w: 5 + Math.random() * 6,
    h: 9 + Math.random() * 9,
    r: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.4,
    c1: pick(),
    c2: Math.random() < 0.55 ? pick() : null, // 55% 双色渐变
    round: Math.random() < 0.3,
  });

  const parts = [];
  // 中央礼花:全屏横向铺开,不会偏出视野
  for (let i = 0; i < 110; i++) {
    parts.push(mk(W / 2 + (Math.random() - 0.5) * W * 0.6, H * 0.34, (Math.random() - 0.5) * 9, -Math.random() * 12 - 4));
  }
  // 左侧加农炮:左下向右上喷射
  for (let i = 0; i < 75; i++) {
    parts.push(mk(W * 0.03, H * 0.86, 4 + Math.random() * 7, -11 - Math.random() * 9));
  }
  // 右侧加农炮:右下向左上喷射
  for (let i = 0; i < 75; i++) {
    parts.push(mk(W * 0.97, H * 0.86, -4 - Math.random() * 7, -11 - Math.random() * 9));
  }

  const t0 = performance.now();
  const DUR = 3600;
  (function tick(t) {
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.vy += 0.3; p.vx *= 0.996;
      p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.globalAlpha = Math.max(0, 1 - (t - t0) / DUR);
      if (p.round) {
        ctx.beginPath();
        ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2);
        ctx.fillStyle = p.c2 ? gradOf(p.c1, p.c2, p.h) : p.c1;
        ctx.fill();
      } else {
        ctx.fillStyle = p.c2 ? gradOf(p.c1, p.c2, p.h) : p.c1;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      }
      ctx.restore();
    }
    if (t - t0 < DUR) requestAnimationFrame(tick);
    else { cv.remove(); goal.remove(); }
  })(t0);

  // GOAL! 大字动画
  const goal = document.createElement('div');
  goal.className = 'goal-pop-text';
  goal.textContent = 'GOAL!';
  document.body.appendChild(goal);
  setTimeout(() => goal.remove(), DUR);
}
