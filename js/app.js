'use strict';

/**
 * 主窗口框架:视图路由、导航角标、Toast / 模态框公共组件。
 * 各视图模块导出 { mount(root), refresh() };切换时懒挂载,数据变更时刷新当前视图。
 */

import './store.js'; // web 版数据层:定义 window.api(localStorage)
import { mountLibrary, refreshLibrary, parseLines } from './views/library.js';
import { mountLearn, refreshLearn } from './views/learn.js';
import { mountQuiz, refreshQuiz } from './views/quiz.js';
import { mountStats, refreshStats } from './views/stats.js';

// 内置词表内容版本(词表例句等内容更新后 +1,旧库自动无损升级)
const BUILTIN_CONTENT_VERSION = 2;

const views = {
  learn: { mount: mountLearn, refresh: refreshLearn, el: null },
  library: { mount: mountLibrary, refresh: refreshLibrary, el: null },
  quiz: { mount: mountQuiz, refresh: refreshQuiz, el: null },
  stats: { mount: mountStats, refresh: refreshStats, el: null },
};

let currentView = null;

// ---------- 视图路由 ----------

function switchView(name) {
  if (!views[name] || currentView === name) return;
  if (currentView) {
    views[currentView].el.classList.remove('active');
    document.getElementById(`nav-${currentView}`).classList.remove('active');
  }
  currentView = name;
  const v = views[name];
  if (!v.el) {
    v.el = document.getElementById(`view-${name}`);
    v.mount(v.el);
  }
  v.el.classList.add('active');
  document.getElementById(`nav-${name}`).classList.add('active');
  v.refresh();
}

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

// ---------- 导航角标(学习视图显示待学数,词库显示词数) ----------

async function refreshBadges() {
  try {
    const summary = await window.api.study.summary();
    const learnBadge = document.getElementById('badge-learn');
    const due = summary.queueLen;
    learnBadge.hidden = due === 0;
    learnBadge.textContent = due > 99 ? '99+' : String(due);
    const libBadge = document.getElementById('badge-library');
    const total = summary.states.total;
    libBadge.hidden = total === 0;
    libBadge.textContent = String(total);
  } catch { /* 主进程未就绪时忽略 */ }
}

// ---------- Toast ----------

export function toast(msg, type = 'info') {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'error' : ''}`;
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity 0.25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
  }, 2200);
}

// ---------- 模态框 ----------

/**
 * 打开模态框。返回 { close, el }。
 * @param {object} opts { title, desc, bodyEl|html, onClose }
 */
export function openModal({ title, desc = '', body = null, actions = [], onClose = null }) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const modal = document.createElement('div');
  modal.className = 'modal';
  const h = document.createElement('h3');
  h.textContent = title;
  modal.appendChild(h);
  if (desc) {
    const d = document.createElement('div');
    d.className = 'modal-desc';
    d.textContent = desc;
    modal.appendChild(d);
  }
  if (typeof body === 'string') {
    const wrap = document.createElement('div');
    wrap.innerHTML = body;
    modal.appendChild(wrap);
  } else if (body) {
    modal.appendChild(body);
  }
  const actionsRow = document.createElement('div');
  actionsRow.className = 'modal-actions';
  for (const a of actions) {
    const btn = document.createElement('button');
    btn.className = `btn ${a.className || ''}`;
    btn.textContent = a.label;
    btn.addEventListener('click', async () => {
      if (a.onClick && (await a.onClick(modal)) === false) return; // 返回 false 阻止关闭
      close();
    });
    actionsRow.appendChild(btn);
  }
  modal.appendChild(actionsRow);
  mask.appendChild(modal);
  document.getElementById('modal-root').appendChild(mask);

  function close() {
    mask.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  }
  function onKey(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  }
  document.addEventListener('keydown', onKey);
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });

  // 打开模态框后自动聚焦第一个输入框
  setTimeout(() => {
    const first = modal.querySelector('input, textarea, select');
    if (first) first.focus();
  }, 50);

  return { close, el: modal };
}

export function confirmModal(title, text, { danger = false, okLabel = '确定' } = {}) {
  return new Promise((resolve) => {
    openModal({
      title,
      body: `<p style="color:var(--text-2);font-size:13.5px;line-height:1.7">${text}</p>`,
      actions: [
        { label: '取消', className: 'ghost', onClick: () => resolve(false) },
        { label: okLabel, className: danger ? 'primary danger' : 'primary', onClick: () => resolve(true) },
      ],
      onClose: () => resolve(false),
    });
  });
}

// ---------- 数据变更广播 → 刷新 ----------

// 云同步:配置了令牌则启动时同步一次;数据变更后 30 秒防抖自动上传(kind=cloud 自身除外)
let cloudTimer = null;
async function autoCloudSync() {
  try {
    const settings = await window.api.settings.get();
    if (!settings.cloud || !settings.cloud.token || settings.cloud.auto === false) return;
    await window.api.cloud.sync();
  } catch (e) { console.error('自动云同步失败:', e); }
}
function scheduleCloudPush() {
  if (cloudTimer) clearTimeout(cloudTimer);
  cloudTimer = setTimeout(autoCloudSync, 30 * 1000);
}

window.api.onDataChanged(({ kind }) => {
  refreshBadges();
  if (kind !== 'cloud') scheduleCloudPush();
  if (currentView && views[currentView].refresh) {
    views[currentView].refresh(kind);
  }
});


/** 词表内容升级:只更新释义/例句等内容字段,保留全部学习进度 */
async function upgradeBuiltinContent() {
  try {
    const settings = await window.api.settings.get();
    if (settings.contentVersion >= BUILTIN_CONTENT_VERSION) return;
    const res = await window.api.builtin.wordlist();
    if (!res.ok) return;
    const r = await window.api.words.syncContent(parseLines(res.content));
    await window.api.settings.set({ contentVersion: BUILTIN_CONTENT_VERSION });
    if (r.updated) toast(`词表内容已更新(${r.updated} 词,真题例句已补全)`);
  } catch (e) {
    console.error('词表内容升级失败:', e);
  }
}

// 首次打开自动导入内置《冲分宝》词表(词库为空且未曾导入过时)
async function seedBuiltinWordlist() {
  try {
    const summary = await window.api.study.summary();
    if (summary.states.total > 0) return;
    const settings = await window.api.settings.get();
    if (settings.seeded) return;
    const res = await window.api.builtin.wordlist();
    if (!res.ok) return;
    const items = parseLines(res.content);
    const importRes = await window.api.words.import(items);
    await window.api.settings.set({ seeded: true, contentVersion: BUILTIN_CONTENT_VERSION });
    toast(`已自动导入内置《冲分宝》词表 ${importRes.added} 词,开始学习吧`);
  } catch (e) {
    console.error('内置词表初始化失败:', e);
  }
}

// 初始:默认进学习视图
switchView('learn');
refreshBadges();
seedBuiltinWordlist().then(upgradeBuiltinContent).then(autoCloudSync);
setInterval(refreshBadges, 30 * 1000); // 学习卡分钟级到期,定时刷新角标
