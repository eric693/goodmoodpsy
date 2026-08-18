// 轉介紀錄、結案後追蹤、責任通報表套印與經營指標
//
// 轉介與追蹤掛在個案頁的分頁；通報表由危機事件開啟；經營指標併入統計報表頁。

const REFERRAL_STATUS = [
  ['sent', '已轉出，尚無回覆'], ['accepted', '對方已接案'],
  ['declined', '對方未接案'], ['unknown', '無回覆／失聯']
];
const referralStatusTag = st => {
  const label = (REFERRAL_STATUS.find(s => s[0] === st) || [st, st])[1];
  return UI.tag(label, st === 'accepted' ? 'ok' : st === 'declined' ? 'danger' : 'warn');
};

function referralDialog(clientId, row, targets, onDone) {
  const r = row || { date: UI.today(), direction: 'out', status: 'sent' };
  UI.modal({
    title: row ? '編輯轉介紀錄' : '新增轉介紀錄',
    wide: true,
    body: `<div class="form-grid">
        ${UI.input('date', '轉介日期', { type: 'date', value: r.date })}
        ${UI.select('direction', '方向', [['out', '轉出（我們轉給對方）'], ['in', '轉入（對方轉介而來）']], { value: r.direction })}
        ${UI.inputList('target', '轉介對象', targets || [], { value: r.target || '', full: true, placeholder: '機構或單位名稱' })}
        ${UI.input('contact', '聯絡方式／窗口', { value: r.contact || '', full: true })}
        ${UI.textarea('reason', '轉介原因', { value: r.reason || '', rows: 2, placeholder: '例：需藥物評估、超出本所服務範圍、個案遷居' })}
        ${UI.select('status', '狀態', REFERRAL_STATUS, { value: r.status })}
        ${UI.textarea('reply_note', '對方回覆', { value: r.reply_note || '', rows: 2 })}
        ${UI.textarea('note', '備註', { value: r.note || '', rows: 2 })}
      </div>
      <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
        狀態改為「已接案」或「未接案」時，系統會自動記下回覆時間。</div>`,
    onSubmit: async el => {
      const data = UI.formData(el);
      if (row) await PUT(`/referrals/${row.id}`, data);
      else await POST(`/clients/${clientId}/referrals`, data);
      UI.toast('已儲存');
      onDone && onDone();
    }
  });
}

function followUpDialog(clientId, row, channels, onDone) {
  const f = row || { due_date: UI.addDays(UI.today(), 30), kind: '結案追蹤', status: 'pending' };
  UI.modal({
    title: row ? '追蹤紀錄' : '新增追蹤',
    body: `<div class="form-grid">
        ${UI.input('due_date', '預定追蹤日', { type: 'date', value: f.due_date })}
        ${UI.inputList('kind', '追蹤類型', ['結案追蹤', '轉介追蹤', '高風險關懷', '其他'], { value: f.kind })}
        ${row ? UI.select('status', '狀態', [['pending', '待追蹤'], ['done', '已完成'], ['skipped', '不需追蹤']], { value: f.status }) : ''}
        ${row ? UI.inputList('channel', '追蹤方式', channels || [], { value: f.channel || '' }) : ''}
        ${row ? UI.textarea('result', '追蹤結果（標記完成時必填）', { value: f.result || '', rows: 3, placeholder: '個案現況、是否需要再約、有無風險徵兆' }) : ''}
        ${UI.textarea('note', '備註', { value: f.note || '', rows: 2 })}
      </div>`,
    onSubmit: async el => {
      const data = UI.formData(el);
      if (row) {
        if (data.status === 'done' && !String(data.result || '').trim()) throw new Error('完成追蹤請填寫追蹤結果');
        await PUT(`/follow-ups/${row.id}`, data);
      } else {
        await POST(`/clients/${clientId}/follow-ups`, data);
      }
      UI.toast('已儲存');
      onDone && onDone();
    }
  });
}

