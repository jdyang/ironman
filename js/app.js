/* app.js — 主控制器:界面流程、录音、说话人分配、结束触发、结果生成 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const SPK_LABEL = { me: '我', other: '对方' };
  const STOP_RE = /(会议结束|结束会议|散会|结束吧)/;

  // ---------- 全局状态 ----------
  const vp = new VoicePrint();
  let rec = null;
  let vpStarted = false;
  let diarize = false;
  let manualSpeaker = 'me';
  let segments = [];          // {speaker, text}
  let lastBubble = null;      // 最近一个气泡 DOM
  let segStartT = 0;          // 当前语音段开始(音频时钟)
  let timerInt = null;
  let guessInt = null;
  let startMs = 0;
  let paused = false;
  let ending = false;

  // ---------- 工具 ----------
  function toast(msg, ms) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), ms || 2200);
  }

  function showPanel(name) {
    document.querySelectorAll('.panel').forEach((p) => {
      p.classList.toggle('active', p.dataset.panel === name);
    });
    $('app').scrollTop = 0;
    const c = document.querySelector('.content');
    if (c) c.scrollTop = 0;
  }

  function fmtClock(sec) {
    sec = Math.max(0, Math.floor(sec));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function fmtDate(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // ---------- 声纹登记 ----------
  async function ensureVP() {
    if (vpStarted) return true;
    try {
      await vp.start();
      vpStarted = true;
      vp.onLevel = (lvl) => {
        if (vp._enroll) {
          const sel = vp._enroll.speaker === 'me' ? '#enroll-me' : '#enroll-other';
          const bar = document.querySelector(sel + ' .meter span');
          if (bar) bar.style.width = Math.round(lvl * 100) + '%';
        }
      };
      return true;
    } catch (e) {
      toast('需要麦克风权限才能使用');
      return false;
    }
  }

  function wireEnroll() {
    document.querySelectorAll('.enroll-btn').forEach((btn) => {
      const speaker = btn.dataset.speaker;
      const item = btn.closest('.enroll-item');
      const stateEl = item.querySelector('.enroll-state');

      const begin = async (ev) => {
        ev.preventDefault();
        if (!(await ensureVP())) return;
        vp.beginEnroll(speaker);
        btn.classList.add('recording');
        btn.textContent = '松开结束…';
        stateEl.textContent = '录音中…保持说话';
      };
      const finish = (ev) => {
        if (ev) ev.preventDefault();
        if (!vp._enroll || vp._enroll.speaker !== speaker) return;
        const r = vp.endEnroll();
        btn.classList.remove('recording');
        btn.textContent = speaker === 'me' ? '按住录我的声音' : '按住录对方声音';
        const bar = item.querySelector('.meter span');
        if (bar) bar.style.width = '0%';
        if (r.ok) {
          item.classList.add('done');
          stateEl.textContent = `已登记 ✓ (${r.frames} 帧)`;
        } else {
          stateEl.textContent = '太短了,请再按住多说几秒';
        }
        refreshDiarizeOption();
      };

      btn.addEventListener('pointerdown', begin);
      btn.addEventListener('pointerup', finish);
      btn.addEventListener('pointerleave', finish);
      btn.addEventListener('pointercancel', finish);
      // 兜底:防止触摸时触发页面滚动/长按菜单
      btn.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    });
  }

  function refreshDiarizeOption() {
    const opt = $('optDiarize');
    const hint = $('enrollHint');
    if (vp.ready()) {
      opt.disabled = false;
      opt.checked = true;
      hint.textContent = '两位声音都已登记,会议中将自动区分说话人 ✓';
    } else {
      opt.checked = false;
      hint.textContent = '提示:两个人都登记后才能自动区分;否则将进入手动点选模式。';
    }
  }

  // ---------- 会议进行 ----------
  async function startMeeting() {
    if (!Recognition.supported()) {
      toast('当前浏览器不支持语音识别,请用安卓 Chrome 打开');
      return;
    }
    diarize = $('optDiarize').checked && vp.ready();

    if (diarize) {
      if (!(await ensureVP())) return;
    } else {
      // 不需要声纹,释放声纹用的麦克风,避免和识别抢占
      if (vpStarted) { vp.stop(); vpStarted = false; }
    }

    segments = [];
    lastBubble = null;
    paused = false;
    ending = false;
    manualSpeaker = 'me';
    $('transcript').innerHTML = '<div class="empty muted" id="transcriptEmpty">开始说话,文字会实时出现在这里…<br/>说一句“会议结束”即可自动结束。</div>';
    $('interim').textContent = '';

    $('liveMode').textContent = diarize
      ? '自动区分中 · 点头像可纠正上一句'
      : '手动模式 · 请点选当前说话人';
    setActiveChip(diarize ? null : manualSpeaker);

    rec = new Recognition({
      lang: 'zh-CN',
      onSegmentStart: () => { segStartT = vpStarted ? vp.now() : 0; },
      onInterim: (txt) => { $('interim').textContent = txt; },
      onFinal: onFinalText,
      onError: (err) => {
        if (err === 'not-allowed') toast('麦克风被拒绝,无法识别');
        else if (err === 'unsupported') toast('浏览器不支持语音识别');
      },
    });
    rec.start();

    startMs = Date.now();
    $('liveDot').classList.add('live');
    timerInt = setInterval(() => {
      $('timer').textContent = fmtClock((Date.now() - startMs) / 1000);
    }, 500);

    if (diarize) {
      guessInt = setInterval(() => {
        const g = vp.guessNow();
        if (g) setActiveChip(g, true);
      }, 450);
    }

    showPanel('live');
  }

  function setActiveChip(speaker, indicateOnly) {
    $('chipMe').classList.toggle('active', speaker === 'me');
    $('chipOther').classList.toggle('active', speaker === 'other');
  }

  function onFinalText(text) {
    if (ending) return;
    let clean = text;
    const stop = STOP_RE.test(clean);
    if (stop) clean = clean.replace(STOP_RE, '').trim();

    if (clean) {
      let speaker;
      if (diarize) {
        speaker = vp.classifyWindow(segStartT, vp.now()) ||
          (segments.length ? segments[segments.length - 1].speaker : 'me');
      } else {
        speaker = manualSpeaker;
      }
      addSegment(speaker, clean);
    }

    if (stop) endMeeting();
  }

  function addSegment(speaker, text) {
    const empty = $('transcriptEmpty');
    if (empty) empty.remove();

    const last = segments[segments.length - 1];
    if (last && last.speaker === speaker && lastBubble) {
      // 合并同一人的连续发言
      last.text += (/[，。！？、,.!?]$/.test(last.text) ? '' : '') + text;
      lastBubble.querySelector('.txt').textContent = last.text;
    } else {
      const seg = { speaker, text };
      segments.push(seg);
      const b = document.createElement('div');
      b.className = 'bubble ' + speaker;
      b.dataset.idx = segments.length - 1;
      b.innerHTML = '<div class="who">' + SPK_LABEL[speaker] + '</div><div class="txt"></div>';
      b.querySelector('.txt').textContent = text;
      $('transcript').appendChild(b);
      lastBubble = b;
    }
    const c = document.querySelector('.content');
    if (c) c.scrollTop = c.scrollHeight;
  }

  // 点头像:手动模式→设定当前说话人;自动模式→纠正最近一句
  function onChipTap(speaker) {
    if (diarize) {
      if (!segments.length || !lastBubble) return;
      const idx = +lastBubble.dataset.idx;
      segments[idx].speaker = speaker;
      lastBubble.className = 'bubble ' + speaker;
      lastBubble.querySelector('.who').textContent = SPK_LABEL[speaker];
      toast('已将上一句改为「' + SPK_LABEL[speaker] + '」');
    } else {
      manualSpeaker = speaker;
      setActiveChip(speaker);
    }
  }

  function togglePause() {
    if (!rec) return;
    paused = !paused;
    if (paused) {
      rec.pause();
      $('pauseBtn').textContent = '继续';
      $('liveDot').classList.remove('live');
    } else {
      rec.resume();
      $('pauseBtn').textContent = '暂停';
      $('liveDot').classList.add('live');
    }
  }

  function endMeeting() {
    if (ending) return;
    ending = true;
    if (rec) rec.stop();
    clearInterval(timerInt);
    clearInterval(guessInt);
    $('liveDot').classList.remove('live');
    if (vpStarted) { vp.stop(); vpStarted = false; }

    const durationSec = Math.round((Date.now() - startMs) / 1000);
    const result = Extractor.extract(segments);
    const meeting = {
      id: 'm_' + Date.now(),
      createdAt: Date.now(),
      durationSec,
      diarized: diarize,
      segments: segments.slice(),
      checklist: result.checklist,
      todo: result.todo,
    };
    Storage.save(meeting);
    renderResult(meeting);
    showPanel('result');
  }

  // ---------- 结果渲染 ----------
  let currentMeeting = null;

  function renderResult(m) {
    currentMeeting = m;
    $('timer').textContent = '00:00';
    $('resultMeta').textContent =
      fmtDate(m.createdAt) + ' · 时长 ' + fmtClock(m.durationSec) +
      (m.diarized ? ' · 自动区分' : ' · 手动');

    // checklist
    const cl = $('checklist');
    cl.innerHTML = '';
    if (!m.checklist.length) {
      cl.innerHTML = '<li class="empty-li">未提炼到明确要点</li>';
    } else {
      m.checklist.forEach((c) => {
        const li = document.createElement('li');
        li.innerHTML = '<span class="ic">✅</span><span>' +
          (c.speaker ? '<span class="tag ' + c.speaker + '">' + SPK_LABEL[c.speaker] + '</span>' : '') +
          esc(c.text) + '</span>';
        cl.appendChild(li);
      });
    }

    // todo
    const td = $('todo');
    td.innerHTML = '';
    if (!m.todo.length) {
      td.innerHTML = '<li class="empty-li">未提炼到待办行动项</li>';
    } else {
      m.todo.forEach((t) => {
        const li = document.createElement('li');
        let meta = '';
        if (t.due) meta = '<span class="meta"><span class="tag due">截止 ' + esc(t.due) + '</span></span>';
        li.innerHTML = '<span class="ic">⬜</span><span>' +
          (t.speaker ? '<span class="tag ' + t.speaker + '">' + SPK_LABEL[t.speaker] + '</span>' : '') +
          esc(t.text) + meta + '</span>';
        td.appendChild(li);
      });
    }

    // full transcript
    const ft = $('fullTranscript');
    ft.innerHTML = '';
    m.segments.forEach((s) => {
      const div = document.createElement('div');
      div.className = 'line';
      div.innerHTML = '<b class="' + s.speaker + '">' + SPK_LABEL[s.speaker] + ':</b> ' + esc(s.text);
      ft.appendChild(div);
    });
    document.querySelector('.collapsible').classList.remove('open');
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // ---------- 文本导出 ----------
  function buildText(m, which) {
    const lines = [];
    if (which === 'checklist' || which === 'all') {
      lines.push('✅ Checklist(要点/决议)');
      if (m.checklist.length) m.checklist.forEach((c) => lines.push('- ' + (c.speaker ? '[' + SPK_LABEL[c.speaker] + '] ' : '') + c.text));
      else lines.push('-(无)');
      lines.push('');
    }
    if (which === 'todo' || which === 'all') {
      lines.push('📝 To-Do(待办)');
      if (m.todo.length) m.todo.forEach((t) => lines.push('- [ ] ' + (t.speaker ? '[' + SPK_LABEL[t.speaker] + '] ' : '') + t.text + (t.due ? '(截止:' + t.due + ')' : '')));
      else lines.push('-(无)');
      lines.push('');
    }
    if (which === 'full') {
      lines.push('📄 完整记录');
      m.segments.forEach((s) => lines.push(SPK_LABEL[s.speaker] + ': ' + s.text));
      return lines.join('\n');
    }
    if (which === 'all') {
      lines.push('📄 完整记录');
      m.segments.forEach((s) => lines.push(SPK_LABEL[s.speaker] + ': ' + s.text));
    }
    return lines.join('\n');
  }

  function summaryHeader(m) {
    return '会议小结 · ' + fmtDate(m.createdAt) + ' · 时长 ' + fmtClock(m.durationSec) + '\n\n';
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制');
    } catch (e) {
      // 兜底
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('已复制'); } catch (_) { toast('复制失败'); }
      ta.remove();
    }
  }

  async function shareMeeting() {
    const m = currentMeeting;
    if (!m) return;
    const text = summaryHeader(m) + buildText(m, 'all');
    if (navigator.share) {
      try {
        await navigator.share({ title: '会议小结', text });
        return;
      } catch (e) { /* 用户取消 */ if (e && e.name === 'AbortError') return; }
    }
    copyText(text);
    toast('已复制小结,可粘贴发给自己');
  }

  function downloadMeeting() {
    const m = currentMeeting;
    if (!m) return;
    const text = summaryHeader(m) + buildText(m, 'all');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '会议小结-' + fmtDate(m.createdAt).replace(/[ :]/g, '') + '.txt';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------- 历史 ----------
  function renderHistory() {
    const list = Storage.list();
    const wrap = $('historyList');
    wrap.innerHTML = '';
    if (!list.length) {
      wrap.innerHTML = '<div class="hist-empty">还没有历史记录</div>';
      return;
    }
    list.forEach((m) => {
      const div = document.createElement('div');
      div.className = 'hist-item';
      const first = m.segments[0] ? m.segments[0].text.slice(0, 24) : '(无内容)';
      div.innerHTML =
        '<button class="hist-del" data-del="' + m.id + '">删除</button>' +
        '<div class="ht">' + esc(first) + '…</div>' +
        '<div class="hd">' + fmtDate(m.createdAt) + ' · 时长 ' + fmtClock(m.durationSec) +
        ' · ' + m.todo.length + ' 待办 / ' + m.checklist.length + ' 要点</div>';
      div.addEventListener('click', (e) => {
        if (e.target.dataset.del) {
          e.stopPropagation();
          Storage.remove(e.target.dataset.del);
          renderHistory();
          return;
        }
        renderResult(m);
        showPanel('result');
      });
      wrap.appendChild(div);
    });
  }

  // ---------- 事件绑定 ----------
  function init() {
    wireEnroll();
    refreshDiarizeOption();

    $('startBtn').addEventListener('click', startMeeting);
    $('pauseBtn').addEventListener('click', togglePause);
    $('endBtn').addEventListener('click', endMeeting);
    $('chipMe').addEventListener('click', () => onChipTap('me'));
    $('chipOther').addEventListener('click', () => onChipTap('other'));

    $('shareBtn').addEventListener('click', shareMeeting);
    $('downloadBtn').addEventListener('click', downloadMeeting);
    $('newBtn').addEventListener('click', () => { $('timer').textContent = '00:00'; showPanel('setup'); });

    document.querySelectorAll('[data-copy]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!currentMeeting) return;
        const which = btn.dataset.copy;
        const text = which === 'full'
          ? buildText(currentMeeting, 'full')
          : buildText(currentMeeting, which);
        copyText(text);
      });
    });

    $('toggleTranscript').addEventListener('click', (e) => {
      if (e.target.dataset.copy) return;
      document.querySelector('.collapsible').classList.toggle('open');
    });

    $('openHistory').addEventListener('click', () => { renderHistory(); showPanel('history'); });
    $('backFromHistory').addEventListener('click', () => showPanel('setup'));

    if (!Recognition.supported()) {
      toast('提示:此浏览器可能不支持语音识别,推荐安卓 Chrome');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
