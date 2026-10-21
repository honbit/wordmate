'use strict';

/**
 * 测验视图:四选一,双向出题(看词选义 / 看义选词)。
 * 答对按「认识」、答错按「忘了」计入间隔重复调度。
 */

import { toast } from '../app.js';

let root = null;
let current = null;      // 当前题目
let answered = false;    // 本题是否已作答
let score = { correct: 0, wrong: 0 };
let sessionTimer = null;

export function mountQuiz(el) {
  root = el;
  renderIdle();
}

export function refreshQuiz() {
  // 非答题中不强制刷新,保持界面稳定
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderIdle() {
  stopTimer();
  root.innerHTML = `
    <div class="page-head">
      <h1>测验</h1><span class="sub">四选一 · 双向出题 · 结果计入复习计划</span>
      <span class="spacer"></span>
      <div class="quiz-score" id="quiz-score" hidden>
        <span>✅ <b id="score-c"></b></span><span>❌ <b id="score-w"></b></span>
      </div>
      <button class="btn primary" id="quiz-start">开始测验</button>
    </div>
    <div class="quiz-stage">
      <div class="empty">
        <div class="emoji">✏️</div>
        <h2>选择题模式</h2>
        <p>优先考察当前到期的词,看你能连对多少<br>答对间隔拉长、答错缩短,和翻卡学习互通</p>
      </div>
    </div>`;
  root.querySelector('#quiz-start').addEventListener('click', startQuiz);
}

function startQuiz() {
  score = { correct: 0, wrong: 0 };
  nextQuestion();
  sessionTimer = setInterval(nextQuestion, 60 * 1000); // 兜底:卡住时自动刷新
}

function stopTimer() {
  if (sessionTimer) { clearInterval(sessionTimer); sessionTimer = null; }
}

async function nextQuestion() {
  if (answered === false && current) return; // 上一题还没答,不推进(除首轮)
  const res = await window.api.quiz.generate();
  if (!res.ok) {
    toast(res.error || '词库词数不足,无法出题', 'error');
    renderIdle();
    return;
  }
  current = res;
  answered = false;
  renderQuestion();
}

function renderQuestion() {
  const q = current;
  const isW2M = q.direction === 'w2m';
  root.innerHTML = `
    <div class="page-head">
      <h1>测验</h1>
      <span class="sub">${isW2M ? '看单词,选释义' : '看释义,选单词'}</span>
      <span class="spacer"></span>
      <div class="quiz-score">
        <span>✅ <b id="score-c">${score.correct}</b></span>
        <span>❌ <b id="score-w">${score.wrong}</b></span>
      </div>
      <button class="btn ghost" id="quiz-stop">结束</button>
    </div>
    <div class="quiz-stage">
      <div class="quiz-prompt-card">
        <div class="word-big">${esc(q.prompt)}</div>
        ${q.phonetic ? `<div class="phonetic" style="color:var(--text-2);margin-top:8px">${esc(q.phonetic)}</div>` : ''}
        <div class="hint" style="color:var(--text-3);font-size:11.5px;margin-top:12px">按 1-${q.choices.length} 或点击选项</div>
      </div>
      <div class="quiz-choices">
        ${q.choices.map((c, i) => `
          <button class="choice-btn" data-idx="${i}">
            <span class="c-key">${i + 1}</span><span>${esc(c)}</span>
          </button>`).join('')}
      </div>
    </div>`;

  root.querySelector('#quiz-stop').addEventListener('click', renderResult);
  root.querySelectorAll('.choice-btn').forEach((btn) => {
    btn.addEventListener('click', () => choose(Number(btn.dataset.idx)));
  });
  document.onkeydown = (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    const n = Number(e.key);
    if (n >= 1 && n <= q.choices.length && !answered) choose(n - 1);
  };
}

async function choose(idx) {
  if (answered || !current) return;
  // 视图已切走时不响应残留的键盘监听
  const viewEl = document.getElementById('view-quiz');
  if (!viewEl.classList.contains('active')) return;
  answered = true;
  document.onkeydown = null;
  const q = current;
  const correct = idx === q.correctIndex;
  const btns = root.querySelectorAll('.choice-btn');
  btns.forEach((b) => (b.disabled = true));
  btns[q.correctIndex].classList.add('correct');
  if (!correct) btns[idx].classList.add('wrong');

  if (correct) score.correct++;
  else score.wrong++;
  const cEl = root.querySelector('#score-c');
  const wEl = root.querySelector('#score-w');
  if (cEl) cEl.textContent = score.correct;
  if (wEl) wEl.textContent = score.wrong;

  await window.api.quiz.answer(q.id, correct);
  setTimeout(() => { current = null; nextQuestion(); }, correct ? 550 : 1400);
}

function renderResult() {
  stopTimer();
  document.onkeydown = null;
  current = null;
  const total = score.correct + score.wrong;
  const acc = total ? Math.round((score.correct / total) * 100) : 0;
  root.innerHTML = `
    <div class="page-head">
      <h1>测验</h1><span class="sub">本轮结束</span>
      <span class="spacer"></span>
      <button class="btn primary" id="quiz-again">再来一轮</button>
    </div>
    <div class="quiz-stage">
      <div class="quiz-prompt-card">
        <div class="emoji" style="font-size:40px">${acc >= 80 ? '🏆' : acc >= 60 ? '💪' : '📖'}</div>
        <div class="word-big" style="margin-top:10px">正确率 ${acc}%</div>
        <p style="color:var(--text-2);margin-top:8px">共 ${total} 题 · 答对 ${score.correct} · 答错 ${score.wrong}</p>
        <p style="color:var(--text-3);font-size:12px;margin-top:6px">答错的词会按「忘了」安排更近的复习</p>
      </div>
    </div>`;
  root.querySelector('#quiz-again').addEventListener('click', startQuiz);
}