// 個案頁分頁：轉介與追蹤合在一頁，實務上兩件事常一起看
async function aftercareTab(client, body, refresh) {
  const [ref, fu] = await Promise.all([
    GET(`/clients/${client.id}/referrals`),
    GET(`/clients/${client.id}/follow-ups`)
  ]);
  body.innerHTML = `
    <div class="card"><h3>轉介紀錄</h3>
      <div style="font-size:12.5px;color:var(--muted);margin-bottom:10px">
        轉出醫療、社政或其他諮商所都建議留紀錄；「對方是否接案」是日後說明已盡轉介義務的關鍵。</div>
      ${UI.table(['日期', '方向', '對象', '原因', '狀態', '回覆', ''], ref.rows.map(r => `<tr>
        <td>${r.date}</td>
        <td>${r.direction === 'in' ? '轉入' : '轉出'}</td>
        <td>${UI.esc(r.target)}${r.contact ? '<br><span style="font-size:12px;color:var(--muted)">' + UI.esc(r.contact) + '</span>' : ''}</td>
        <td style="font-size:13px">${UI.esc(r.reason || '')}</td>
        <td>${referralStatusTag(r.status)}</td>
        <td style="font-size:13px">${UI.esc(r.reply_note || '')}${r.replied_at ? '<br><span style="font-size:12px;color:var(--muted)">' + UI.esc(r.replied_at.slice(0, 16)) + '</span>' : ''}</td>
        <td style="white-space:nowrap"><button class="btn tiny secondary" data-re="${r.id}">編輯</button>
          <button class="btn tiny danger" data-rd="${r.id}">刪除</button></td></tr>`), '尚無轉介紀錄')}
      <button class="btn small" id="add-ref" style="margin-top:10px">新增轉介</button>
    </div>
    <div class="card"><h3>結案後追蹤</h3>
      <div style="font-size:12.5px;color:var(--muted);margin-bottom:10px">
        個案結案時系統會依設定自動建立追蹤點（可於系統設定調整天數），也可自行新增。</div>
      ${UI.table(['預定追蹤日', '類型', '狀態', '方式', '結果', ''], fu.rows.map(f => `<tr>
        <td>${f.due_date}${f.status === 'pending' && f.due_date < UI.today()
    ? ' <span style="color:var(--danger);font-weight:600">已逾期</span>' : ''}</td>
        <td>${UI.esc(f.kind)}</td>
        <td>${f.status === 'done' ? UI.tag('已完成', 'ok') : f.status === 'skipped' ? UI.tag('不需追蹤') : UI.tag('待追蹤', 'warn')}</td>
        <td>${UI.esc(f.channel || '')}</td>
        <td style="font-size:13px">${UI.esc(f.result || '')}${f.done_at ? '<br><span style="font-size:12px;color:var(--muted)">' + UI.esc(f.done_at.slice(0, 16)) + ' ' + UI.esc(f.done_by_name || '') + '</span>' : ''}</td>
        <td style="white-space:nowrap"><button class="btn tiny" data-fe="${f.id}">處理</button>
          <button class="btn tiny danger" data-fd="${f.id}">刪除</button></td></tr>`), '尚無追蹤紀錄')}
      <button class="btn small" id="add-fu" style="margin-top:10px">新增追蹤</button>
    </div>`;

  body.querySelector('#add-ref').onclick = () => referralDialog(client.id, null, ref.targets, refresh);
  body.querySelector('#add-fu').onclick = () => followUpDialog(client.id, null, fu.channels, refresh);
  body.querySelectorAll('[data-re]').forEach(b => {
    b.onclick = () => referralDialog(client.id, ref.rows.find(r => r.id === Number(b.dataset.re)), ref.targets, refresh);
  });
  body.querySelectorAll('[data-fe]').forEach(b => {
    b.onclick = () => followUpDialog(client.id, fu.rows.find(f => f.id === Number(b.dataset.fe)), fu.channels, refresh);
  });
  body.querySelectorAll('[data-rd]').forEach(b => {
    b.onclick = async () => {
      if (!await UI.confirm('刪除此轉介紀錄？')) return;
      try { await DEL(`/referrals/${b.dataset.rd}`); refresh(); } catch (e) { UI.err(e); }
    };
  });
  body.querySelectorAll('[data-fd]').forEach(b => {
    b.onclick = async () => {
      if (!await UI.confirm('刪除此追蹤紀錄？')) return;
      try { await DEL(`/follow-ups/${b.dataset.fd}`); refresh(); } catch (e) { UI.err(e); }
    };
  });
}

// ---- 待追蹤清單 ----
App.page('follow-ups', {
  title: '結案追蹤',
  sub: '結案後的關懷追蹤點，逾期未追蹤列於最前',
  module: 'notes',
  async render(el) {
    const d = await GET('/follow-ups');
    el.innerHTML = `
      <div class="stat-grid">
        <div class="stat"><div class="num ${d.overdue ? 'danger' : ''}">${d.overdue}</div><div class="label">逾期未追蹤</div></div>
        <div class="stat"><div class="num ${d.upcoming ? 'warn' : ''}">${d.upcoming}</div><div class="label">七日內到期</div></div>
      </div>
      <div class="card">
        ${UI.table(['預定追蹤日', '個案', '結案日', '主責心理師', '類型', '聯絡電話', ''], d.rows.map(r => `<tr>
          <td>${r.days_late > 0
    ? `<span style="color:var(--danger);font-weight:700">${r.due_date}（逾 ${r.days_late} 天）</span>`
    : r.due_date}</td>
          <td><a href="#client/${r.client_id}">${UI.esc(r.client_name)}（${r.client_code}）</a></td>
          <td>${UI.esc(r.close_date || '-')}</td>
          <td>${UI.esc(r.counselor_name || '')}</td>
          <td>${UI.esc(r.kind)}</td>
          <td>${UI.esc(r.client_phone || '')}</td>
          <td style="white-space:nowrap"><button class="btn tiny" data-f="${r.id}">完成追蹤</button>
            <button class="btn tiny secondary" data-fe="${r.id}">編輯</button>
            <button class="btn tiny danger" data-fd="${r.id}">刪除</button></td></tr>`),
    '目前沒有待處理的追蹤')}
        <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
          只列出已到期或七日內到期者。追蹤結果會留在個案頁的「轉介與追蹤」分頁。</div>
      </div>`;
    el.querySelectorAll('[data-f]').forEach(b => {
      b.onclick = () => {
        const row = d.rows.find(r => r.id === Number(b.dataset.f));
        followUpDialog(row.client_id, row, App.meta.follow_up_channels || ['電話', '簡訊', 'LINE', '面談'],
          () => App.go('follow-ups'));
      };
    });
    // 追蹤日排錯、類型要改：直接編輯，不必先標完成
    el.querySelectorAll('[data-fe]').forEach(b => {
      b.onclick = () => {
        const row = d.rows.find(r => r.id === Number(b.dataset.fe));
        followUpDialog(row.client_id, row, App.meta.follow_up_channels || ['電話', '簡訊', 'LINE', '面談'],
          () => App.go('follow-ups'));
      };
    });
    el.querySelectorAll('[data-fd]').forEach(b => {
      b.onclick = async () => {
        const row = d.rows.find(r => r.id === Number(b.dataset.fd));
        if (!await UI.confirm(`刪除 ${row.client_name} 於 ${row.due_date} 的追蹤點？`)) return;
        await DEL(`/follow-ups/${row.id}`);
        UI.toast('已刪除');
        App.go('follow-ups');
      };
    });
  }
});

