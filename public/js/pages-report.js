// 心理衡鑑報告書：結構化撰寫、分數表、簽核定稿（定稿後不可修改）與列印。
// 保密層級同晤談紀錄，後端以 canViewClientNotes 把關，每次調閱記入稽核。

const REPORT_VALIDITY = { valid: '結果可信', caution: '解釋需保留', invalid: '不宜採用' };

// 常見衡鑑工具，供撰寫時挑選（可自行輸入其他工具）
const REPORT_INSTRUMENTS = [
  'WAIS-IV 魏氏成人智力量表', 'WISC-V 魏氏兒童智力量表', 'WPPSI-IV 魏氏幼兒智力量表',
  'MMPI-2 明尼蘇達多相人格測驗', 'BAI 貝克焦慮量表', 'BDI-II 貝克憂鬱量表',
  'Bender 完形測驗', 'CBCL 兒童行為檢核表', 'SNAP-IV 注意力量表',
  '羅夏克墨漬測驗', 'TAT 主題統覺測驗', '畫人測驗（DAP）', '房樹人測驗（HTP）',
  '臨床晤談', '行為觀察'
];

function reportScoreRow(s = {}) {
  return `<tr>
    <td><input class="sc-instrument" value="${UI.esc(s.instrument || '')}" placeholder="WAIS-IV"></td>
    <td><input class="sc-index" value="${UI.esc(s.index || '')}" placeholder="全量表智商 FSIQ"></td>
    <td><input class="sc-score" value="${UI.esc(s.score || '')}" placeholder="98"></td>
    <td><input class="sc-norm" value="${UI.esc(s.norm || '')}" placeholder="PR 45／中等"></td>
    <td><input class="sc-interp" value="${UI.esc(s.interpretation || '')}" placeholder="整體智能屬中等範圍"></td>
    <td><button class="btn tiny danger" data-rm type="button">移除</button></td></tr>`;
}

function collectScores(el) {
  return Array.from(el.querySelectorAll('#sc-body tr')).map(tr => ({
    instrument: tr.querySelector('.sc-instrument').value.trim(),
    index: tr.querySelector('.sc-index').value.trim(),
    score: tr.querySelector('.sc-score').value.trim(),
    norm: tr.querySelector('.sc-norm').value.trim(),
    interpretation: tr.querySelector('.sc-interp').value.trim()
  })).filter(s => s.instrument || s.index);
}

