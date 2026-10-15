'use strict';

/**
 * 统计与设置视图:今日数据、连续打卡、词库状态分布、近 7 天活跃图(手写 SVG)、学习设置。
 */

import { toast } from '../app.js';

let root = null;

export function mountStats(el) {
  root = el;
  refreshStats();
}

export function refreshStats() {
  if (!root) return;
  paint();
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function paint() {
  const s = await window.api.stats.summary();
  const { states, today, streak, last7, settings } = s;
  const total = states.total || 0;

  const distRows = [
    { label: '新词', n: states.new, color: '#a1a1a6' },
    { label: '学习中', n: states.learning, color: '#f59e0b' },
    { label: '复习中', n: states.review - states.mastered, color: '#6366f1' },
    { label: '已掌握', n: states.mastered, color: '#22c55e' },
  ];
  const maxTotal = Math.max(1, ...last7.map((d) => d.newLearned + d.reviews));
  const stickyEnabled = settings.sticky ? settings.sticky.enabled !== false : true;
  const cloud = settings.cloud || { token: '', repo: 'honbit/wordmate-sync', auto: true, lastSyncAt: 0 };

  root.innerHTML = `
    <div class="page-head"><h1>统计</h1><span class="sub">坚持就是胜利</span></div>

    <div class="stat-grid">
      <div class="stat-card"><div class="s-num">${states.dueNow}</div><div class="s-label">当前待学</div></div>
      <div class="stat-card"><div class="s-num">${today.newLearned || 0}</div><div class="s-label">今日新学</div></div>
      <div class="stat-card"><div class="s-num">${today.reviews || 0}</div><div class="s-label">今日复习</div></div>
      <div class="stat-card"><div class="s-num">${streak} 天</div><div class="s-label">连续打卡 🔥</div></div>
      <div class="stat-card"><div class="s-num">${states.mastered}</div><div class="s-label">已掌握(≥21天间隔)</div></div>
      <div class="stat-card"><div class="s-num">${total}</div><div class="s-label">词库总数</div></div>
    </div>

    <div class="section-card">
      <h3>词库状态分布</h3>
      ${distRows.map((d) => `
        <div class="dist-row">
          <span class="d-label">${d.label}</span>
          <div class="d-track"><div class="d-fill" style="width:${total ? Math.round((d.n / total) * 100) : 0}%;background:${d.color}"></div></div>
          <span class="d-num">${d.n}</span>
        </div>`).join('')}
    </div>

    <div class="section-card">
      <h3>近 7 天学习量</h3>
      ${barChartSvg(last7, maxTotal)}
      <div style="display:flex;gap:16px;margin-top:10px;font-size:12px;color:var(--text-2)">
        <span><i style="display:inline-block;width:10px;height:10px;border-radius:3px;background:#6366f1;vertical-align:-1px"></i> 新学</span>
        <span><i style="display:inline-block;width:10px;height:10px;border-radius:3px;background:rgba(99,102,241,0.35);vertical-align:-1px"></i> 复习</span>
      </div>
    </div>

    <div class="section-card">
      <h3>学习设置</h3>
      <div class="form-row">
        <span class="f-label">每日新词上限</span>
        <input class="input" id="set-new" type="number" min="1" max="500" value="${settings.newPerDay}">
        <span class="f-hint">每天最多引入多少新卡</span>
      </div>
      <div class="form-row">
        <span class="f-label">每日复习上限</span>
        <input class="input" id="set-review" type="number" min="1" max="1000" value="${settings.reviewPerDay}">
        <span class="f-hint">积压过多时可调低</span>
      </div>
      <div class="form-row">
        <span class="f-label">测验选项数</span>
        <select class="select" id="set-choices">
          ${[3, 4, 5, 6].map((n) => `<option value="${n}" ${settings.quizChoiceCount === n ? 'selected' : ''}>${n} 选 1</option>`).join('')}
        </select>
      </div>
${window.IS_WEB ? '' : `
      <div class="form-row">
        <span class="f-label">全局快捷键</span>
        <select class="select" id="set-shortcut">
          ${shortcutOptions(settings.globalShortcut)}
        </select>
        <span class="f-hint">随时呼出菜单栏速记小窗</span>
      </div>
      <div class="form-row">
        <span class="f-label">桌面便笺</span>
        <select class="select" id="set-sticky">
          <option value="on" ${stickyEnabled ? 'selected' : ''}>显示(常驻桌面提醒)</option>
          <option value="off" ${!stickyEnabled ? 'selected' : ''}>隐藏</option>
        </select>
        <span class="f-hint">拖动可调整位置,自动记忆;📌 可切换置顶</span>
      </div>
`}
            <div class="section-card">
        <h3>☁️ 云同步(手机 ⇄ 电脑)</h3>
        <p style="font-size:12.5px;color:var(--text-2);line-height:1.7;margin-bottom:6px">
          进度自动同步到 GitHub 私有仓库 <b>${esc(cloud.repo)}</b>,两端按词合并、互不覆盖。<br>
          令牌创建:GitHub → Settings → Developer settings → <b>Fine-grained tokens</b> →
          只选 <b>${esc(cloud.repo)}</b> 仓库、权限只给 <b>Contents: Read and write</b>(电脑版设置页有图文步骤)
        </p>
        <div class="form-row">
          <span class="f-label">GitHub 访问令牌</span>
          <input class="input" id="set-cloud-token" type="password" placeholder="github_pat_…(只存本机)" value="${esc(cloud.token || '')}" autocomplete="off" style="width:260px">
        </div>
        <div class="form-row">
          <span class="f-label">自动同步</span>
          <select class="select" id="set-cloud-auto">
            <option value="on" ${cloud.auto !== false ? 'selected' : ''}>开启</option>
            <option value="off" ${cloud.auto === false ? 'selected' : ''}>仅手动</option>
          </select>
          <button class="btn" id="set-cloud-sync" style="margin-left:8px">⇅ 立即同步</button>
        </div>
        <p class="f-hint" id="cloud-status">${cloud.lastSyncAt ? '上次同步:' + new Date(cloud.lastSyncAt).toLocaleString() : '尚未同步过'}</p>
      </div>

      <div class="section-card">
        <h3>数据与同步</h3>
        <p style="font-size:12.5px;color:var(--text-2);line-height:1.7;margin-bottom:10px">
          词库、学习进度、设置可导出为 JSON,在手机与电脑之间互传(导入会覆盖本机数据)
        </p>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn" id="set-export">📤 导出进度</button>
          <button class="btn" id="set-import">📥 导入进度</button>
        </div>
      </div>
      <div style="margin-top:14px"><button class="btn primary" id="set-save">保存设置</button></div>
    </div>`;

  root.querySelector('#set-cloud-sync')?.addEventListener('click', async () => {
    await window.api.settings.set({ cloud: { token: root.querySelector('#set-cloud-token').value } });
    const btn = root.querySelector('#set-cloud-sync');
    btn.disabled = true; btn.textContent = '同步中…';
    const res = await window.api.cloud.sync();
    btn.disabled = false; btn.textContent = '⇅ 立即同步';
    if (res.ok) toast(`同步成功,云端共 ${res.count} 词` + (res.remoteDevice ? `(来自 ${res.remoteDevice})` : ''));
    else toast(res.error || '同步失败', 'error');
    const st = root.querySelector('#cloud-status');
    if (st && res.ok) st.textContent = '上次同步:' + new Date().toLocaleString();
  });
  root.querySelector('#set-export')?.addEventListener('click', async () => {
    const res = await window.api.store.export();
    if (res.ok) toast('已导出进度 JSON');
  });
  root.querySelector('#set-import')?.addEventListener('click', async () => {
    const res = await window.api.store.import();
    if (res.ok) toast(`已导入 ${res.count} 词及进度`);
    else if (res.error) toast(res.error, 'error');
  });
  root.querySelector('#set-save').addEventListener('click', async () => {
    const res = await window.api.settings.set({
      newPerDay: root.querySelector('#set-new').value,
      reviewPerDay: root.querySelector('#set-review').value,
      quizChoiceCount: root.querySelector('#set-choices').value,
      globalShortcut: root.querySelector('#set-shortcut').value,
      sticky: { enabled: root.querySelector('#set-sticky').value === 'on' },
      cloud: { token: root.querySelector('#set-cloud-token').value, auto: root.querySelector('#set-cloud-auto').value === 'on' },
    });
    if (res.ok) toast('设置已保存');
  });
}

function shortcutOptions(current) {
  const opts = [
    { v: 'CommandOrControl+Shift+L', t: '⌘ ⇧ L(默认)' },
    { v: 'CommandOrControl+Shift+D', t: '⌘ ⇧ D' },
    { v: 'CommandOrControl+Shift+V', t: '⌘ ⇧ V' },
    { v: 'Alt+Space', t: '⌥ Space' },
    { v: '', t: '关闭快捷键' },
  ];
  return opts.map((o) => `<option value="${o.v}" ${current === o.v ? 'selected' : ''}>${o.t}</option>`).join('');
}

/** 手写 SVG 柱状图:新学(实色)+ 复习(浅色)堆叠 */
function barChartSvg(last7, maxTotal) {
  const W = 640;
  const H = 150;
  const pad = 20;
  const chartH = H - pad * 2;
  const bw = 44;
  const gap = (W - pad * 2 - bw * last7.length) / (last7.length - 1 || 1);

  let bars = '';
  let labels = '';
  last7.forEach((d, i) => {
    const total = d.newLearned + d.reviews;
    const x = pad + i * (bw + gap);
    const hTotal = Math.round((total / maxTotal) * chartH);
    const hNew = Math.round((d.newLearned / maxTotal) * chartH);
    const hReview = hTotal - hNew;
    const yTotal = H - pad - hTotal;
    // 新学放上层,复习下层
    bars += `<rect x="${x}" y="${yTotal}" width="${bw}" height="${hNew}" rx="4" fill="#6366f1"></rect>`;
    bars += `<rect x="${x}" y="${yTotal + hNew}" width="${bw}" height="${hReview}" rx="4" fill="rgba(99,102,241,0.35)"></rect>`;
    if (total > 0) {
      bars += `<text x="${x + bw / 2}" y="${yTotal - 5}" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.65">${total}</text>`;
    }
    labels += `<text x="${x + bw / 2}" y="${H - 4}" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.45">${i === last7.length - 1 ? '今天' : d.label}</text>`;
  });

  return `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;display:block;color:var(--text)">
      ${bars}${labels}
    </svg>`;
}
