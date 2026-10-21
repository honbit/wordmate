'use strict';

/**
 * 词库视图:表格 + 搜索筛选 + 添加/编辑 + 批量导入 + 导出 CSV。
 */

import { toast, openModal, confirmModal } from '../app.js';

const STATE_META = {
  new: { text: '新词', cls: 'gray' },
  learning: { text: '学习中', cls: 'orange' },
  review: { text: '复习中', cls: '' },
  mastered: { text: '已掌握', cls: 'green' },
};

let allWords = [];
let searchText = '';
let stateFilter = 'all';
let tagFilter = 'all';
let selected = new Set();

function stateOf(w) {
  return w.srs.state === 'review' && w.srs.interval >= 21 ? 'mastered' : w.srs.state;
}

function relDue(w) {
  if (w.srs.state === 'new') return '—';
  const diff = w.srs.dueAt - Date.now();
  if (diff <= 0) return '已到期';
  const min = Math.round(diff / 60000);
  if (min < 60) return `${min} 分钟后`;
  const hours = Math.round(min / 60);
  if (hours < 48) return `${hours} 小时后`;
  return `${Math.round(hours / 24)} 天后`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------- 视图骨架 ----------

function render() {
  const root = document.getElementById('view-library');
  root.innerHTML = `
    <div class="page-head">
      <h1>词库</h1>
      <span class="sub" id="lib-count"></span>
      <span class="spacer"></span>
      <input class="input" id="lib-search" placeholder="搜索单词 / 释义…" style="width:200px" value="${esc(searchText)}">
      <select class="select" id="lib-state-filter">
        <option value="all">全部状态</option>
        <option value="new">新词</option>
        <option value="learning">学习中</option>
        <option value="review">复习中</option>
        <option value="mastered">已掌握</option>
      </select>
      <select class="select" id="lib-tag-filter" title="按标签(List)筛选"></select>
      <button class="btn" id="lib-import">📥 批量导入</button>
      <button class="btn" id="lib-export">📤 导出</button>
      <button class="btn primary" id="lib-add">＋ 添加单词</button>
    </div>
    <div class="page-head" id="lib-bulk-bar" style="display:none;margin-top:-8px;margin-bottom:10px">
      <span class="sub">已选 <b id="lib-sel-count">0</b> 项</span>
      <span class="spacer"></span>
      <button class="btn danger sm" id="lib-bulk-delete">删除所选</button>
      <button class="btn ghost sm" id="lib-bulk-cancel">取消选择</button>
    </div>
    <div class="table-wrap" id="lib-table-wrap"></div>
  `;

  const searchEl = root.querySelector('#lib-search');
  searchEl.addEventListener('input', () => { searchText = searchEl.value; paintTable(); });

  const filterEl = root.querySelector('#lib-state-filter');
  filterEl.value = stateFilter;
  filterEl.addEventListener('change', () => { stateFilter = filterEl.value; paintTable(); });

  const tagEl = root.querySelector('#lib-tag-filter');
  const tags = [...new Set(allWords.flatMap((w) => w.tags || []))].sort((a, b) => {
    // List 10 排在 List 9 后面:按数字自然排序
    const na = a.match(/\d+/), nb = b.match(/\d+/);
    if (na && nb && a.replace(/\d+/, '') === b.replace(/\d+/, '')) return Number(na[0]) - Number(nb[0]);
    return a.localeCompare(b);
  });
  tagEl.innerHTML = `<option value="all">全部标签</option>` + tags.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
  tagEl.value = tags.includes(tagFilter) ? tagFilter : 'all';
  tagFilter = tagEl.value;
  tagEl.addEventListener('change', () => { tagFilter = tagEl.value; paintTable(); });

  root.querySelector('#lib-add').addEventListener('click', () => openWordModal());
  root.querySelector('#lib-import').addEventListener('click', openImportModal);
  root.querySelector('#lib-export').addEventListener('click', doExport);
  root.querySelector('#lib-bulk-cancel').addEventListener('click', () => { selected.clear(); paintTable(); });
  root.querySelector('#lib-bulk-delete').addEventListener('click', bulkDelete);

  paintTable();
}

function paintTable() {
  const root = document.getElementById('view-library');
  const wrap = root.querySelector('#lib-table-wrap');
  const countEl = root.querySelector('#lib-count');
  const bulkBar = root.querySelector('#lib-bulk-bar');

  const kw = searchText.trim().toLowerCase();
  const rows = allWords.filter((w) => {
    if (stateFilter !== 'all' && stateOf(w) !== stateFilter) return false;
    if (tagFilter !== 'all' && !(w.tags || []).includes(tagFilter)) return false;
    if (!kw) return true;
    return w.word.toLowerCase().includes(kw) || (w.meaning || '').toLowerCase().includes(kw);
  });

  countEl.textContent = allWords.length ? `共 ${allWords.length} 词,当前显示 ${rows.length}` : '';
  bulkBar.style.display = selected.size ? 'flex' : 'none';
  root.querySelector('#lib-sel-count').textContent = selected.size;

  if (!allWords.length) {
    wrap.innerHTML = `
      <div class="empty">
        <div class="emoji">📚</div>
        <h2>词库还是空的</h2>
        <p>先添加几个单词,或把词表粘贴进来批量导入</p>
        <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
          ${window.IS_WEB ? '<button class="btn" id="empty-cfb">📚 导入内置《冲分宝》2524 词</button>' : ''}
          <button class="btn primary" id="empty-add">＋ 添加第一个单词</button>
        </div>
      </div>`;
    wrap.querySelector('#empty-add')?.addEventListener('click', () => openWordModal());
    wrap.querySelector('#empty-cfb')?.addEventListener('click', () => importBuiltinCfb());
    return;
  }

  if (!rows.length) {
    wrap.innerHTML = `<div class="empty"><div class="emoji">🔍</div><h2>没有匹配的词</h2></div>`;
    return;
  }

  wrap.innerHTML = `
    <table class="data">
      <thead><tr>
        <th style="width:32px"><input type="checkbox" id="lib-check-all" ${selected.size === rows.length && rows.length ? 'checked' : ''}></th>
        <th>单词</th><th style="width:110px">音标</th><th>释义</th>
        <th style="width:86px">状态</th><th style="width:96px">到期</th><th style="width:120px">操作</th>
      </tr></thead>
      <tbody>
        ${rows.map((w) => `
          <tr data-id="${w.id}">
            <td><input type="checkbox" class="row-check" ${selected.has(w.id) ? 'checked' : ''}></td>
            <td class="word-cell" data-act="edit">${esc(w.word)}</td>
            <td class="muted">${esc(w.phonetic || '')}</td>
            <td>${esc(w.meaning)}${(w.tags || []).map((t) => ` <span class="pill gray">${esc(t)}</span>`).join('')}</td>
            <td><span class="pill ${STATE_META[stateOf(w)].cls}">${STATE_META[stateOf(w)].text}</span></td>
            <td class="muted">${relDue(w)}</td>
            <td>
              <button class="btn ghost sm" data-act="edit">编辑</button>
              <button class="btn ghost sm" data-act="reset" title="重置学习进度">重置</button>
              <button class="btn ghost sm danger" data-act="delete">删除</button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;

  wrap.querySelector('#lib-check-all').addEventListener('change', (e) => {
    if (e.target.checked) rows.forEach((w) => selected.add(w.id));
    else rows.forEach((w) => selected.delete(w.id));
    paintTable();
  });
  wrap.querySelectorAll('.row-check').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = cb.closest('tr').dataset.id;
      cb.checked ? selected.add(id) : selected.delete(id);
      paintTable();
    });
  });
  wrap.querySelectorAll('[data-act]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.closest('tr').dataset.id;
      const w = allWords.find((x) => x.id === id);
      if (!w) return;
      const act = el.dataset.act;
      if (act === 'edit') openWordModal(w);
      else if (act === 'reset') resetWord(w);
      else if (act === 'delete') deleteWord(w);
    });
  });
}