async function reportDialog(seed, onDone) {
  const r = seed.id ? await GET(`/reports/${seed.id}`) : {
    client_id: seed.client_id, test_date: seed.test_date || UI.today(), report_date: UI.today(),
    validity: 'valid', scores: []
  };
  const locked = !!r.locked;

  const m = UI.modal({
    title: locked ? '衡鑑報告（已簽核，僅供檢視）' : (r.id ? '編輯衡鑑報告' : '新增衡鑑報告'),
    wide: true,
    submitText: locked ? '關閉' : '儲存',
    body: `<div class="form-grid">
        ${UI.input('test_date', '施測日期', { type: 'date', value: r.test_date || UI.today() })}
        ${UI.input('report_date', '報告完成日', { type: 'date', value: r.report_date || UI.today() })}
        ${UI.input('referral_source', '轉介單位／人', { value: r.referral_source || '' })}
        ${UI.select('validity', '結果效度', Object.entries(REPORT_VALIDITY), { value: r.validity || 'valid' })}
        ${UI.textarea('purpose', '轉介問題／評估目的', { value: r.purpose || '', rows: 3 })}
        ${UI.textarea('instruments', '施測工具（每行一項）', { value: r.instruments || '', rows: 4 })}
        <div class="form-row full" id="inst-pick" style="margin-top:-8px">
          <div style="font-size:12.5px;color:var(--muted);margin-bottom:4px">點選加入常用工具：</div>
          <div>${REPORT_INSTRUMENTS.map(i => `<button class="btn tiny secondary" type="button" data-ins="${UI.esc(i)}" style="margin:2px">${UI.esc(i)}</button>`).join('')}</div>
        </div>
        ${UI.textarea('background', '背景資料與相關病史', { value: r.background || '', rows: 4 })}
        ${UI.textarea('observation', '行為觀察與測驗態度', { value: r.observation || '', rows: 4 })}
        ${UI.textarea('results', '測驗結果敘述', { value: r.results || '', rows: 5 })}
      </div>
      <div class="card" style="margin-top:6px"><h3>分數摘要</h3>
        <div class="table-wrap"><table class="list"><thead><tr>
          <th style="min-width:120px">工具</th><th style="min-width:120px">指標</th><th style="min-width:70px">分數</th>
          <th style="min-width:100px">常模位置</th><th style="min-width:160px">判讀</th><th></th>
        </tr></thead><tbody id="sc-body">${(r.scores || []).map(reportScoreRow).join('')}</tbody></table></div>
        <button class="btn small secondary" id="sc-add" type="button" style="margin-top:8px">新增一列</button>
        <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
          分數僅為判讀依據之一，請於「綜合摘要」中整合行為觀察與背景資料後作成結論。</div>
      </div>
      <div class="form-grid">
        ${UI.textarea('impression', '綜合摘要與臨床印象', { value: r.impression || '', rows: 5 })}
        ${UI.textarea('recommendation', '建議', { value: r.recommendation || '', rows: 4 })}
      </div>
      ${locked ? `<div class="notice ok" style="margin-top:10px">
        本報告已於 ${UI.esc(r.signed_at)} 由 ${UI.esc(r.counselor_name || '')} 簽核定稿，不可修改；如需更正請另立新報告。</div>` : ''}
      <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
        ${r.id ? '<button class="btn secondary" id="rp-print" type="button">列印／另存 PDF</button>' : ''}
        ${r.id && !locked && r.counselor_id === App.me.id ? '<button class="btn" id="rp-sign" type="button">簽核定稿</button>' : ''}
      </div>`,
    onSubmit: async el => {
      if (locked) return true;
      const data = UI.formData(el);
      data.scores = collectScores(el);
      data.client_id = r.client_id || seed.client_id;
      if (r.id) await PUT(`/reports/${r.id}`, data);
      else await POST('/reports', data);
      UI.toast('已儲存');
      onDone && onDone();
    },
    onOpen: (el, close) => {
      if (locked) el.querySelectorAll('input, textarea, select').forEach(i => { i.disabled = true; });
      el.querySelector('#sc-add').onclick = () => {
        el.querySelector('#sc-body').insertAdjacentHTML('beforeend', reportScoreRow());
        bindRemove();
      };
      const bindRemove = () => el.querySelectorAll('[data-rm]').forEach(b => { b.onclick = () => b.closest('tr').remove(); });
      bindRemove();
      el.querySelectorAll('[data-ins]').forEach(b => {
        b.onclick = () => {
          const ta = el.querySelector('[name=instruments]');
          const lines = ta.value.split('\n').map(s => s.trim()).filter(Boolean);
          if (!lines.includes(b.dataset.ins)) lines.push(b.dataset.ins);
          ta.value = lines.join('\n');
        };
      });
      const pr = el.querySelector('#rp-print');
      if (pr) pr.onclick = () => printReport(r.id);
      const sg = el.querySelector('#rp-sign');
      if (sg) {
        sg.onclick = async () => {
          if (!await UI.confirm('簽核後報告即定稿，不可再修改。確定簽核？')) return;
          try {
            // 先存檔再簽核，避免畫面上尚未儲存的修改被鎖在外面
            const data = UI.formData(el);
            data.scores = collectScores(el);
            await PUT(`/reports/${r.id}`, data);
            await POST(`/reports/${r.id}/sign`, {});
            UI.toast('已簽核定稿');
            close();
            onDone && onDone();
          } catch (e) { UI.err(e); }
        };
      }
    }
  });
  return m;
}

