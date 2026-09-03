// 資料匯入：下載範本 → 上傳預覽（不寫入）→ 確認匯入。
// 預覽與匯入都送同一個檔案，後端各自重跑一次驗證，前端不回傳解析結果。

App.page('imports', {
  title: '資料匯入',
  sub: '把舊系統或 Excel 名冊搬進來；預覽階段完全不寫入，有任一列錯誤即整批拒絕',
  help: [
    '把舊系統或 Excel 的資料搬進來：先「下載範本」照格式填好，再「上傳並預覽」。',
    '預覽會逐列檢查，有問題的列會標出原因，確認沒問題才按「確認匯入」，不會半套寫入。',
    '看不懂欄位就按「欄位說明」。建議先在測試環境試一次。',
  ],
  // 匯入權限跟著各自的模組走，因此沒有專屬模組；四種模組都沒授權的人不顯示此頁
  visible: () => ['clients', 'schedule', 'billing', 'assessments'].some(m => App.can(m)),
  async render(el) {
    const defs = await GET('/imports');
    if (!defs.length) {
      el.innerHTML = '<div class="empty">您目前沒有可匯入的項目（匯入權限跟著各模組走）</div>';
      return;
    }
    el.innerHTML = `<div class="card">
        <h3>匯入步驟</h3>
        <div style="font-size:14px;line-height:1.9">
          ① 下載範本 → ② 把舊資料貼進去（表頭請勿更動）→ ③ 上傳預覽並檢查逐列結果 → ④ 確認匯入。<br>
          <span style="color:var(--muted);font-size:13px">
            接受 .xlsx 與 CSV。日期可填國曆或民國年（115/7/1）。手機欄位請在 Excel 中設為「文字」格式，
            否則開頭的 0 會消失。單次上限 5000 列。</span>
        </div>
      </div>
      ${defs.map(d => `<div class="card">
        <h3>${UI.esc(d.title)}</h3>
        <div style="font-size:13.5px;color:var(--muted);line-height:1.7;margin-bottom:10px">${UI.esc(d.description)}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <button class="btn small secondary" data-tpl="${d.key}">下載範本</button>
          <button class="btn small" data-up="${d.key}">上傳並預覽</button>
          <button class="btn small secondary" data-cols="${d.key}">欄位說明</button>
        </div>
      </div>`).join('')}`;

    el.querySelectorAll('[data-tpl]').forEach(b => {
      b.onclick = () => { window.location.href = `/api/imports/${b.dataset.tpl}/template`; };
    });
    el.querySelectorAll('[data-cols]').forEach(b => {
      const d = defs.find(x => x.key === b.dataset.cols);
      b.onclick = () => UI.modal({
        title: `${d.title} — 欄位說明`, wide: true, hideFooter: true,
        body: UI.table(['欄位', '必填', '說明'], d.columns.map(c => `<tr>
          <td><strong>${UI.esc(c.label)}</strong></td>
          <td>${c.required ? UI.tag('必填', 'danger') : ''}</td>
          <td style="color:var(--muted)">${UI.esc(c.hint || '')}</td></tr>`))
      });
    });
    el.querySelectorAll('[data-up]').forEach(b => {
      const d = defs.find(x => x.key === b.dataset.up);
      b.onclick = () => importDialog(d);
    });
  }
});

function importDialog(def) {
  UI.modal({
    title: `匯入 ${def.title}`,
    wide: true,
    submitText: '預覽',
    body: `<div class="form-grid">
        <div class="form-row full"><label>檔案 *</label>
          <input name="file" type="file" accept=".xlsx,.csv,.txt"></div>
        ${def.update_only ? `<div class="form-row full">
          <label>處理方式</label>
          <select name="mode"><option value="update">更新既有個案（這張表不會新增個案）</option></select></div>`
    : def.updatable ? `<div class="form-row full">
          <label>已存在的資料如何處理</label>
          <select name="mode">
            <option value="skip">略過不動（預設）</option>
            <option value="update">以檔案內容更新（只覆蓋有填的欄位）</option>
          </select></div>` : ''}
      </div>
      <div id="pv" style="margin-top:14px"></div>`,
    onSubmit: async (el, close) => {
      const input = el.querySelector('[name=file]');
      if (!input.files.length) throw new Error('請選擇檔案');
      const file = input.files[0];
      const mode = el.querySelector('[name=mode]') ? el.querySelector('[name=mode]').value : 'skip';

      const fd = new FormData();
      fd.append('file', file);
      const r = await POST(`/imports/${def.key}/preview`, fd);
      renderPreview(el.querySelector('#pv'), def, r, mode, file, close);
      return false;   // 停留在視窗，等使用者看完預覽再按確認匯入
    }
  });
}

