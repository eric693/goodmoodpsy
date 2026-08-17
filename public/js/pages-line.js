// 線上預約申請的審核，以及 LINE 官方帳號設定與推播

const BOOKING_STATUS = { new: '待處理', confirmed: '已成立', rejected: '未成立', cancelled: '已取消' };

async function bookingDialog(id, onDone) {
  const b = await GET(`/bookings/${id}`);
  const slotBtns = (b.slots || []).map(s =>
    `<button class="btn tiny secondary" type="button" data-slot="${s.start_time}" style="margin:2px">${s.start_time}</button>`).join('');
  const errs = (b.check.errors || []).map(e => `<div style="color:var(--danger)">✕ ${UI.esc(e)}</div>`).join('');
  const warns = (b.check.warnings || []).map(w => `<div style="color:#b8860b">！${UI.esc(w)}</div>`).join('');
  UI.modal({
    title: `預約申請：${b.name}`,
    wide: true,
    submitText: '成立預約',
    body: `<div class="detail-grid">
        <div><div class="dg-label">聯絡電話</div>${UI.esc(b.phone)}</div>
        <div><div class="dg-label">Email</div>${UI.esc(b.email || '-')}</div>
        <div><div class="dg-label">生日／年齡</div>${UI.esc(b.birth_date || '-')}${b.age !== null ? `（${b.age} 歲）` : ''}</div>
        <div><div class="dg-label">身分</div>${b.client_id ? `舊個案 ${UI.esc(b.client_code || '')}` : '初次預約'}</div>
        <div><div class="dg-label">方案</div>${UI.esc(b.plan_name || '-')}</div>
        <div><div class="dg-label">主題</div>${UI.esc(b.topic_name || '-')}</div>
        <div><div class="dg-label">指定心理師</div>${UI.esc(b.counselor_name || '未指定')}</div>
        <div><div class="dg-label">形式</div>${b.mode === 'online' ? '線上視訊' : '到所'}</div>
        <div><div class="dg-label">費用</div>${UI.fmtMoney(b.fee_choice)}</div>
        <div><div class="dg-label">送出時間</div>${UI.esc(b.created_at)}</div>
      </div>
      ${b.main_issue ? `<div style="margin-top:10px;font-size:13.5px"><strong>主訴：</strong>${UI.nl2br(b.main_issue)}</div>` : ''}
      ${b.expectation ? `<div style="font-size:13.5px"><strong>期待：</strong>${UI.nl2br(b.expectation)}</div>` : ''}
      ${b.alt_note ? `<div style="font-size:13.5px"><strong>其他可配合時段：</strong>${UI.nl2br(b.alt_note)}</div>` : ''}
      ${errs || warns ? `<div style="margin-top:10px;padding:10px;background:var(--primary-light);border-radius:8px;font-size:13px">${errs}${warns}</div>` : ''}
      <div class="form-grid" style="margin-top:12px">
        ${UI.select('counselor_id', '心理師', App.counselorOptions(), { value: b.counselor_id || '' })}
        ${UI.input('date', '日期', { type: 'date', value: b.date || UI.today() })}
        ${UI.input('start_time', '開始時間', { type: 'time', value: b.start_time || '14:00' })}
        ${UI.input('fee', '費用（留空沿用方案）', { type: 'number', value: b.fee_choice || '' })}
        ${UI.textarea('reply_note', '給個案的回覆／內部備註', { value: '' })}
        <div class="form-row full"><label>該心理師當日可預約時段</label>
          <div id="slots" style="font-size:13px;color:var(--muted)">${slotBtns || '該日無開放時段'}</div></div>
      </div>
      <div style="font-size:12.5px;color:var(--muted);margin-top:6px">
        諮商室由系統自動指派，個案端不會看到空間配置。
        ${b.client_id ? '' : '此人尚未建檔，成立預約前請先按「建檔」。'}</div>
      <div class="toolbar" style="margin-top:10px">
        ${b.client_id ? '' : '<button class="btn secondary" id="mkclient" type="button">由申請資料建檔</button>'}
        <div class="spacer"></div>
        <button class="btn danger" id="reject" type="button">未能成立（通知個案）</button>
      </div>`,
    onOpen: (el, close) => {
      el.querySelectorAll('[data-slot]').forEach(x => {
        x.onclick = () => { el.querySelector('[name=start_time]').value = x.dataset.slot; };
      });
      const refresh = async () => {
        const cid = el.querySelector('[name=counselor_id]').value;
        const date = el.querySelector('[name=date]').value;
        const box = el.querySelector('#slots');
        if (!cid || !date) return;
        const slots = await GET(`/slots?counselor_id=${cid}&date=${date}`).catch(() => []);
        box.innerHTML = slots.length
          ? slots.map(s => `<button class="btn tiny secondary" type="button" data-slot="${s.start_time}" style="margin:2px">${s.start_time}</button>`).join('')
          : '該日無開放時段';
        box.querySelectorAll('[data-slot]').forEach(x => {
          x.onclick = () => { el.querySelector('[name=start_time]').value = x.dataset.slot; };
        });
      };
      el.querySelector('[name=counselor_id]').onchange = refresh;
      el.querySelector('[name=date]').onchange = refresh;
      const mk = el.querySelector('#mkclient');
      if (mk) {
        mk.onclick = async () => {
          const r = await POST(`/bookings/${id}/create-client`);
          UI.toast(r.matched ? '已對應到既有個案' : `已建檔（${r.code}）`);
          close();
          bookingDialog(id, onDone);
        };
      }
      el.querySelector('#reject').onclick = async () => {
        const note = el.querySelector('[name=reply_note]').value;
        if (!await UI.confirm('確定要回覆此申請未能成立嗎？')) return;
        const r = await POST(`/bookings/${id}/reject`, { reply_note: note });
        UI.toast(r.notify ? `已回覆（${r.notify.message}）` : '已回覆');
        close();
        onDone && onDone();
      };
    },
    onSubmit: async el => {
      const data = UI.formData(el);
      const send = () => POST(`/bookings/${id}/confirm`, data);
      try {
        const r = await send();
        UI.toast(`已成立預約${r.notify ? '（' + r.notify.message + '）' : ''}`);
      } catch (e) {
        if (!/已使用|已排滿|限 /.test(e.message)) throw e;
        if (!await UI.confirm(`${e.message}\n\n仍要成立嗎？（會記錄於稽核軌跡）`)) return false;
        data.override = true;
        const r = await send();
        UI.toast(`已成立預約${r.notify ? '（' + r.notify.message + '）' : ''}`);
      }
      onDone && onDone();
    }
  });
}