// ---- 責任通報表套印 ----
async function reportFormPrint(riskId) {
  const d = await GET(`/risk-events/${riskId}/report-form`);
  const row = (label, value) => `<tr><th style="text-align:left;width:26%;background:#f5f8f8;padding:5px 8px;
    border:1px solid #dfe6ec;font-size:13px">${UI.esc(label)}</th>
    <td style="padding:5px 8px;border:1px solid #dfe6ec;font-size:13px;white-space:pre-wrap">${UI.esc(value || '')}</td></tr>`;
  UI.modal({
    title: '責任通報表（列印版）',
    wide: true,
    hideFooter: true,
    body: `<div id="rf-print">
        <div style="text-align:center;font-size:17px;font-weight:700;margin-bottom:4px">保護性個案責任通報表</div>
        <div style="text-align:center;font-size:12.5px;color:var(--muted);margin-bottom:12px">
          ${UI.esc(d.center_name)}${d.center_license_no ? '　開業執照字號：' + UI.esc(d.center_license_no) : ''}</div>
        <table style="width:100%;border-collapse:collapse">
          ${row('通報事件類型', d.type + (d.mandatory ? '（屬法定責任通報）' : '（非法定責任通報類型）'))}
          ${row('知悉日期', d.date)}
          ${row('應完成通報時限', d.report_due_at ? `${d.report_due_at}（知悉起 ${d.deadline_hours} 小時內）` : '—')}
          ${row('當事人姓名', d.client_name)}
          ${row('個案編號', d.client_code)}
          ${row('身分證統一編號', d.id_no)}
          ${row('性別／出生日期', `${TW.gender[d.gender] || d.gender || ''}　${d.birth_date || ''}${d.is_minor ? '（未成年）' : ''}`)}
          ${row('聯絡電話', d.client_phone)}
          ${row('住居所', d.address)}
          ${d.is_minor ? row('法定代理人', `${d.guardian_name || ''}　${d.guardian_relationship || ''}　${d.guardian_phone || ''}`) : ''}
          ${row('緊急聯絡人', `${d.emergency_name || ''}　${d.emergency_relationship || ''}　${d.emergency_phone || ''}`)}
          ${row('事件概要', d.description)}
          ${row('嚴重程度', TW.severity ? (TW.severity[d.severity] || d.severity) : d.severity)}
          ${row('已採取之處置', d.actions)}
          ${row('通報管道', d.report_channel || `（請擇一：${(d.report_channels || []).join('、')}）`)}
          ${row('通報時間', d.report_at)}
          ${row('通報案號', d.report_no)}
          ${row('主責心理師', d.counselor_name)}
          ${row('通報人', `${d.reporter.name}　${d.reporter.title || ''}${d.reporter.license_no
    ? '（' + d.reporter.license_type + ' ' + d.reporter.license_no + '）' : ''}`)}
          ${row('通報單位與聯絡方式', `${d.center_name}　${d.center_phone || ''}\n${d.center_address || ''}`)}
        </table>
        <div style="margin-top:14px;font-size:12.5px;color:var(--muted);line-height:1.8">
          本表供所內留存與抄錄之用；實際通報仍須依主管機關指定管道辦理
          （如 113 保護專線、關懷 e 起來線上通報、警政或衛生局），完成後請回填通報時間與案號。<br>
          通報人簽名：＿＿＿＿＿＿＿　　通報日期：＿＿＿＿＿＿＿
        </div>
      </div>
      <button class="btn small secondary" style="margin-top:14px" onclick="window.print()">列印</button>`
  });
}
