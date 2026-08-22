// 我的排班（心理師自助設定可預約時段、登錄請假）與行事曆月檢視

const SHIFT_WD = [[1, '週一'], [2, '週二'], [3, '週三'], [4, '週四'], [5, '週五'], [6, '週六'], [0, '週日']];

// 排班格子的起訖與間距一律由系統設定決定（各所作息不同），預設 08:00–21:00、每格 30 分。
// 不落在格線上的時段（例如 13:15-14:05）不強迫遷就格子，另存為「自訂時段」清單。
const shiftMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const shiftFmt = v => `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
function shiftCfg() {
  const c = (App.meta && App.meta.shift) || {};
  const start = shiftMin(c.start || '08:00');
  const endRaw = shiftMin(c.end || '21:00');
  const step = Math.max(5, Number(c.step) || 30);
  return { start, end: endRaw > start ? endRaw : start + step, step, quick: c.quick_fills || [] };
}
// 是否對得上格線：對得上就用格子表示，對不上就進自訂時段清單
function onGrid(cfg, a) {
  const s = shiftMin(a.start_time), e = shiftMin(a.end_time);
  return s >= cfg.start && e <= cfg.end && (s - cfg.start) % cfg.step === 0 && (e - s) % cfg.step === 0 && e > s;
}

// 相鄰的格子合併成一段連續時段再存檔，避免資料庫塞滿碎片
function shiftBlocks(picked, cfg) {
  const out = [];
  for (const [wd] of SHIFT_WD) {
    let run = null;
    for (let s = cfg.start; s < cfg.end; s += cfg.step) {
      if (picked.has(`${wd}|${s}`)) {
        if (run === null) run = s;
      } else if (run !== null) {
        out.push({ weekday: wd, start_time: shiftFmt(run), end_time: shiftFmt(s) });
        run = null;
      }
    }
    if (run !== null) out.push({ weekday: wd, start_time: shiftFmt(run), end_time: shiftFmt(cfg.end) });
  }
  return out;
}

// 排班面板：原本的「我的排班」獨立頁，現直接掛在預約排程頁下方，時段設定只有這一處入口。
// el 為容器；arg 為指定心理師 id（管理者切換用）；onChange 供外層在請假異動後整頁重載，
// 讓同頁的週檢視（請假會顯示在格子裡）跟著更新，不會出現一邊改完另一邊還是舊資料。
async function renderShiftPanel(el, arg, onChange) {
  {
    const canPickOther = App.me.role === 'admin';
    const cid = Number(arg) || (canPickOther ? Number(localStorage.getItem('mc-shift-c')) || App.me.id : App.me.id);
    if (canPickOther) localStorage.setItem('mc-shift-c', cid);
    const [avail, offs] = await Promise.all([
      GET(`/availability?counselor_id=${cid}`),
      App.can('hr') ? GET(`/time-off?counselor_id=${cid}`).catch(() => []) : Promise.resolve(null)
    ]);

    const cfg = shiftCfg();
    const picked = new Set();
    // custom：不對齊格線的時段，以清單方式維護，存檔時與格子時段一起送出
    let custom = [];
    for (const a of avail) {
      if (onGrid(cfg, a)) {
        for (let s = shiftMin(a.start_time); s < shiftMin(a.end_time); s += cfg.step) picked.add(`${a.weekday}|${s}`);
      } else {
        custom.push({ weekday: a.weekday, start_time: a.start_time, end_time: a.end_time, note: a.note || '' });
      }
    }

    const rows = [];
    for (let s = cfg.start; s < cfg.end; s += cfg.step) {
      rows.push(`<tr><th class="shift-time">${shiftFmt(s)}</th>${SHIFT_WD.map(([wd]) =>
        `<td class="shift-cell${picked.has(`${wd}|${s}`) ? ' on' : ''}" data-wd="${wd}" data-min="${s}"></td>`).join('')}</tr>`);
    }

    el.innerHTML = `
      <div class="toolbar">
        ${canPickOther ? `<label style="font-size:13px">心理師</label>
          <select id="sc">${App.counselorOptions().map(o =>
      `<option value="${o[0]}"${Number(o[0]) === cid ? ' selected' : ''}>${UI.esc(o[1])}</option>`).join('')}</select>` : ''}
        ${cfg.quick.map((q, i) => `<button class="btn secondary small" data-q="${i}">快填 ${UI.esc(q.label)}</button>`).join('')}
        <button class="btn secondary small" id="q-custom">自訂時段</button>
        <button class="btn secondary small" id="q-clear">全部清空</button>
        <div class="spacer"></div>
        <button class="btn" id="save">儲存排班</button>
      </div>
      <div class="card">
        <div class="table-wrap"><table class="list shift-table"><thead><tr><th></th>
          ${SHIFT_WD.map(w => `<th>${w[1]}</th>`).join('')}</tr></thead>
          <tbody>${rows.join('')}</tbody></table></div>
        <div style="font-size:12.5px;color:var(--muted);margin-top:10px">
          點一下切換單格，按住拖曳可整段刷選；表格範圍（目前 ${shiftFmt(cfg.start)}–${shiftFmt(cfg.end)}、每格 ${cfg.step} 分鐘）
          與快填按鈕可於系統設定調整。不在格線上的時間請用「自訂時段」。
          已被預約或請假的時間會自動從可預約清單扣除，不必在這裡調整。</div>
        <div id="custom-list" style="margin-top:12px"></div>
      </div>
      ${offs ? `<div class="card"><h3>我的請假／不可預約</h3><div id="offs"></div></div>` : ''}
      ${cid === App.me.id ? `<div class="card"><h3>訂閱到手機日曆</h3><div id="cal-sub"><div class="empty">載入中...</div></div></div>` : ''}`;

    const table = el.querySelector('.shift-table');
    let dragging = false, mode = true;
    const toggle = (td, on) => {
      const key = `${td.dataset.wd}|${td.dataset.min}`;
      if (on) { picked.add(key); td.classList.add('on'); } else { picked.delete(key); td.classList.remove('on'); }
    };
    table.addEventListener('mousedown', e => {
      const td = e.target.closest('.shift-cell');
      if (!td) return;
      e.preventDefault();
      dragging = true;
      mode = !td.classList.contains('on');
      toggle(td, mode);
    });
    table.addEventListener('mouseover', e => {
      if (!dragging) return;
      const td = e.target.closest('.shift-cell');
      if (td) toggle(td, mode);
    });
    document.addEventListener('mouseup', () => { dragging = false; });
    // 手機沒有 hover，改成單點切換
    table.addEventListener('click', e => {
      const td = e.target.closest('.shift-cell');
      if (td && !dragging) toggle(td, !td.classList.contains('on'));
    });

    const fill = (wds, ranges) => {
      el.querySelectorAll('.shift-cell').forEach(td => {
        const wd = Number(td.dataset.wd), m = Number(td.dataset.min);
        if (wds.includes(wd) && ranges.some(r => m >= shiftMin(r[0]) && m < shiftMin(r[1]))) toggle(td, true);
      });
    };
    el.querySelectorAll('[data-q]').forEach(b => {
      const q = cfg.quick[Number(b.dataset.q)];
      b.onclick = () => fill(q.weekdays, q.ranges);
    });
    el.querySelector('#q-clear').onclick = () => {
      el.querySelectorAll('.shift-cell').forEach(td => toggle(td, false));
      custom = [];
      drawCustom();
    };

    // 自訂時段：任意起訖時間，可一次套用到多個星期；不受格線限制
    const drawCustom = () => {
      const box = el.querySelector('#custom-list');
      if (!custom.length) { box.innerHTML = ''; return; }
      box.innerHTML = `<div style="font-size:13px;font-weight:600;margin-bottom:6px">自訂時段（不在格線上）</div>
        ${UI.table(['星期', '時段', '備註', ''], custom.map((c, i) => `<tr>
          <td>${(SHIFT_WD.find(w => w[0] === Number(c.weekday)) || [0, ''])[1]}</td>
          <td>${UI.esc(c.start_time)} - ${UI.esc(c.end_time)}</td>
          <td>${UI.esc(c.note || '')}</td>
          <td><button class="btn tiny danger" data-cx="${i}">刪除</button></td></tr>`))}`;
      box.querySelectorAll('[data-cx]').forEach(b => {
        b.onclick = () => { custom.splice(Number(b.dataset.cx), 1); drawCustom(); };
      });
    };
    drawCustom();
    el.querySelector('#q-custom').onclick = () => UI.modal({
      title: '新增自訂時段',
      body: `<div class="form-grid">
          <div class="form-row full"><label>星期（可複選）</label>
            <div style="display:flex;gap:10px;flex-wrap:wrap">${SHIFT_WD.map(([wd, label]) =>
    `<label style="font-size:13.5px;display:flex;gap:5px;align-items:center">
              <input type="checkbox" class="cw" value="${wd}" style="width:auto">${label}</label>`).join('')}</div></div>
          ${UI.input('start_time', '開始時間', { type: 'time', value: '13:15' })}
          ${UI.input('end_time', '結束時間', { type: 'time', value: '14:05' })}
          ${UI.input('note', '備註', { full: true, placeholder: '例：僅收舊個案、線上晤談時段' })}
        </div>
        <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
          任何起訖時間都可以，不必配合上方表格的格線；若剛好對得上格線，存檔後會直接顯示在表格中。</div>`,
      onSubmit: form => {
        const f = UI.formData(form);
        const wds = [...form.querySelectorAll('.cw:checked')].map(c => Number(c.value));
        if (!wds.length) throw new Error('請選擇至少一個星期');
        if (!f.start_time || !f.end_time || f.end_time <= f.start_time) throw new Error('結束時間需晚於開始時間');
        for (const wd of wds) {
          const block = { weekday: wd, start_time: f.start_time, end_time: f.end_time, note: f.note || '' };
          // 對得上格線的就直接畫進表格，維持單一呈現方式
          if (onGrid(cfg, block)) {
            for (let m = shiftMin(f.start_time); m < shiftMin(f.end_time); m += cfg.step) {
              const td = el.querySelector(`.shift-cell[data-wd="${wd}"][data-min="${m}"]`);
              if (td) toggle(td, true);
            }
          } else {
            custom.push(block);
          }
        }
        drawCustom();
        UI.toast('已加入，記得按「儲存排班」');
      }
    });
    if (canPickOther) el.querySelector('#sc').onchange = e => renderShiftPanel(el, e.target.value, onChange);

    el.querySelector('#save').onclick = async () => {
      try {
        const blocks = shiftBlocks(picked, cfg).concat(custom);
        const r = await POST('/availability/bulk', { counselor_id: cid, blocks });
        UI.toast(`已儲存 ${r.count} 個時段`);
      } catch (e) { UI.err(e); }
    };

    // 行事曆訂閱（.ics）：只給本人，網址等同一把免登入鑰匙，可隨時重設
    const sub = el.querySelector('#cal-sub');
    if (sub) {
      const draw = url => {
        sub.innerHTML = `<div class="form-row full"><label>訂閱網址</label>
            <input id="cal-url" value="${UI.esc(url)}" readonly onclick="this.select()"></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
            <button class="btn small" id="cal-copy">複製網址</button>
            <a class="btn small secondary" href="${UI.esc(url)}" target="_blank" rel="noopener noreferrer">下載 .ics</a>
            <button class="btn small danger" id="cal-reset">重設網址</button>
          </div>
          <div style="font-size:12.5px;color:var(--muted);margin-top:10px;line-height:1.7">
            Google 日曆：其他日曆 → 從網址新增；iPhone：設定 → 行事曆 → 帳號 → 加入已訂閱的行事曆。<br>
            內容為未來半年的晤談、團體與請假，<strong>只帶個案編號不帶姓名</strong>；此網址可免登入讀取，請勿外流，
            外流時按「重設網址」即刻失效。</div>`;
        sub.querySelector('#cal-copy').onclick = async () => {
          const input = sub.querySelector('#cal-url');
          input.select();
          try { await navigator.clipboard.writeText(url); UI.toast('已複製訂閱網址'); }
          catch { document.execCommand('copy'); UI.toast('已複製訂閱網址'); }
        };
        sub.querySelector('#cal-reset').onclick = async () => {
          if (!await UI.confirm('重設後舊網址立即失效，已訂閱的裝置需重新加入，確定重設？')) return;
          try { const r = await POST('/my/calendar-url/reset', {}); draw(r.url); UI.toast('已重設'); }
          catch (e) { UI.err(e); }
        };
      };
      GET('/my/calendar-url').then(r => draw(r.url))
        .catch(e => { sub.innerHTML = `<div class="empty">${UI.esc(e.message)}</div>`; });
    }

    if (offs) {
      const box = el.querySelector('#offs');
      box.innerHTML = `${UI.table(['期間', '時段', '事由', ''], offs.map(o => `<tr>
          <td>${o.start_date}${o.end_date !== o.start_date ? ' ~ ' + o.end_date : ''}</td>
          <td>${o.all_day ? '全天' : `${o.start_time}-${o.end_time}`}</td>
          <td>${UI.esc(o.reason || '')}</td>
          <td style="white-space:nowrap"><button class="btn tiny secondary" data-offe="${o.id}">編輯</button>
            <button class="btn tiny danger" data-off="${o.id}">刪除</button></td></tr>`), '目前沒有請假紀錄')}
        <button class="btn small secondary" id="add-off" style="margin-top:10px">登錄請假</button>`;
      box.querySelector('#add-off').onclick = () => UI.modal({
        title: '登錄請假／不可預約',
        body: `<div class="form-grid">
          ${UI.input('start_date', '起始日', { type: 'date', value: UI.today() })}
          ${UI.input('end_date', '結束日', { type: 'date', value: UI.today() })}
          ${UI.checkbox('all_day', '全天不可預約', true)}
          ${UI.input('start_time', '開始時間', { type: 'time' })}
          ${UI.input('end_time', '結束時間', { type: 'time' })}
          ${UI.inputList('reason', '事由', App.meta.time_off_reasons || [], { full: true })}
        </div>`,
        onSubmit: async form => {
          await POST('/time-off', { ...UI.formData(form), counselor_id: cid });
          (onChange || (() => renderShiftPanel(el, cid, onChange)))();
        }
      });
      // 日期或事由填錯就地改，不必刪掉重登
      box.querySelectorAll('[data-offe]').forEach(b => {
        const o = offs.find(x => x.id === Number(b.dataset.offe));
        b.onclick = () => UI.modal({
          title: '編輯請假／不可預約',
          body: `<div class="form-grid">
            ${UI.input('start_date', '起始日', { type: 'date', value: o.start_date })}
            ${UI.input('end_date', '結束日', { type: 'date', value: o.end_date })}
            ${UI.checkbox('all_day', '全天不可預約', !!o.all_day)}
            ${UI.input('start_time', '開始時間', { type: 'time', value: o.start_time || '' })}
            ${UI.input('end_time', '結束時間', { type: 'time', value: o.end_time || '' })}
            ${UI.inputList('reason', '事由', App.meta.time_off_reasons || [], { value: o.reason || '', full: true })}
          </div>`,
          onSubmit: async form => {
            await PUT(`/time-off/${o.id}`, UI.formData(form));
            UI.toast('已更新');
            (onChange || (() => renderShiftPanel(el, cid, onChange)))();
          }
        });
      });
      box.querySelectorAll('[data-off]').forEach(b => {
        b.onclick = async () => {
          if (!await UI.confirm('刪除此請假紀錄？')) return;
          try { await DEL(`/time-off/${b.dataset.off}`); (onChange || (() => renderShiftPanel(el, cid, onChange)))(); } catch (e) { UI.err(e); }
        };
      });
    }
  }
}

// ---- 行事曆（月檢視）----
App.page('calendar', {
  title: '行事曆',
  sub: '一個月一眼看完晤談、團體、請假與可預約時段',
  help: [
    '一個月一眼看完晤談、團體、請假與可預約時段；點任一天可看該日明細，並直接「在這天新增預約」。',
    '上方可切換月份、只看某位心理師。',
    '「訂閱網址」可把行事曆掛到手機或 Google 日曆；網址內容不含個案姓名，外流時可按「重設網址」讓舊網址失效。',
  ],
  module: 'schedule',
  async render(el, arg) {
    const month = /^\d{4}-\d{2}$/.test(arg || '') ? arg : (localStorage.getItem('mc-cal-m') || UI.thisMonth());
    localStorage.setItem('mc-cal-m', month);
    const filterC = localStorage.getItem('mc-cal-c') || '';
    const first = month + '-01';
    const firstD = new Date(first + 'T00:00:00');
    const daysInMonth = new Date(firstD.getFullYear(), firstD.getMonth() + 1, 0).getDate();
    // 月曆自週一起算，前後補到整週
    const lead = (firstD.getDay() + 6) % 7;
    const gridStart = UI.addDays(first, -lead);
    const cells = Math.ceil((lead + daysInMonth) / 7) * 7;
    const data = await GET(`/schedule/calendar?from=${gridStart}&to=${UI.addDays(gridStart, cells - 1)}${filterC ? '&counselor_id=' + filterC : ''}`);

    const dayItems = date => {
      const wd = new Date(date + 'T00:00:00').getDay();
      return {
        offs: data.time_off.filter(o => date >= o.start_date && date <= o.end_date),
        groups: data.group_sessions.filter(g => g.date === date),
        appts: data.appointments.filter(a => a.date === date).sort((x, y) => x.start_time.localeCompare(y.start_time)),
        avail: data.availability.filter(v => v.weekday === wd)
      };
    };

    const cellHtml = date => {
      const { offs, groups, appts, avail } = dayItems(date);
      const inMonth = date.slice(0, 7) === month;
      const live = appts.filter(a => a.status !== 'cancelled');
      const shown = live.slice(0, 3).map(a => `<div class="cal-ev ev-${a.status}">${a.start_time} ${UI.esc(a.client_name)}</div>`).join('');
      return `<td class="cal-cell${inMonth ? '' : ' cal-out'}${date === UI.today() ? ' cal-today' : ''}" data-day="${date}">
        <div class="cal-day">${Number(date.slice(8))}</div>
        ${offs.map(o => `<div class="cal-ev ev-off">請假${filterC ? '' : '：' + UI.esc(o.counselor_name)}</div>`).join('')}
        ${groups.map(g => `<div class="cal-ev ev-group">${g.start_time} ${UI.esc(g.group_name)}</div>`).join('')}
        ${shown}
        ${live.length > 3 ? `<div class="cal-more">還有 ${live.length - 3} 筆</div>` : ''}
        ${!live.length && !groups.length && !offs.length && avail.length && inMonth
    ? '<div class="cal-more">可預約</div>' : ''}</td>`;
    };

    const rowsHtml = [];
    for (let i = 0; i < cells; i += 7) {
      rowsHtml.push('<tr>' + Array.from({ length: 7 }, (_, j) => cellHtml(UI.addDays(gridStart, i + j))).join('') + '</tr>');
    }
    const shiftMonth = n => {
      const d = new Date(first + 'T00:00:00');
      d.setMonth(d.getMonth() + n);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    };

    el.innerHTML = `
      <div class="toolbar">
        <button class="btn secondary small" id="prev">上個月</button>
        <button class="btn secondary small" id="this">本月</button>
        <button class="btn secondary small" id="next">下個月</button>
        <strong style="margin-left:6px">${month}</strong>
        <select id="fc">${App.counselorOptions(true).map(o =>
      `<option value="${o[0]}"${String(o[0]) === filterC ? ' selected' : ''}>${UI.esc(o[1])}</option>`).join('')}</select>
        <div class="spacer"></div>
        <button class="btn" id="add">新增預約</button>
      </div>
      <div class="table-wrap"><table class="list cal-table"><thead><tr>
        ${SHIFT_WD.map(w => `<th>${w[1]}</th>`).join('')}</tr></thead>
        <tbody>${rowsHtml.join('')}</tbody></table></div>
      <div style="font-size:12.5px;color:var(--muted);margin-top:8px">點任一天可看當日明細並直接排約。</div>`;

    el.querySelector('#prev').onclick = () => App.go('calendar/' + shiftMonth(-1));
    el.querySelector('#next').onclick = () => App.go('calendar/' + shiftMonth(1));
    el.querySelector('#this').onclick = () => App.go('calendar/' + UI.thisMonth());
    el.querySelector('#fc').onchange = e => { localStorage.setItem('mc-cal-c', e.target.value); App.go('calendar/' + month); };
    el.querySelector('#add').onclick = () => apptDialog(null, () => App.go('calendar/' + month));

    el.querySelectorAll('[data-day]').forEach(td => {
      td.onclick = () => {
        const date = td.dataset.day;
        const { offs, groups, appts, avail } = dayItems(date);
        UI.modal({
          title: `${date}（${UI.weekdayName(date)}）`,
          hideFooter: true,
          body: `
            ${offs.length ? `<div class="notice warn">請假：${offs.map(o =>
    `${UI.esc(o.counselor_name)}　${o.all_day ? '全天' : o.start_time + '-' + o.end_time}${o.reason ? '／' + UI.esc(o.reason) : ''}`).join('<br>')}</div>` : ''}
            ${UI.table(['時間', '對象', '心理師', '狀態'], appts.map(a => `<tr>
              <td>${a.start_time}-${a.end_time}</td>
              <td><a href="#client/${a.client_id}">${UI.esc(a.client_name)}</a>${a.risk_level === 'high' ? ' ⚠' : ''}</td>
              <td>${UI.esc(a.counselor_name || '')}${a.mode === 'online' ? '／視訊' : a.room_name ? '／' + UI.esc(a.room_name) : ''}</td>
              <td>${stateTag('appt_status', a.status)}</td></tr>`).concat(groups.map(g => `<tr>
              <td>${g.start_time}-${g.end_time}</td>
              <td><a href="#group/${g.group_id}">${UI.esc(g.group_name)}</a>（團體）</td>
              <td>${UI.esc(g.counselor_name || '')}${g.room_name ? '／' + UI.esc(g.room_name) : ''}</td>
              <td>-</td></tr>`)), '這天沒有排定的晤談')}
            <div style="font-size:13px;color:var(--muted);margin-top:10px">
              當日可預約時段：${avail.length ? avail.map(v => `${v.start_time}-${v.end_time}`).join('、') : '未設定'}</div>
            <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
              <button class="btn" id="cal-add">在這天新增預約</button>
              <a class="btn secondary" href="#schedule/${date}">切換到週檢視</a>
            </div>`,
          onOpen: (body, close) => {
            body.querySelector('#cal-add').onclick = () => {
              close();
              apptDialog(null, () => App.go('calendar/' + month),
                { date, counselor_id: Number(filterC) || App.me.id });
            };
          }
        });
      };
    });
  }
});

// ---- 候補遞補 ----
// 取消釋出的時段最容易空掉。這頁把「未來已取消而仍空著的時段」與候補名單湊在一起，
// 讓櫃檯直接挑人通知；通知走與晤談提醒相同的發送機制（未設 webhook 時只產生文字）。

function waitlistCandidateModal(slot) {
  const title = `${slot.date} ${slot.start_time}-${slot.end_time}　${slot.counselor_name || ''}`;
  UI.modal({
    title: `可遞補人選　${title}`,
    wide: true,
    hideFooter: true,
    body: '<div id="wl-body"><div class="empty">載入中...</div></div>',
    onOpen: async body => {
      const box = body.querySelector('#wl-body');
      const q = `counselor_id=${slot.counselor_id}&date=${slot.date}&start_time=${slot.start_time}&end_time=${slot.end_time || ''}`;
      let list;
      try { list = await GET(`/waitlist/matches?${q}`); } catch (e) { box.innerHTML = `<div class="empty">${UI.esc(e.message)}</div>`; return; }
      if (!list.length) {
        box.innerHTML = '<div class="empty">候補名單中沒有適合這個時段的人選（指定其他心理師者不列入）</div>';
        return;
      }
      box.innerHTML = UI.table(['優先序', '姓名／電話', '等候', '緊急度', '希望時段', '狀態', ''], list.map((c, i) => `<tr>
        <td>${i + 1}</td>
        <td>${UI.esc(c.name)}<br><span style="font-size:12px;color:var(--muted)">${UI.esc(c.phone || '未留電話')}</span></td>
        <td>${c.wait_days} 天</td>
        <td>${c.urgency === 'high' ? UI.tag('高', 'danger') : c.urgency === 'low' ? UI.tag('低') : UI.tag('一般')}</td>
        <td style="font-size:12.5px">${UI.esc(c.preferred_time || '-')}</td>
        <td style="font-size:12.5px">${c.notified_same_slot ? UI.tag('已通知此時段', 'ok')
    : c.notified_at ? `<span style="color:var(--muted)">上次通知 ${UI.esc(c.notified_at.slice(5, 16))}</span>` : ''}</td>
        <td><button class="btn tiny" data-wl="${c.id}">通知遞補</button>
          <a class="btn tiny secondary" href="#intake">來電清單</a></td></tr>`))
        + '<div style="font-size:12.5px;color:var(--muted);margin-top:8px">'
        + '排序依據：指定心理師 → 緊急度 → 希望時段是否吻合 → 等候天數。通知後請於來電清單完成派案與建檔。</div>';
      box.querySelectorAll('[data-wl]').forEach(b => {
        b.onclick = () => {
          const c = list.find(x => x.id === Number(b.dataset.wl));
          UI.modal({
            title: `通知 ${c.name} 遞補`,
            submitText: c.phone ? '送出通知' : '記錄為人工通知',
            body: `<div class="form-grid">
              ${UI.input('target', '收訊號碼', { value: c.phone || '', full: true, placeholder: '未留電話時請人工聯繫' })}
              ${UI.textarea('message', '通知內容', { value: c.message, rows: 5 })}
              <div class="form-row full" style="font-size:12.5px;color:var(--muted)">
                內容可自行修改。未於系統設定填入發送通道時，系統只會留存紀錄供人工發送，不會把個資送到外部服務。</div>
            </div>`,
            onSubmit: async form => {
              const f = UI.formData(form);
              const r = await POST('/waitlist/notify', {
                intake_id: c.id, counselor_id: slot.counselor_id, date: slot.date,
                start_time: slot.start_time, end_time: slot.end_time, message: f.message
              });
              UI.toast(r.message || '已記錄');
              App.go('waitlist');
            }
          });
        };
      });
    }
  });
}

App.page('waitlist', {
  title: '候補遞補',
  sub: '取消釋出的時段，配對候補名單並直接通知',
  help: [
    '這裡列出<strong>被取消而空出來的時段</strong>，右邊會算出有幾位候補人選符合。',
    '按「查看並通知」挑人發通知；對方回覆願意後，再按「直接排約」成立預約。',
    '想從候補名單反查時間，用「查任意時段候補」。',
    '候補名單本身是在個案或來電登記那邊登記的。',
  ],
  module: 'schedule',
  async render(el) {
    const from = localStorage.getItem('mc-wl-from') || UI.today();
    const to = localStorage.getItem('mc-wl-to') || UI.addDays(UI.today(), 30);
    const rows = await GET(`/waitlist/openings?from=${from}&to=${to}`);
    el.innerHTML = `
      <div class="toolbar">
        <label style="font-size:13px">期間</label>
        <input type="date" id="f" value="${from}">
        <span>~</span>
        <input type="date" id="t" value="${to}">
        <div class="spacer"></div>
        <button class="btn secondary" id="any">查任意時段候補</button>
      </div>
      <div class="card">
        <h3>釋出時段（${rows.length}）</h3>
        ${UI.table(['日期', '時間', '心理師', '釋出原因', '可遞補人選', ''], rows.map(r => `<tr>
          <td>${r.date}（${UI.weekdayName(r.date)}）</td>
          <td>${r.start_time}-${r.end_time}</td>
          <td>${UI.esc(r.counselor_name || '')}</td>
          <td>${r.status === 'no_show' ? '未到' : '取消'}${r.cancel_reason ? '／' + UI.esc(r.cancel_reason) : ''}</td>
          <td>${r.candidate_count ? UI.tag(r.candidate_count + ' 人', 'ok') : '<span style="color:var(--muted)">無</span>'}</td>
          <td><button class="btn tiny" data-slot="${r.id}"${r.candidate_count ? '' : ' disabled'}>查看並通知</button>
            <button class="btn tiny secondary" data-book="${r.id}">直接排約</button></td></tr>`),
    '此期間沒有釋出的時段')}
        <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
          只列出目前確實空著的時段（若已被其他預約補上或當日心理師請假就不會出現）。</div>
      </div>`;
    const reload = () => App.go('waitlist');
    el.querySelector('#f').onchange = e => { localStorage.setItem('mc-wl-from', e.target.value); reload(); };
    el.querySelector('#t').onchange = e => { localStorage.setItem('mc-wl-to', e.target.value); reload(); };
    el.querySelectorAll('[data-slot]').forEach(b => {
      b.onclick = () => waitlistCandidateModal(rows.find(r => r.id === Number(b.dataset.slot)));
    });
    el.querySelectorAll('[data-book]').forEach(b => {
      b.onclick = () => {
        const r = rows.find(x => x.id === Number(b.dataset.book));
        apptDialog(null, reload, { date: r.date, start_time: r.start_time, counselor_id: r.counselor_id });
      };
    });
    el.querySelector('#any').onclick = () => UI.modal({
      title: '查詢指定時段的候補人選',
      submitText: '查詢',
      body: `<div class="form-grid">
        ${UI.select('counselor_id', '心理師', App.counselorOptions(), { value: App.me.id })}
        ${UI.input('date', '日期', { type: 'date', value: UI.today() })}
        ${UI.input('start_time', '開始時間', { type: 'time', value: '14:00' })}
      </div>`,
      onSubmit: form => {
        const f = UI.formData(form);
        const u = App.counselorOptions().find(o => String(o[0]) === String(f.counselor_id));
        waitlistCandidateModal({
          counselor_id: Number(f.counselor_id), counselor_name: u ? u[1] : '',
          date: f.date, start_time: f.start_time, end_time: ''
        });
      }
    });
  }
});

// ---- 諮商室使用表（空間 × 星期 × 時段）----
// 比照所內原本用的 Google 試算表：一格一個 30 分鐘時段，
// 標明「個案」與「使用心理師」，兩者用顏色與標籤區分，不會看混。
App.page('room-board', {
  title: '諮商室使用表',
  sub: '每間空間一週的使用狀況；每格標明個案與使用心理師',
  help: [
    '每一間諮商室一週的使用狀況，每格標明個案與使用心理師，用來確認空間有沒有撞、還有哪些時段空著。',
    '上方可切換週次。這頁只看不改，要調整請到「預約排程」。',
    '格子底色代表方案別（自費白底、市民方案藍底、國軍黃底、青壯粉紅底、EAP 綠底、馬太鞍／北捷土黃底），沒指定方案的以自費白底呈現。',
    '點任一格晤談可直接開啟修改預約，改完方案底色就會跟著變。',
  ],
  module: 'schedule',
  async render(el, arg) {
    const start = arg || UI.mondayOf(UI.today());
    const d = await GET(`/rooms/week?start=${start}`);
    const days = Array.from({ length: 7 }, (_, i) => UI.addDays(d.start, i));
    const toMin = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    const label = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const from = toMin(d.grid.start), to = toMin(d.grid.end), step = d.grid.step || 30;

    // 格子底色沿用所內原本試算表的方案別配色（見下方圖例）
    const PLAN_COLORS = [
      { key: 'self', name: '自費', match: null, bg: '#ffffff', line: '#c8ccd4' },
      { key: 'citizen', name: '市民方案', match: /市民/, bg: '#dbeafe', line: '#3b82f6' },
      { key: 'army', name: '國軍', match: /國軍/, bg: '#fef3c7', line: '#eab308' },
      { key: 'youth', name: '青壯', match: /青壯/, bg: '#fce7f3', line: '#ec4899' },
      { key: 'eap', name: 'EAP', match: /EAP|員工協助/i, bg: '#dcfce7', line: '#22c55e' },
      { key: 'mtn', name: '馬太鞍／北捷', match: /馬太鞍|捷運/, bg: '#e3d5a1', line: '#a1863a' }
    ];
    // 沒對到任何方案關鍵字（含沒指定方案）一律當自費白底，跟原本試算表一致
    const planColor = it => PLAN_COLORS.find(c => c.match && c.match.test(it.plan || '')) || PLAN_COLORS[0];

    // 每格找出佔用它的那筆晤談；跨多格的晤談每格都標，看得出整段被佔用
    const cellFor = (roomId, date, m) => d.items.find(it => it.room_id === roomId && it.date === date
      && toMin(it.start_time) <= m && toMin(it.end_time) > m);

    const table = room => {
      const rows = [];
      for (let m = from; m < to; m += step) {
        rows.push(`<tr>
          <td style="white-space:nowrap;color:var(--muted);font-size:12.5px">${label(m)}-${label(m + step)}</td>
          ${days.map(date => {
    const it = cellFor(room.id, date, m);
    if (!it) return '<td></td>';
    const head = toMin(it.start_time) === m;   // 只在第一格寫字，後續格子只上色
    const pc = it.kind === 'group'
      ? { name: '團體', bg: 'var(--warn-bg)', line: 'var(--warn)' }
      : planColor(it);
    return `<td style="background:${pc.bg};border-left:3px solid ${pc.line}${it.id ? ';cursor:pointer' : ''}"
        ${it.id ? `data-appt="${it.id}" data-appt-date="${it.date}"` : ''}
        title="${UI.esc(it.plan || (it.kind === 'group' ? '團體' : '未指定方案（以自費白底呈現）'))}${it.id ? '　點一下可改方案' : ''}">
      ${head ? `<div style="font-size:12.5px;line-height:1.6;color:#1f2430">
        <div><span class="tag" style="font-size:11px">個案</span> <strong>${UI.esc(it.client)}</strong></div>
        <div><span class="tag ok" style="font-size:11px">心理師</span> ${UI.esc(it.counselor)}</div>
        <div style="opacity:.7">${it.start_time}-${it.end_time}${it.mode === 'online' ? '／視訊' : ''}</div>
        ${it.plan ? `<div style="opacity:.7">${UI.esc(it.plan)}</div>` : ''}
      </div>` : ''}</td>`;
  }).join('')}
        </tr>`);
      }
      return `<div class="card"><h3>${UI.esc(room.name)}
          <span style="font-size:13px;font-weight:400;color:var(--muted)">
            ${room.capacity > 1 ? `可容納 ${room.capacity} 人` : ''}${room.note ? '　' + UI.esc(room.note) : ''}</span></h3>
        <div class="table-wrap"><table class="list"><thead><tr><th>時段</th>
          ${days.map(dt => `<th>${dt.slice(5)}（${UI.weekdayName(dt)}）${dt === UI.today() ? ' ●' : ''}</th>`).join('')}
        </tr></thead><tbody>${rows.join('')}</tbody></table></div></div>`;
    };

    el.innerHTML = `<div class="toolbar">
        <button class="btn secondary small" id="prev">上一週</button>
        <button class="btn secondary small" id="this">本週</button>
        <button class="btn secondary small" id="next">下一週</button>
        <input type="date" id="pick" value="${d.start}" style="width:auto" title="選日期跳到該日所在的一週">
        <strong style="margin-left:6px">${d.start} ~ ${d.end}</strong>
        <div class="spacer"></div>
        <span style="font-size:12.5px;color:var(--muted)">
          <span class="tag" style="font-size:11px">個案</span> 來談者　
          <span class="tag ok" style="font-size:11px">心理師</span> 使用心理師</span>
      </div>
      <div class="card" style="padding:10px 12px">
        <div style="display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;font-size:12.5px">
          <strong style="font-size:13px">底色代表方案別</strong>
          ${PLAN_COLORS.map(c => `<span style="display:inline-flex;align-items:center;gap:6px">
            <span style="width:16px;height:16px;border-radius:3px;background:${c.bg};
              border:1px solid var(--line);border-left:3px solid ${c.line}"></span>${c.name}</span>`).join('')}
          <span style="display:inline-flex;align-items:center;gap:6px">
            <span style="width:16px;height:16px;border-radius:3px;background:var(--warn-bg);
              border:1px solid var(--line);border-left:3px solid var(--warn)"></span>團體</span>
          <span style="color:var(--muted)">點格子可改方案</span>
        </div>
      </div>
      ${d.unassigned.length ? `<div class="notice warn">
        尚未指定空間的到所晤談：${d.unassigned.map(u =>
    `${u.date.slice(5)} ${u.start_time} ${UI.esc(u.client)}（${UI.esc(u.counselor)}）`).join('、')}
        　請在預約中指定諮商室，否則不會出現在這張表上。</div>` : ''}
      ${d.rooms.length ? d.rooms.map(table).join('') : '<div class="empty">尚未建立諮商室，請至系統設定新增</div>'}`;

    // 點格子直接開修改預約（方案在裡面改），省得再切到預約排程找同一筆
    el.querySelectorAll('[data-appt]').forEach(td => {
      td.onclick = async () => {
        const list = await GET(`/appointments?date=${td.dataset.apptDate}`);
        const a = list.find(x => x.id === Number(td.dataset.appt));
        if (a) apptDialog(a, () => App.go('room-board/' + d.start));
        else UI.toast('找不到這筆預約，請重新整理', true);
      };
    });

    el.querySelector('#prev').onclick = () => App.go('room-board/' + UI.addDays(d.start, -7));
    el.querySelector('#next').onclick = () => App.go('room-board/' + UI.addDays(d.start, 7));
    el.querySelector('#this').onclick = () => App.go('room-board/' + UI.mondayOf(UI.today()));
    // 選任一天都跳到該日所在的整週，不必自己算週一是幾號
    el.querySelector('#pick').onchange = e => {
      if (e.target.value) App.go('room-board/' + UI.mondayOf(e.target.value));
    };
  }
});