App.page('bookings', {
  title: '線上預約申請',
  sub: '個案從預約表單或 LINE 送出的申請，確認後才寫進排程',
  module: 'schedule',
  async render(el) {
    const rows = await GET('/bookings');
    const pending = rows.filter(r => r.status === 'new');
    el.innerHTML = `<div class="card"><h3>待處理
        <span style="font-size:13px;font-weight:400;color:var(--muted)">${pending.length} 筆</span></h3>
      ${UI.table(['送出時間', '姓名／電話', '身分', '方案／主題', '希望時段', '心理師', '額度', ''],
      pending.map(r => `<tr>
        <td>${UI.esc(r.created_at.slice(5, 16))}</td>
        <td>${UI.esc(r.name)}<br><span style="font-size:12px;color:var(--muted)">${UI.esc(r.phone)}</span></td>
        <td>${r.client_id ? UI.tag('舊個案', 'primary') + '<br>' + UI.esc(r.client_code || '') : UI.tag('初次', 'warn')}
          ${r.age !== null ? `<br><span style="font-size:12px;color:var(--muted)">${r.age} 歲</span>` : ''}</td>
        <td>${UI.esc(r.plan_name || '-')}${r.topic_name ? '<br><span style="font-size:12px;color:var(--muted)">' + UI.esc(r.topic_name) + '</span>' : ''}</td>
        <td>${r.date ? `${r.date}<br>${r.start_time}` : UI.esc(r.alt_note || '未指定')}</td>
        <td>${UI.esc(r.counselor_name || '未指定')}</td>
        <td>${r.usage ? `${r.usage.used}/${r.usage.quota}${r.usage.over ? ' ' + UI.tag('已用完', 'danger') : ''}` : '-'}</td>
        <td><button class="btn tiny" data-b="${r.id}">處理</button></td></tr>`), '目前沒有待處理的申請')}</div>

      <div class="card"><h3>歷史申請</h3>
      ${UI.table(['送出時間', '姓名', '方案', '時段', '狀態', '處理'], rows.filter(r => r.status !== 'new').slice(0, 100)
      .map(r => `<tr>
        <td>${UI.esc(r.created_at.slice(0, 16))}</td><td>${UI.esc(r.name)}</td>
        <td>${UI.esc(r.plan_name || '-')}</td>
        <td>${r.date ? r.date + ' ' + r.start_time : '-'}</td>
        <td>${UI.tag(BOOKING_STATUS[r.status] || r.status, r.status === 'confirmed' ? 'ok' : '')}</td>
        <td>${UI.esc((r.handled_at || '').slice(0, 16))}${r.reply_note ? '<br><span style="font-size:12px;color:var(--muted)">' + UI.esc(r.reply_note) + '</span>' : ''}</td>
        </tr>`), '尚無紀錄')}</div>`;
    el.querySelectorAll('[data-b]').forEach(b => {
      b.onclick = () => bookingDialog(b.dataset.b, () => App.go('bookings'));
    });
  }
});