function renderPreview(box, def, r, mode, file, closeModal) {
  const s = r.summary;
  const blocked = s.error > 0;
  const willWrite = mode === 'update' ? s.ok + s.duplicate : s.ok;

  box.innerHTML = `
    <div class="notice ${blocked ? 'danger' : 'ok'}">
      共 ${s.total} 列：可新增 <strong>${s.ok}</strong> 列、
      已存在 <strong>${s.duplicate}</strong> 列（${mode === 'update' ? '將更新' : '將略過'}）、
      有警告 <strong>${s.warning}</strong> 列、<strong>錯誤 ${s.error}</strong> 列。
      ${blocked ? '<br>有錯誤的列存在，<strong>整批不會匯入</strong>，請修正檔案後重新上傳。'
    : `<br>確認無誤後按下方按鈕，將寫入 <strong>${willWrite}</strong> 列。`}
    </div>
    ${r.unknown && r.unknown.length ? `<div class="notice warn" style="margin-top:8px">
      以下欄位無法對應，其內容不會被匯入：${r.unknown.map(u => UI.esc(u)).join('、')}</div>` : ''}
    <div style="max-height:340px;overflow:auto;margin-top:10px">
      ${UI.table(['列', '內容', '狀態'], r.rows.map(row => {
      const label = row.data.name || row.data.client_label || row.data.item || row.data.scale || '';
      const extra = [row.data.date, row.data.scale && row.data.total !== undefined ? `${row.data.scale} ${row.data.total} 分` : '',
        row.data.amount ? UI.fmtMoney(row.data.amount) : ''].filter(Boolean).join('　');
      return `<tr>
          <td>${row.row_no}</td>
          <td>${UI.esc(label)}${extra ? `<br><span style="font-size:12px;color:var(--muted)">${UI.esc(extra)}</span>` : ''}</td>
          <td>
            ${row.errors.map(e => `<div style="color:var(--danger)">✕ ${UI.esc(e)}</div>`).join('')}
            ${row.warnings.map(w => `<div style="color:var(--warn)">⚠ ${UI.esc(w)}</div>`).join('')}
            ${!row.errors.length && row.existing
    ? `<div style="color:var(--muted)">已存在：${UI.esc(row.existing.name)}${row.existing.code ? '（' + UI.esc(row.existing.code) + '）' : ''}　依${UI.esc(row.existing.matched_by)}比對</div>`
    : ''}
            ${!row.errors.length && !row.warnings.length && !row.existing ? '<span style="color:var(--ok,#2f8f5b)">可新增</span>' : ''}
          </td></tr>`;
    }))}
    </div>
    ${blocked ? '' : `<div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end">
      <button class="btn" id="doImport">確認匯入 ${willWrite} 列</button></div>`}`;

  const go = box.querySelector('#doImport');
  if (!go) return;
  go.onclick = async () => {
    go.disabled = true;
    go.textContent = '匯入中…';
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('mode', mode);
      const res = await POST(`/imports/${def.key}/commit`, fd);
      closeModal();
      UI.modal({
        title: '匯入完成', hideFooter: true,
        body: `<div class="notice ok">
          新增 <strong>${res.inserted}</strong> 列、更新 <strong>${res.updated}</strong> 列、
          略過 <strong>${res.skipped}</strong> 列，共處理 ${res.total} 列。</div>`
      });
      App.go('imports');
    } catch (e) {
      go.disabled = false;
      go.textContent = '確認匯入';
      UI.err(e);
    }
  };
}
