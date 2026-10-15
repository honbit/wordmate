'use strict';

/**
 * 学习视图:今日进度头部 + StudySession 翻卡引擎。
 */

import { StudySession } from '../study.js';

let session = null;
let headEl = null;

export function mountLearn(root) {
  root.innerHTML = `
    <div class="study-head">
      <h1 style="font-size:18px">今日学习</h1>
      <div class="progress-track" style="max-width:420px"><div class="progress-fill" id="learn-progress" style="width:0%"></div></div>
      <span class="sub" id="learn-progress-text" style="font-size:12.5px;color:var(--text-2)"></span>
    </div>
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
  const { counts, states, settings, queueLen } = summary;
  const doneToday = (counts.newSeenToday || 0) + (counts.reviewsToday || 0);
  const total = doneToday + queueLen;
  const pct = total > 0 ? Math.round((doneToday / total) * 100) : 100;
  const bar = document.getElementById('learn-progress');
  const text = document.getElementById('learn-progress-text');
  if (bar) bar.style.width = `${pct}%`;
  if (text) {
    text.textContent = states.total === 0
      ? '词库为空,先去「词库」添加单词'
      : `新学 ${counts.newSeenToday || 0}/${settings.newPerDay} · 复习 ${counts.reviewsToday || 0} · 待学 ${queueLen}`;
  }
}