App.page('line', {
  title: 'LINE 官方帳號',
  sub: '預約通知、晤談提醒與心理師行程都以 Flex Message 推播',
  module: 'settings',
  async render(el) {
    const s = await GET('/line/status');
    el.innerHTML = `<div class="card"><h3>狀態</h3>
        <div style="font-size:14px;line-height:2">
          Messaging API：${s.enabled ? UI.tag('已啟用', 'ok') : UI.tag('未設定 Channel access token', 'danger')}
          　官方帳號：${UI.esc(s.official_name || '-')}<br>
          已綁定個案：<strong>${s.clients_bound}</strong> / ${s.clients_total}　已綁定員工：<strong>${s.staff_bound}</strong><br>
          晤談提醒：晤談前 ${s.reminder_hours} 小時　心理師行程：${s.daily_enabled ? `每日 ${s.daily_time} 推播隔日行程` : '未啟用'}<br>
          我的綁定：${s.me_bound ? UI.tag('已綁定', 'ok') : UI.tag('未綁定', 'warn')}
        </div>
        <div class="toolbar" style="margin-top:10px">
          <button class="btn secondary" id="mycode">產生我的綁定碼</button>
          <button class="btn secondary" id="test"${s.me_bound ? '' : ' disabled'}>推播測試（我的明日行程）</button>
          <div class="spacer"></div>
          <button class="btn secondary" id="remind">推播明日晤談提醒</button>
          <button class="btn" id="sched">推播心理師明日行程</button>
        </div>
        <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
          未設定 Channel access token 時，系統不會對外送出任何個資，只把訊息記錄為「待人工發送」。
          Webhook 網址請在 LINE Developers 設定為：<code>${location.origin}/api/line/webhook</code></div>
      </div>

      <div class="card"><h3>近期推播紀錄</h3>
        ${UI.table(['時間', '類型', '對象', '內容', '結果'], (s.recent || []).map(n => `<tr>
          <td>${UI.esc(n.created_at.slice(5, 16))}</td><td>${UI.esc(n.kind)}</td>
          <td>${UI.esc(n.client_name || n.target || '-')}</td>
          <td style="max-width:280px">${UI.esc(n.content || '')}</td>
          <td>${n.status === 'sent' ? UI.tag('已送出', 'ok')
      : n.status === 'manual' ? UI.tag('待人工', 'warn') : UI.tag('失敗', 'danger')}
            ${n.error ? `<br><span style="font-size:12px;color:var(--muted)">${UI.esc(n.error)}</span>` : ''}</td>
        </tr>`), '尚無推播紀錄')}</div>`;

    el.querySelector('#mycode').onclick = async () => {
      const r = await POST('/line/bind-code', { user_id: App.me.id });
      UI.modal({
        title: 'LINE 綁定碼', hideFooter: true,
        body: `<div style="text-align:center;font-size:30px;font-weight:700;letter-spacing:6px;margin:12px 0">${r.code}</div>
          <div style="font-size:13.5px;line-height:1.9">
            1. 用手機加入諮商所的 LINE 官方帳號${r.add_friend_url ? `（<a href="${UI.esc(r.add_friend_url)}" target="_blank" rel="noopener">加好友連結</a>）` : ''}<br>
            2. 在聊天室輸入上面 6 碼綁定碼<br>
            3. 收到「綁定完成」卡片即可接收行程與提醒<br>
            有效期限：${r.expires_at}</div>`
      });
    };
    el.querySelector('#test').onclick = async () => { const o = await POST('/line/test'); UI.toast(o.message); };
    el.querySelector('#remind').onclick = async () => {
      if (!await UI.confirm('推播明日所有已預約個案的晤談提醒？')) return;
      const r = await POST('/line/remind-batch', {});
      UI.toast(`${r.date}：共 ${r.count} 筆，成功 ${r.sent} 筆`);
      App.go('line');
    };
    el.querySelector('#sched').onclick = async () => {
      const r = await POST('/line/counselor-schedule', {});
      UI.toast(`已推播 ${r.results.length} 位心理師`);
      App.go('line');
    };
  }
});