// ---------- 添加 / 编辑 ----------

function wordForm(w = {}) {
  const body = document.createElement('div');
  body.innerHTML = `
    <label class="label">单词 *</label>
    <input class="input" id="f-word" value="${esc(w.word || '')}" placeholder="如:abandon" autocomplete="off">
    <label class="label">音标(可选)</label>
    <input class="input" id="f-phonetic" value="${esc(w.phonetic || '')}" placeholder="如:/əˈbændən/" autocomplete="off">
    <label class="label">释义 *</label>
    <input class="input" id="f-meaning" value="${esc(w.meaning || '')}" placeholder="如:v. 放弃、抛弃" autocomplete="off">
    <label class="label">例句(可选)</label>
    <textarea class="input" id="f-example" rows="2" placeholder="He abandoned the car in the snow.">${esc(w.example || '')}</textarea>
    <label class="label">词根记忆(可选)</label>
    <input class="input" id="f-mnemonic" value="${esc(w.mnemonic || '')}" placeholder="pract(行为)+ice(名词后缀)→做法" autocomplete="off">
    <label class="label">常用搭配(可选,分号分隔)</label>
    <input class="input" id="f-colloc" value="${esc(w.collocations || '')}" placeholder="act on… 根据…采取行动;act as 充当" autocomplete="off">
    <label class="label">标签(可选,逗号分隔,如:List 5,高频)</label>
    <input class="input" id="f-tags" value="${esc((w.tags || []).join(', '))}" placeholder="List 5" autocomplete="off">
  `;
  return body;
}