// 列印版：抬頭用所別資訊，落款帶心理師證照字號
async function printReport(id) {
  const r = await GET(`/reports/${id}`);
  const sec = (t, v) => v ? `<div style="margin-top:14px"><div style="font-weight:700;font-size:15px;border-bottom:1px solid #999;padding-bottom:3px;margin-bottom:6px">${t}</div>
    <div style="font-size:14px;line-height:1.9">${UI.nl2br(v)}</div></div>` : '';
  UI.modal({
    title: '心理衡鑑報告（列印版）', wide: true, hideFooter: true,
    body: `<div id="printable" style="font-size:14px;line-height:1.9">
        <div style="text-align:center;margin-bottom:6px">
          <div style="font-size:19px;font-weight:800">${UI.esc(App.me.center_name || '')}</div>
          <div style="font-size:17px;font-weight:700;margin-top:4px">心理衡鑑報告書</div>
        </div>
        <div class="detail-grid">
          <div><div class="dg-label">個案編號</div>${UI.esc(r.client_code || '')}</div>
          <div><div class="dg-label">姓名</div>${UI.esc(r.client_name || '')}</div>
          <div><div class="dg-label">性別／出生日期</div>${UI.esc(TW.gender[r.gender] || '-')}／${UI.esc(r.birth_date || '-')}</div>
          <div><div class="dg-label">施測日期</div>${UI.esc(r.test_date)}</div>
          <div><div class="dg-label">報告日期</div>${UI.esc(r.report_date || '')}</div>
          <div><div class="dg-label">轉介來源</div>${UI.esc(r.referral_source || '-')}</div>
        </div>
        ${sec('轉介問題／評估目的', r.purpose)}
        ${sec('施測工具', r.instruments)}
        ${sec('背景資料', r.background)}
        ${sec('行為觀察與測驗態度', r.observation)}
        ${r.scores && r.scores.length ? `<div style="margin-top:14px">
          <div style="font-weight:700;font-size:15px;border-bottom:1px solid #999;padding-bottom:3px;margin-bottom:6px">分數摘要</div>
          ${UI.table(['工具', '指標', '分數', '常模位置', '判讀'], r.scores.map(s => `<tr>
            <td>${UI.esc(s.instrument)}</td><td>${UI.esc(s.index)}</td><td>${UI.esc(s.score)}</td>
            <td>${UI.esc(s.norm)}</td><td>${UI.esc(s.interpretation)}</td></tr>`))}</div>` : ''}
        ${sec('測驗結果', r.results)}
        ${sec('綜合摘要與臨床印象', r.impression)}
        ${sec('建議', r.recommendation)}
        <div style="margin-top:16px;font-size:13px;color:#555">
          結果效度：${UI.esc(REPORT_VALIDITY[r.validity] || r.validity)}
          ${r.locked ? `簽核時間：${UI.esc(r.signed_at)}` : '（本報告尚未簽核定稿，僅供內部參考）'}</div>
        <div style="margin-top:26px;font-size:14px">
          施測與撰寫心理師：${UI.esc(r.counselor_name || '')}
          ${r.license_type ? `　${UI.esc(r.license_type)}` : ''}${r.license_no ? `　證書字號：${UI.esc(r.license_no)}` : ''}
          <div style="margin-top:22px">簽章：＿＿＿＿＿＿＿＿＿＿</div>
        </div>
        <div style="margin-top:18px;font-size:12px;color:#777;line-height:1.7">
          本報告內容屬高度敏感之個人資料，僅供轉介目的使用，未經個案（或法定代理人）書面同意不得轉交第三人。
          測驗結果反映施測當時之狀態，解釋時應併同臨床資料綜合判斷。</div>
      </div>
      <button class="btn small secondary" style="margin-top:14px" onclick="window.print()">列印</button>`
  });
}

// 個案頁「衡鑑報告」分頁內容
async function renderReportTab(client, body, refresh) {
  const rows = await GET(`/clients/${client.id}/reports`);
  body.innerHTML = `<div class="toolbar">
      <div style="font-size:12.5px;color:var(--muted)">
        報告保密層級同晤談紀錄，每次調閱記入稽核；簽核定稿後不可修改。</div>
      <div class="spacer"></div>
      ${App.isCounselor() ? '<button class="btn small" id="nr">新增報告</button>' : ''}</div>
    <div class="card">${UI.table(['施測日期', '施測工具', '心理師', '效度', '狀態', ''], rows.map(r => `<tr>
      <td>${r.test_date}</td>
      <td>${UI.esc((r.instruments || '').split('\n').filter(Boolean).slice(0, 2).join('、') || '-')}
        ${(r.instruments || '').split('\n').filter(Boolean).length > 2 ? ' 等' : ''}</td>
      <td>${UI.esc(r.counselor_name || '')}</td>
      <td>${UI.esc(REPORT_VALIDITY[r.validity] || r.validity)}</td>
      <td>${r.locked ? UI.tag('已簽核', 'ok') : UI.tag('草稿', 'warn')}</td>
      <td style="white-space:nowrap">
        <button class="btn tiny secondary" data-r="${r.id}">${r.locked ? '檢視' : '編輯'}</button>
        <button class="btn tiny secondary" data-rp="${r.id}">列印</button>
        ${r.locked ? '' : `<button class="btn tiny danger" data-rd="${r.id}">刪除</button>`}
      </td></tr>`), '尚無衡鑑報告')}</div>`;
  const nr = body.querySelector('#nr');
  if (nr) nr.onclick = () => reportDialog({ client_id: client.id }, refresh);
  body.querySelectorAll('[data-r]').forEach(b => {
    b.onclick = () => reportDialog({ id: Number(b.dataset.r), client_id: client.id }, refresh);
  });
  body.querySelectorAll('[data-rp]').forEach(b => { b.onclick = () => printReport(Number(b.dataset.rp)); });
  body.querySelectorAll('[data-rd]').forEach(b => {
    b.onclick = async () => {
      if (!await UI.confirm('刪除此份草稿報告？')) return;
      try { await DEL(`/reports/${b.dataset.rd}`); UI.toast('已刪除'); refresh(); } catch (e) { UI.err(e); }
    };
  });
}