function openWordModal(w = {}) {
  const isEdit = !!w.id;
  const body = wordForm(w);
  openModal({
    title: isEdit ? '编辑单词' : '添加单词',
    body,
    actions: [
      { label: '取消', className: 'ghost' },
      {
        label: isEdit ? '保存' : '添加',
        className: 'primary',
        onClick: async (modal) => {
          const payload = {
            word: modal.querySelector('#f-word').value,
            phonetic: modal.querySelector('#f-phonetic').value,
            meaning: modal.querySelector('#f-meaning').value,
            example: modal.querySelector('#f-example').value,
            mnemonic: modal.querySelector('#f-mnemonic').value,
            collocations: modal.querySelector('#f-colloc').value,
            tags: modal.querySelector('#f-tags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
          };
          if (!payload.word.trim() || !payload.meaning.trim()) {
            toast('单词和释义都不能为空', 'error');
            return false;
          }
          const res = isEdit ? await window.api.words.update(w.id, payload) : await window.api.words.add(payload);
          if (!res.ok) {
            toast(res.error, 'error');
            return false;
          }
          toast(isEdit ? '已保存' : `已添加「${payload.word.trim()}」`);
        },
      },
    ],
  });
}

async function deleteWord(w) {
  const ok = await confirmModal('删除单词', `确定删除「${w.word}」吗?学习进度会一并删除,不可恢复。`, { danger: true, okLabel: '删除' });
  if (!ok) return;
  await window.api.words.remove(w.id);
  toast(`已删除「${w.word}」`);
}

async function resetWord(w) {
  const ok = await confirmModal('重置学习进度', `「${w.word}」将回到"新词"状态,重新从第一天开始安排复习。`, { okLabel: '重置' });
  if (!ok) return;
  await window.api.words.reset(w.id);
  toast(`已重置「${w.word}」`);
}

async function bulkDelete() {
  const ok = await confirmModal('批量删除', `确定删除所选 ${selected.size} 个单词吗?不可恢复。`, { danger: true, okLabel: '全部删除' });
  if (!ok) return;
  const res = await window.api.words.removeMany([...selected]);
  selected.clear();
  toast(`已删除 ${res.removed} 个单词`);
}


/** 一键载入内置《考研英语词汇 冲分宝》高频分册词表(web 版) */
async function importBuiltinCfb() {
  try {
    const res = await window.api.builtin.wordlist();
    if (!res.ok) throw new Error(res.error || '读取失败');
    const text = res.content;
    const btn = document.querySelector('.modal #imp-text');
    if (btn) {
      if (btn.value.trim()) btn.value += '\n';
      btn.value += text;
      btn.dispatchEvent(new Event('input'));
    } else {
      openImportModal();
      setTimeout(() => {
        const t = document.querySelector('.modal #imp-text');
        t.value = text;
        t.dispatchEvent(new Event('input'));
      }, 120);
    }
  } catch (e) {
    toast('内置词表加载失败: ' + e.message, 'error');
  }
}

// ---------- 批量导入 ----------

/**
 * 解析多行文本为词条。支持的行格式:
 *   #List 5                (分组行:之后的词自动打上该标签,如书里的单元)
 *   word :: 释义            (推荐)
 *   word<Tab>释义
 *   word<Tab>音标<Tab>释义
 *   word,释义
 * 释义可用 " | " 分隔例句:word :: 释义 | 例句
 */
function parseLines(text) {
  const items = [];
  let currentTag = '';
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const header = line.match(/^#\s*(.+)$/);
    if (header) {
      currentTag = header[1].trim(); // 如 "List 5" → 后续词的标签
      continue;
    }
    let word = '', phonetic = '', meaning = '', example = '';
    if (line.includes('::')) {
      const [l, r] = line.split('::');
      word = l.trim();
      meaning = r.trim();
    } else if (line.includes('\t')) {
      const parts = line.split('\t').map((p) => p.trim()).filter(Boolean);
      word = parts[0] || '';
      if (parts.length >= 3) { phonetic = parts[1]; meaning = parts.slice(2).join(' '); }
      else meaning = parts.slice(1).join(' ');
    } else {
      const idx = line.search(/[,，]/);
      if (idx > 0) {
        word = line.slice(0, idx).trim();
        meaning = line.slice(idx + 1).trim();
      } else {
        const m = line.match(/^(\S+)\s+(.+)$/); // 英文单词 + 空格 + 中文释义
        if (m) { word = m[1]; meaning = m[2]; }
        else { word = line; meaning = ''; }
      }
    }
    // 释义中 " | " 之后为扩展段:记:词根 / 搭:搭配 / 例:例句(无前缀视为例句,向后兼容)
    let mnemonic = '';
    let collocations = '';
    const parts = meaning.split(' | ');
    meaning = parts[0].trim();
    for (const seg0 of parts.slice(1)) {
      const seg = seg0.trim();
      if (!seg) continue;
      if (seg.startsWith('记:')) mnemonic = seg.slice(2).trim();
      else if (seg.startsWith('搭:')) collocations = seg.slice(2).trim();
      else if (seg.startsWith('例:')) example = seg.slice(2).trim();
      else if (!example) example = seg;
    }
    // 释义开头的 [音标] 或 /音标/ 识别为音标字段
    const ph = meaning.match(/^(\[[^\]]{2,}\]|\/[^/]{2,}\/)\s*(.+)$/);
    if (ph) {
      phonetic = ph[1].slice(1, -1);
      meaning = ph[2].trim();
    }
    items.push({ word, phonetic, meaning, mnemonic, collocations, example, tags: currentTag ? [currentTag] : [] });
  }
  return items;
}

function openImportModal() {
  const body = document.createElement('div');
  body.innerHTML = `
    <div style="font-size:12.5px;color:var(--text-2);line-height:1.8;margin-bottom:8px">
      每行一个词,支持以下格式(自动识别):
      <code style="background:var(--hover);padding:1px 5px;border-radius:4px">word :: 释义</code>
      <code style="background:var(--hover);padding:1px 5px;border-radius:4px">word⇥释义</code>
      <code style="background:var(--hover);padding:1px 5px;border-radius:4px">word,释义</code>
      <br>分组行 <code style="background:var(--hover);padding:1px 5px;border-radius:4px">#List 5</code> 之后的词自动打上该标签(按书的单元导入用);
      释义后加 <code style="background:var(--hover);padding:1px 5px;border-radius:4px">| 例句</code> 可带例句
    </div>
    <textarea class="input" id="imp-text" rows="7" placeholder="abandon :: v. 放弃、抛弃 | He abandoned the car.&#10;delicious :: adj. 美味的&#10;resilience, n. 韧性"></textarea>
    <div class="import-parse-info" id="imp-info" hidden></div>
    <div class="import-preview" id="imp-preview" hidden></div>
    <div style="margin-top:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <button class="btn sm" id="imp-file">📄 从文件导入(TXT/CSV)</button>
      <button class="btn sm" id="imp-cfb">📚 导入内置《冲分宝》2524 词</button>
      <span class="muted" id="imp-file-name"></span>
    </div>
  `;

  const modal = openModal({
    title: '批量导入单词',
    body,
    actions: [
      { label: '取消', className: 'ghost' },
      {
        label: '导入选中的词',
        className: 'primary',
        onClick: async () => {
          const items = JSON.parse(modal.el.dataset.items || '[]').filter((x) => x._ok);
          if (!items.length) { toast('没有可导入的词', 'error'); return false; }
          const res = await window.api.words.import(items.map(({ _ok, ...w }) => w));
          toast(`导入成功 ${res.added} 词` + (res.skipped.length ? `,跳过 ${res.skipped.length} 词` : ''));
        },
      },
    ],
  });

  const textEl = modal.el.querySelector('#imp-text');
  const infoEl = modal.el.querySelector('#imp-info');
  const previewEl = modal.el.querySelector('#imp-preview');
  let existing = new Set();

  window.api.words.list().then((words) => {
    existing = new Set(words.map((w) => w.word.toLowerCase()));
    reparse();
  });

  function reparse() {
    const items = parseLines(textEl.value);
    for (const it of items) {
      it._ok = !!(it.word && it.meaning);
      it._dup = it._ok && existing.has(it.word.toLowerCase());
    }
    const okCount = items.filter((x) => x._ok && !x._dup).length;
    const dupCount = items.filter((x) => x._dup).length;
    const badCount = items.length - okCount - dupCount;

    modal.el.dataset.items = JSON.stringify(items);
    infoEl.hidden = false;
    infoEl.innerHTML = `解析出 <b>${items.length}</b> 行:可导入 <b class="good">${okCount}</b>`
      + (dupCount ? `,重复跳过 <b class="bad">${dupCount}</b>` : '')
      + (badCount ? `,格式无效 <b class="bad">${badCount}</b>` : '');

    if (items.length) {
      previewEl.hidden = false;
      previewEl.innerHTML = `
        <table>
          <thead><tr><th style="width:34%">单词</th><th>释义</th><th style="width:56px">状态</th></tr></thead>
          <tbody>${items.slice(0, 60).map((x) => `
            <tr class="${x._ok && !x._dup ? '' : 'dup'}">
              <td>${esc(x.word)}</td><td>${esc(x.meaning)}</td>
              <td>${!x._ok ? '无效' : x._dup ? '重复' : '✓'}</td>
            </tr>`).join('')}
          ${items.length > 60 ? `<tr><td colspan="3" class="muted">…仅预览前 60 行,共 ${items.length} 行</td></tr>` : ''}
          </tbody>
        </table>`;
    } else {
      previewEl.hidden = true;
    }
  }

  textEl.addEventListener('input', reparse);
  modal.el.querySelector('#imp-cfb')?.addEventListener('click', importBuiltinCfb);
  modal.el.querySelector('#imp-file').addEventListener('click', async () => {
    const res = await window.api.words.importOpenFile();
    if (!res.ok) return;
    modal.el.querySelector('#imp-file-name').textContent = `已读取:${res.name.split('/').pop()}`;
    if (textEl.value.trim()) textEl.value += '\n';
    textEl.value += res.content;
    reparse();
  });

  setTimeout(() => textEl.focus(), 60);
}

// ---------- 导出 ----------

async function doExport() {
  const csv = await window.api.words.export();
  const res = await window.api.words.exportSave(csv, `wordmate-${new Date().toISOString().slice(0, 10)}.csv`);
  if (res.ok) toast(`已导出到 ${res.filePath}`);
}

// ---------- 挂载与刷新 ----------

export { parseLines };

export function mountLibrary(root) {
  render();
}

export async function refreshLibrary() {
  allWords = await window.api.words.list();
  const root = document.getElementById('view-library');
  const searchEl = root.querySelector('#lib-search');
  const keepSearch = searchEl ? searchEl.value : '';
  const keepFilter = root.querySelector('#lib-state-filter')?.value || 'all';
  stateFilter = keepFilter;
  render();
  const newSearch = root.querySelector('#lib-search');
  if (newSearch) newSearch.value = keepSearch;
  searchText = keepSearch;
  paintTable();
}
