// 方案設定（方案 × 主題 × 心理師費率）、方案人次看板、心理師月收支

const PLAN_KIND = { self: '自費', subsidy: '補助方案', partner: '合作單位' };

function planDialog(p, onDone) {
  const isNew = !p;
  const d = p || {
    kind: 'self', appt_type: 'individual', fee_mode: 'fixed', fee: App.meta.default_fee || 2000,
    share_mode: 'percent', share_percent: 0.6, portal_visible: 1, require_review: 1, active: 1
  };
  UI.modal({
    title: isNew ? '新增方案' : `編輯方案：${d.name}`,
    wide: true,
    body: `<div class="form-grid">
      ${UI.input('name', '方案名稱', { value: d.name || '', required: true, full: true })}
      ${UI.select('kind', '性質', Object.entries(PLAN_KIND), { value: d.kind })}
      ${UI.select('appt_type', '晤談類型', App.enumOptions('appt_type'), { value: d.appt_type })}
      ${UI.select('fee_mode', '收費方式', [['fixed', '固定金額'], ['choice', '預約時挑選金額']], { value: d.fee_mode })}
      ${UI.input('fee', '金額（預設）', { type: 'number', value: d.fee || 0 })}
      ${UI.input('fee_options', '可選金額（逗號分隔）', { value: d.fee_options || '', placeholder: '3000,3600,4500', full: true })}
      ${UI.input('session_minutes', '晤談時長（分鐘，0 沿用系統設定）', { type: 'number', value: d.session_minutes || 0 })}
      ${UI.select('default_mode', '預設形式', [['onsite', '到所晤談'], ['online', '線上視訊']], { value: d.default_mode || 'onsite' })}
      ${UI.input('subsidy_amount', '方案給付金額（其餘為個案自付）', { type: 'number', value: d.subsidy_amount || 0 })}
      ${UI.input('venue_fee', '場地費（所方全收，不列入抽成基數）', { type: 'number', value: d.venue_fee || 0 })}
      ${UI.inputList('subsidy_program', '核銷用方案名稱', App.meta.subsidy_programs || [], { value: d.subsidy_program || '', full: true })}
      ${UI.input('age_min', '年齡下限（0 不限）', { type: 'number', value: d.age_min || 0 })}
      ${UI.input('age_max', '年齡上限（0 不限）', { type: 'number', value: d.age_max || 0 })}
      ${UI.input('quota_per_year', '每人每年可用次數（0 不限）', { type: 'number', value: d.quota_per_year || 0 })}
      ${UI.input('counselor_week_limit', '每位心理師每週人次（0 不限）', { type: 'number', value: d.counselor_week_limit || 0 })}
      ${UI.input('counselor_month_limit', '每位心理師每月人次（0 不限）', { type: 'number', value: d.counselor_month_limit || 0 })}
      ${UI.select('share_mode', '心理師報酬方式', [['percent', '抽成比例'], ['fixed', '固定鐘點費']], { value: d.share_mode })}
      ${UI.input('share_percent', '抽成比例（可填 0.6 或 60）', { value: d.share_percent || 0 })}
      ${UI.input('share_fixed', '固定鐘點費', { type: 'number', value: d.share_fixed || 0 })}
      ${UI.textarea('intro', '線上預約表單上的說明', { value: d.intro || '' })}
      ${UI.textarea('note', '內部備註', { value: d.note || '' })}
      ${UI.checkbox('portal_visible', '開放線上預約表單顯示此方案', d.portal_visible)}
      ${UI.checkbox('require_review', '線上預約需櫃檯確認才成立', d.require_review)}
      ${UI.input('sort', '排序', { type: 'number', value: d.sort || 0 })}
      ${isNew ? '' : UI.checkbox('active', '啟用中', d.active)}
    </div>
    <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
      年齡與次數限制用於補助方案的資格控管（如衛福部年輕族群方案 15-45 歲、每年 3 次）；
      每位心理師的人次上限可在下方「心理師費率」再個別調整。</div>`,
    onSubmit: async el => {
      const data = UI.formData(el);
      if (isNew) await POST('/service-plans', data); else await PUT(`/service-plans/${d.id}`, data);
      UI.toast('已儲存');
      onDone && onDone();
    }
  });
}

function topicDialog(planId, t, onDone) {
  const d = t || { fee: 0, sort: 0, active: 1 };
  UI.modal({
    title: t ? '編輯主題' : '新增主題',
    body: `<div class="form-grid">
      ${UI.input('name', '主題名稱', { value: d.name || '', required: true, full: true })}
      ${UI.input('fee', '金額（0 沿用方案）', { type: 'number', value: d.fee || 0 })}
      ${UI.input('sort', '排序', { type: 'number', value: d.sort || 0 })}
      ${UI.input('fee_options', '可選金額（逗號分隔，0 沿用方案）', { value: d.fee_options || '', full: true })}
      ${UI.textarea('note', '備註', { value: d.note || '' })}
      ${t ? UI.checkbox('active', '啟用中', d.active) : ''}
    </div>`,
    onSubmit: async el => {
      const data = UI.formData(el);
      if (t) await PUT(`/topics/${t.id}`, data); else await POST(`/service-plans/${planId}/topics`, data);
      UI.toast('已儲存');
      onDone && onDone();
    }
  });
}

function rateDialog(plan, r, onDone) {
  const d = r || { share_mode: '', share_percent: 0, week_limit: '', month_limit: '', bookable: 1, active: 1 };
  UI.modal({
    title: r ? `編輯費率：${r.counselor_name}` : `新增心理師費率：${plan.name}`,
    wide: true,
    body: `<div class="form-grid">
      ${r ? '' : UI.select('counselor_id', '心理師', App.counselorOptions(), { value: d.counselor_id || '' })}
      ${r ? '' : UI.select('topic_id', '限定主題（可留空 = 全部主題）',
      [['', '全部主題']].concat((plan.topics || []).filter(t => t.active).map(t => [t.id, t.name])), { value: '' })}
      ${UI.input('fee', '金額（0 沿用方案／主題）', { type: 'number', value: d.fee || 0 })}
      ${UI.select('share_mode', '報酬方式', [['', '沿用方案'], ['percent', '抽成比例'], ['fixed', '固定鐘點費']], { value: d.share_mode })}
      ${UI.input('share_percent', '抽成比例（0.6 或 60）', { value: d.share_percent || 0 })}
      ${UI.input('share_fixed', '固定鐘點費', { type: 'number', value: d.share_fixed || 0 })}
      ${UI.input('week_limit', '每週人次（留空沿用方案，0 不限）', { type: 'number', value: d.week_limit === -1 ? '' : d.week_limit })}
      ${UI.input('month_limit', '每月人次（留空沿用方案，0 不限）', { type: 'number', value: d.month_limit === -1 ? '' : d.month_limit })}
      ${UI.checkbox('bookable', '開放此方案的線上預約', d.bookable)}
      ${r ? UI.checkbox('active', '啟用中', d.active) : ''}
    </div>`,
    onSubmit: async el => {
      const data = UI.formData(el);
      if (r) await PUT(`/rates/${r.id}`, data); else await POST(`/service-plans/${plan.id}/rates`, data);
      UI.toast('已儲存');
      onDone && onDone();
    }
  });
}

App.page('plans', {
  title: '方案設定',
  sub: '方案 × 主題 × 心理師的收費、資格與人次上限，皆可自訂',
  help: [
    '一個「方案」＝一組收費規則：晤談時長、價格、資格限制、次數上限、心理師報酬怎麼算。排約選了方案，結束時間與費用就照它算。',
    '方案底下可再加「主題」（不同主題不同價）與「心理師費率」（同方案不同心理師抽成不同）。',
    '已經有預約在用的方案不要直接刪，改用「停用」，舊資料才不會對不上。',
  ],
  module: 'settings',
  async render(el) {
    const plans = await GET('/service-plans');
    const shareText = p => (p.share_mode === 'fixed'
      ? `固定 ${UI.fmtMoney(p.share_fixed)}`
      : `${Math.round((p.share_percent || 0) * 100)}%`);
    el.innerHTML = `<div class="toolbar"><div class="spacer"></div>
        <button class="btn" id="add">新增方案</button></div>
      <div class="card" style="background:var(--primary-light);border:0">
        <h3 style="margin-bottom:6px">心理師報酬（抽成）怎麼設、怎麼算
          <button class="btn tiny secondary" id="helptoggle" style="float:right">展開說明</button></h3>
        <div id="planhelp" style="display:none;font-size:13.5px;line-height:2">
          <strong>一、在哪裡設</strong><br>
          按方案上的「編輯方案」，往下捲到報酬設定：<br>
          ・<strong>心理師報酬方式</strong>＝抽成比例（拆帳）或固定鐘點費（不論收多少，每場給固定金額）<br>
          ・<strong>抽成比例</strong>＝填 0.6 或 60 都可以，系統一律當成 60%<br>
          某位心理師談好不同條件時，用「新增心理師費率」單獨設定，不必動整個方案。<br><br>
          <strong>二、抽成基數是「應收金額 − 場地費」</strong><br>
          場地費算所方收入，不參與拆帳。以青壯世代方案為例：<br>
          總額 1,800（方案給付 1,600 ＋ 個案自付場地費 200），抽成 60% →
          心理師 (1800 − 200) × 60% = <strong>960</strong>，所方 1800 − 960 = <strong>840</strong>。<br>
          不希望場地費影響拆帳的話，把「場地費」留 0 即可。<br><br>
          <strong>三、三層優先順序（下面蓋上面）</strong><br>
          心理師費率 → 主題 → 方案預設。<br>
          某位心理師在某個主題有單獨費率就用他的；沒有就看主題；再沒有才用方案預設。<br><br>
          <strong>四、什麼時候定案</strong><br>
          報酬在<strong>晤談按下「完成」的當下就鎖定</strong>在那筆預約上。
          之後調整抽成只影響往後完成的晤談，不會回頭改動已結算的月份。<br><br>
          <strong>五、去哪裡看結果</strong><br>
          「心理師收支」頁看每月完成場次、應收、報酬與所方淨收（可列印對帳）；
          「報酬與扣繳」頁把報酬開成給付單，試算代扣所得稅與二代健保補充保費。
        </div>
      </div>
      ${plans.map(p => `<div class="card"${p.active ? '' : ' style="opacity:.6"'}>
        <h3>${UI.esc(p.name)}
          ${UI.tag(PLAN_KIND[p.kind] || p.kind, p.kind === 'subsidy' ? 'warn' : 'primary')}
          ${p.active ? '' : UI.tag('已停用', 'danger')}
          ${p.portal_visible ? UI.tag('線上可約', 'ok') : ''}</h3>
        <div style="font-size:13.5px;color:var(--muted);line-height:1.9;margin-bottom:8px">
          金額：${p.fee_mode === 'choice' ? `可選 ${p.fee_option_list.join(' / ')}（預設 ${p.fee}）` : UI.fmtMoney(p.fee)}
          ${p.subsidy_amount ? `　方案給付 ${UI.fmtMoney(p.subsidy_amount)}／個案付 ${UI.fmtMoney(Math.max(0, p.fee - p.subsidy_amount))}` : ''}
          ${p.venue_fee ? `　場地費 ${UI.fmtMoney(p.venue_fee)}（所方收入）` : ''}
          　時長：${p.session_minutes || App.meta.session_minutes} 分鐘
          　形式：${p.default_mode === 'online' ? '線上視訊' : '到所晤談'}
          　心理師報酬：${shareText(p)}<br>
          資格：${p.age_min || p.age_max ? `${p.age_min || 0}-${p.age_max || '不限'} 歲` : '不限年齡'}
          ${p.quota_per_year ? `　每人每年 ${p.quota_per_year} 次` : ''}
          ${p.counselor_week_limit ? `　每位心理師每週 ${p.counselor_week_limit} 人次` : ''}
          ${p.counselor_month_limit ? `　每月 ${p.counselor_month_limit} 人次` : ''}
          　本月已排 ${p.month_sessions} 人次
        </div>
        <div class="toolbar" style="margin-bottom:6px">
          <button class="btn tiny secondary" data-ep="${p.id}">編輯方案</button>
          <button class="btn tiny secondary" data-at="${p.id}">新增主題</button>
          <button class="btn tiny secondary" data-ar="${p.id}">新增心理師費率</button>
          <div class="spacer"></div>
          <button class="btn tiny danger" data-dp="${p.id}">刪除／停用</button>
        </div>
        <div style="display:flex;gap:16px;flex-wrap:wrap">
          <div style="flex:1;min-width:260px">
            <div style="font-size:13px;font-weight:600;margin-bottom:4px">主題</div>
            ${p.topics.length ? p.topics.map(t => `<span class="tag" style="margin:2px">${UI.esc(t.name)}${t.fee ? `／${t.fee}` : ''}
              <a href="#" data-et="${t.id}" style="margin-left:4px">改</a>
              <a href="#" data-dt="${t.id}" style="margin-left:2px">刪</a></span>`).join('')
    : '<span style="color:var(--muted);font-size:13px">尚未設定主題</span>'}
          </div>
          <div style="flex:1;min-width:300px">
            <div style="font-size:13px;font-weight:600;margin-bottom:4px">心理師費率</div>
            ${p.rates.length ? UI.table(['心理師', '金額', '報酬', '週／月人次', ''], p.rates.map(r => `<tr>
                <td>${UI.esc(r.counselor_name)}${r.topic_id ? '（限主題）' : ''}</td>
                <td>${r.fee ? UI.fmtMoney(r.fee) : '沿用'}</td>
                <td>${r.share_mode === 'fixed' ? UI.fmtMoney(r.share_fixed)
      : r.share_mode === 'percent' ? Math.round(r.share_percent * 100) + '%' : '沿用'}</td>
                <td>${r.week_limit === -1 ? '沿用' : (r.week_limit || '不限')} / ${r.month_limit === -1 ? '沿用' : (r.month_limit || '不限')}</td>
                <td><button class="btn tiny secondary" data-er="${r.id}">改</button>
                  <button class="btn tiny danger" data-dr="${r.id}">刪</button></td></tr>`))
    : '<span style="color:var(--muted);font-size:13px">未設定，全所沿用方案預設</span>'}
          </div>
        </div>
      </div>`).join('')}`;

    const reload = () => App.go('plans');
    // 說明預設收合，需要時才展開，不佔掉整頁版面
    const help = el.querySelector('#planhelp'), ht = el.querySelector('#helptoggle');
    ht.onclick = () => {
      const open = help.style.display === 'none';
      help.style.display = open ? '' : 'none';
      ht.textContent = open ? '收合說明' : '展開說明';
    };
    el.querySelector('#add').onclick = () => planDialog(null, reload);
    const find = id => plans.find(p => p.id === Number(id));
    el.querySelectorAll('[data-ep]').forEach(b => { b.onclick = () => planDialog(find(b.dataset.ep), reload); });
    el.querySelectorAll('[data-at]').forEach(b => { b.onclick = () => topicDialog(Number(b.dataset.at), null, reload); });
    el.querySelectorAll('[data-ar]').forEach(b => { b.onclick = () => rateDialog(find(b.dataset.ar), null, reload); });
    el.querySelectorAll('[data-dp]').forEach(b => {
      b.onclick = async () => {
        if (!await UI.confirm('確定要刪除此方案嗎？已有預約使用者會改為停用。')) return;
        const r = await DEL(`/service-plans/${b.dataset.dp}`);
        UI.toast(r.message || '已刪除');
        reload();
      };
    });
    el.querySelectorAll('[data-et]').forEach(a => {
      a.onclick = e => {
        e.preventDefault();
        const t = plans.flatMap(p => p.topics).find(x => x.id === Number(a.dataset.et));
        topicDialog(t.plan_id, t, reload);
      };
    });
    el.querySelectorAll('[data-dt]').forEach(a => {
      a.onclick = async e => {
        e.preventDefault();
        if (!await UI.confirm('確定要刪除此主題嗎？')) return;
        const r = await DEL(`/topics/${a.dataset.dt}`);
        UI.toast(r.message || '已刪除');
        reload();
      };
    });
    el.querySelectorAll('[data-er]').forEach(b => {
      b.onclick = () => {
        const r = plans.flatMap(p => p.rates).find(x => x.id === Number(b.dataset.er));
        rateDialog(find(r.plan_id), r, reload);
      };
    });
    el.querySelectorAll('[data-dr]').forEach(b => {
      b.onclick = async () => {
        if (!await UI.confirm('確定要刪除此費率設定？該心理師將沿用方案預設。')) return;
        await DEL(`/rates/${b.dataset.dr}`);
        UI.toast('已刪除');
        reload();
      };
    });
  }
});

App.page('plan-board', {
  title: '方案人次',
  sub: '各心理師在限量方案的本週／本月已排人次，額滿者顯示下週餘額',
  help: [
    '有人次上限的方案（多為公費補助案），各心理師本週／本月已排幾人次一目了然，額滿的會顯示下週餘額。',
    '上限有調整時按「調整上限」；系統外已用掉的人次用「填已用人次」補登。',
  ],
  module: 'schedule',
  async render(el) {
    const date = (location.hash.split('/')[1]) || UI.today();
    const data = await GET(`/plan-board?date=${date}`);
    const byPlan = new Map();
    for (const r of data.rows) {
      if (!byPlan.has(r.plan_name)) byPlan.set(r.plan_name, []);
      byPlan.get(r.plan_name).push(r);
    }
    el.innerHTML = `<div class="toolbar">
        <input type="date" id="d" value="${date}">
        <div class="spacer"></div></div>
      ${[...byPlan.entries()].map(([name, rows]) => `<div class="card"><h3>${UI.esc(name)}
        ${App.can('settings') ? `<button class="btn tiny danger" data-delplan="${rows[0].plan_id}"
          style="float:right">刪除方案</button>` : ''}</h3>
        ${UI.table(['心理師', `本週（${rows[0].week_start} ~ ${rows[0].week_end}）`, '本月', '狀態', ''], rows.map((r, i) => `<tr>
          <td>${UI.esc(r.counselor_name)}</td>
          <td>${r.week_used}${r.week_limit ? ' / ' + r.week_limit : '（不限）'}
            ${r.override_week >= 0 ? '<span style="font-size:12px;color:var(--muted)">　個別設定</span>' : ''}</td>
          <td>${r.month_used}${r.month_limit ? ' / ' + r.month_limit : '（不限）'}
            ${r.override_month >= 0 ? '<span style="font-size:12px;color:var(--muted)">　個別設定</span>' : ''}</td>
          <td>${r.week_full
      ? UI.tag('本週額滿', 'danger') + (r.next_week ? `<span style="font-size:12px;color:var(--muted)">　下週 ${r.next_week.week_start} 起尚餘 ${r.next_week.remaining ?? '不限'} 人次</span>` : '')
      : r.month_full ? UI.tag('本月額滿', 'danger')
        : UI.tag(`尚可 ${r.week_remaining ?? '不限'} 人次`, 'ok')}</td>
          <td style="text-align:right;white-space:nowrap">${App.can('settings') || r.counselor_id === App.me.id
      ? `<button class="btn tiny secondary" data-lim="${UI.esc(name)}" data-i="${i}">調整上限</button>
         <button class="btn tiny secondary" data-use="${UI.esc(name)}" data-i="${i}">填已用人次</button>` : ''}</td></tr>`))}
      </div>`).join('') || '<div class="empty">目前沒有設定人次上限的方案</div>'}`;
    el.querySelector('#d').onchange = e => { location.hash = `plan-board/${e.target.value}`; };

    // 已用人次可以直接填實際數字：他所已接的案、系統外排的場次都算進去
    el.querySelectorAll('[data-use]').forEach(b => {
      b.onclick = () => {
        const r = byPlan.get(b.dataset.use)[Number(b.dataset.i)];
        UI.modal({
          title: `${r.counselor_name}　已用人次`,
          body: `<div class="form-grid">
              ${UI.input('week_used', `本週已用（${r.week_start} ~ ${r.week_end}）`, { type: 'number', min: 0, value: r.week_used })}
              ${UI.input('month_used', `本月已用（${r.month}）`, { type: 'number', min: 0, value: r.month_used })}
              ${UI.input('note', '調整說明', { value: '', full: true, placeholder: '例如：他所已接 2 位' })}
            </div>
            <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
              系統內已排 本週 ${r.week_system_used}、本月 ${r.month_system_used} 人次；
              填入的數字與系統統計的差額會存成人工調整，之後系統內新增預約仍會照常累加。
              調整記入稽核軌跡。</div>`,
          onSubmit: async bodyEl => {
            await PUT('/plan-board/usage', Object.assign({
              plan_id: r.plan_id, counselor_id: r.counselor_id, date
            }, UI.formData(bodyEl)));
            UI.toast('已更新已用人次');
            App.go(`plan-board/${date}`);
          }
        });
      };
    });
    el.querySelectorAll('[data-delplan]').forEach(b => {
      b.onclick = async () => {
        if (!await UI.confirm('刪除整個方案？已有預約使用過的方案會改為停用以保留歷史紀錄。')) return;
        const r = await DEL(`/service-plans/${b.dataset.delplan}`);
        UI.toast(r.message || '已刪除');
        App.go(`plan-board/${date}`);
      };
    });
    // 人次上限就在這頁改：-1 沿用方案、0 不限、其他為個別上限
    el.querySelectorAll('[data-lim]').forEach(b => {
      b.onclick = () => {
        const r = byPlan.get(b.dataset.lim)[Number(b.dataset.i)];
        const field = (key, label, ov, planVal) =>
          UI.select(`${key}_mode`, `${label}上限`, [
            ['inherit', `沿用方案設定（${planVal > 0 ? planVal + ' 人次' : '不限'}）`],
            ['none', '不限'],
            ['custom', '個別上限']
          ], { value: ov < 0 ? 'inherit' : ov === 0 ? 'none' : 'custom' })
          + UI.input(`${key}_value`, `${label}人次`,
            { type: 'number', min: 1, value: ov > 0 ? ov : '', placeholder: '例如 6' });
        UI.modal({
          title: `${r.counselor_name}　${b.dataset.lim}`,
          body: `<div class="form-grid">
              ${field('week', '每週', r.override_week, r.plan_week_limit)}
              ${field('month', '每月', r.override_month, r.plan_month_limit)}
            </div>
            <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
              只影響這位心理師在此方案的上限，其他心理師不受影響；調整會記入稽核軌跡。
              已排入的預約不會被回頭取消。
              ${App.can('settings') ? '' : '心理師僅能調整自己的上限。'}</div>`,
          onSubmit: async bodyEl => {
            const f = UI.formData(bodyEl);
            const pick = key => (f[key + '_mode'] === 'inherit' ? -1
              : f[key + '_mode'] === 'none' ? 0 : Math.max(1, Number(f[key + '_value']) || 1));
            await PUT('/plan-board/limit', {
              plan_id: r.plan_id, counselor_id: r.counselor_id,
              week_limit: pick('week'), month_limit: pick('month')
            });
            UI.toast('已更新人次上限');
            App.go(`plan-board/${date}`);
          }
        });
      };
    });
  }
});

App.page('income', {
  title: '心理師收支',
  sub: '依方案別結算每位心理師每月的服務量、收入、報酬與所方淨收',
  help: [
    '依方案別結算每位心理師每月的服務量、收入、報酬與所方淨收。',
    '按「明細／列印」看該心理師逐筆晤談的組成，可列印給對方核對。',
    '只計已完成的晤談。',
  ],
  module: 'reports',
  async render(el) {
    const month = (location.hash.split('/')[1]) || UI.thisMonth();
    const d = await GET(`/plan-income?month=${month}`);
    const t = d.total;
    el.innerHTML = `<div class="toolbar">
        <input type="month" id="m" value="${month}">
        <div class="spacer"></div></div>
      <div class="card"><h3>${month} 全所合計</h3>
        ${UI.table(['項目', '金額／數量', '說明'], [
    `<tr><td>完成場次</td><td style="text-align:right"><strong>${t.sessions}</strong></td>
       <td style="color:var(--muted)">未到 ${t.no_shows} 場</td></tr>`,
    `<tr><td>服務總額</td><td style="text-align:right"><strong>${UI.fmtMoney(t.gross)}</strong></td>
       <td style="color:var(--muted)">本月已完成晤談的應收合計</td></tr>`,
    `<tr><td>方案給付</td><td style="text-align:right">${UI.fmtMoney(t.subsidy)}</td>
       <td style="color:var(--muted)">補助方案由公部門支付的部分</td></tr>`,
    `<tr><td>個案自付</td><td style="text-align:right">${UI.fmtMoney(t.self_pay)}</td>
       <td style="color:var(--muted)">其中場地費 ${UI.fmtMoney(t.venue)}</td></tr>`,
    `<tr><td>心理師報酬</td><td style="text-align:right"><strong>${UI.fmtMoney(t.share)}</strong></td>
       <td style="color:var(--muted)">以「服務總額 − 場地費」為基數計算</td></tr>`,
    `<tr><td>所方淨收</td><td style="text-align:right"><strong>${UI.fmtMoney(t.center)}</strong></td>
       <td style="color:var(--muted)">服務總額 − 心理師報酬</td></tr>`,
    `<tr><td>實收</td><td style="text-align:right">${UI.fmtMoney(t.collected)}</td>
       <td style="color:var(--muted)">已收款金額</td></tr>`,
    `<tr><td>未收</td><td style="text-align:right;color:var(--danger)">${UI.fmtMoney(t.uncollected)}</td>
       <td style="color:var(--muted)">尚未收款，可於收費管理催收</td></tr>`
  ])}
        ${UI.barChart(d.rows.map(r => ({ label: r.counselor_name, value: r.share, note: `${r.sessions} 場` })),
      { horizontal: true, format: v => UI.fmtMoney(v), title: '心理師報酬' })}
      </div>
      ${d.rows.map(r => `<div class="card"><h3>${UI.esc(r.counselor_name)}
          <span style="font-size:13px;font-weight:400;color:var(--muted)">
            ${r.sessions} 場｜應收 ${UI.fmtMoney(r.gross)}｜報酬 ${UI.fmtMoney(r.share)}｜所方 ${UI.fmtMoney(r.center)}</span>
          ${r.payout_status === 'paid' ? UI.tag('報酬已付', 'ok') : r.payout_status === 'pending' ? UI.tag('報酬待付', 'warn') : ''}</h3>
        ${UI.table(['方案', '場次', '服務總額', '方案給付', '個案自付', '場地費', '心理師報酬', '所方淨收'],
      r.plans.map(p => `<tr>
          <td>${UI.esc(p.plan_name)}</td><td>${p.sessions}</td><td>${UI.fmtMoney(p.gross)}</td>
          <td>${UI.fmtMoney(p.subsidy)}</td><td>${UI.fmtMoney(p.self_pay)}</td>
          <td>${UI.fmtMoney(p.venue)}</td>
          <td>${UI.fmtMoney(p.share)}</td><td>${UI.fmtMoney(p.center)}</td></tr>`))}
        <div style="font-size:12.5px;color:var(--muted);margin-top:6px">
          心理師報酬以「服務總額 − 場地費」為基數計算（場地費全額為所方收入），
          比例或鐘點費在「系統 → 方案設定」設定；金額於晤談按下「完成」時鎖定，事後改設定不會回頭變動此表。</div>
        <div class="toolbar" style="margin-top:8px"><div class="spacer"></div>
          <button class="btn tiny secondary" data-detail="${r.counselor_id}">明細／列印</button></div>
      </div>`).join('') || '<div class="empty">本月尚無已完成的晤談</div>'}`;

    el.querySelector('#m').onchange = e => { location.hash = `income/${e.target.value}`; };
    el.querySelectorAll('[data-detail]').forEach(b => {
      b.onclick = async () => {
        const dd = await GET(`/plan-income/${b.dataset.detail}/detail?month=${month}`);
        UI.modal({
          title: `${dd.counselor.name}　${month} 明細`, wide: true, hideFooter: true,
          body: `<div id="printable">
            <div style="text-align:center;font-size:17px;font-weight:700;margin-bottom:8px">
              ${UI.esc(dd.center_name)}　心理師服務明細</div>
            <div style="font-size:14px;margin-bottom:8px">心理師：${UI.esc(dd.counselor.name)}　結算月份：${month}</div>
            ${UI.table(['日期', '時間', '個案', '方案／主題', '狀態', '個案自付', '方案給付', '報酬', '收款'], dd.rows.map(r => `<tr>
              <td>${r.date}</td><td>${r.start_time}</td>
              <td>${UI.esc(r.client_code || '')} ${UI.esc(r.client_name || '')}</td>
              <td>${UI.esc(r.plan_name || '-')}${r.topic_name ? '／' + UI.esc(r.topic_name) : ''}</td>
              <td>${TW.appt_status[r.status]}</td>
              <td>${UI.fmtMoney(r.fee)}</td><td>${UI.fmtMoney(r.subsidy_amount || 0)}</td>
              <td>${UI.fmtMoney(r.counselor_share)}</td>
              <td>${r.invoice_status ? TW.inv_status[r.invoice_status] : '-'}</td></tr>`))}
            <div style="margin-top:10px;font-size:15px;text-align:right">
              服務總額合計 ${UI.fmtMoney(dd.total_gross)}　心理師報酬合計 <strong>${UI.fmtMoney(dd.total_share)}</strong></div>
          </div>
          <button class="btn small secondary" style="margin-top:14px" onclick="window.print()">列印</button>`
        });
      };
    });
  }
});

// ---- 自費結算 ----
// 自費的錢是心理師當場收走的，這頁只回答一件事：這個月他手上有多少、其中該繳回所方多少。
// 現金與轉帳分開列，月底點鈔與看銀行帳才對得起來。
App.page('self-pay', {
  title: '自費結算',
  sub: '各心理師自費收款（現金／轉帳分列）與月底應繳回所方的抽成',
  help: [
    '自費款由心理師當場收走，這頁算出月底各人該繳回所方多少：應繳回＝實收 − 心理師報酬。',
    '現金與轉帳分開列，點鈔與對銀行帳可以分頭核對；退費已從實收扣除。',
    '按「明細／列印」可印出逐筆清單（含個案姓名）給心理師核對簽收。',
    '「已收 N 筆」只算錢已經收到的，未收款的另計在「未收」欄（也有筆數），兩者相加才是本月自費總筆數。',
    '月份以收費單日期為準；補助方案不在這頁，請看「方案服務量」。',
  ],
  module: 'reports',
  async render(el) {
    const month = (location.hash.split('/')[1]) || UI.thisMonth();
    const d = await GET(`/plan-income/self-pay?month=${month}`);
    const t = d.total;
    // 同一位心理師的自費收款依方案分組，看得出錢是從哪個方案來的
    const byPlan = r => {
      const out = [];
      for (const x of r.details) {
        if (x.status === 'unpaid') continue;
        const name = x.plan_name || '未指定方案';
        let row = out.find(o => o.name === name);
        if (!row) { row = { name, n: 0, net: 0, share: 0, due_back: 0 }; out.push(row); }
        row.n++; row.net += x.net; row.share += x.share; row.due_back += x.due_back;
      }
      return out.sort((a, b) => b.net - a.net);
    };
    // 表上每個筆數與金額都點得進去，看得到是哪幾筆——月底對帳時
    // 最常問的就是「這 9 筆是哪 9 筆」，不該還要自己回收費管理撈。
    const link = (cid, f, html) =>
      `<a href="#" class="dl" data-open="${cid}" data-f="${f}">${html}</a>`;
    const mcol = (byMethod, m, cid) => {
      const v = byMethod[m];
      if (!v) return '<td style="text-align:right">—</td>';
      return `<td style="text-align:right">${link(cid, 'method:' + m,
        UI.fmtMoney(v.amt) + `<span style="font-size:12px;color:var(--muted)">（${v.n}）</span>`)}</td>`;
    };
    const unpaidCol = (row, cid) => `<td style="text-align:right">${row.unpaid
      ? link(cid, 'unpaid', `<span style="color:var(--danger)">${UI.fmtMoney(row.unpaid)}</span>`
        + `<span style="font-size:12px;color:var(--muted)">（${row.unpaid_count} 筆）</span>`)
      : '—'}</td>`;

    el.innerHTML = `<div class="toolbar">
        <input type="month" id="m" value="${month}">
        <div class="spacer"></div>
        <button class="btn secondary small" onclick="window.print()">列印</button></div>
      <div class="stat-grid">
        ${d.methods.map(m => `<div class="stat"><div class="num">${link('all', 'method:' + m,
    UI.fmtMoney((t.by_method[m] || {}).amt || 0))}</div>
          <div class="label">${UI.esc(m)}收款（${(t.by_method[m] || {}).n || 0} 筆）</div></div>`).join('')}
        <div class="stat"><div class="num">${link('all', 'paid', UI.fmtMoney(t.collected))}</div>
          <div class="label">自費實收合計（${t.count} 筆）</div></div>
        <div class="stat"><div class="num">${UI.fmtMoney(t.share)}</div><div class="label">心理師報酬</div></div>
        <div class="stat"><div class="num warn">${UI.fmtMoney(t.due_back)}</div><div class="label">應繳回所方</div></div>
        ${t.unpaid ? `<div class="stat"><div class="num" style="color:var(--danger)">${link('all', 'unpaid', UI.fmtMoney(t.unpaid))}</div>
          <div class="label">自費未收（${t.unpaid_count} 筆）</div></div>` : ''}
      </div>
      <div class="card"><h3>${month} 各心理師自費收款</h3>
        ${UI.table(['心理師'].concat(d.methods).concat(['實收合計', '心理師報酬', '應繳回所方', '未收']),
    d.rows.map(r => `<tr>
          <td>${UI.esc(r.counselor_name)}<span style="font-size:12px;color:var(--muted)">　${
      link(r.counselor_id, 'paid', `已收 ${r.count} 筆`)}</span></td>
          ${d.methods.map(m => mcol(r.by_method, m, r.counselor_id)).join('')}
          <td style="text-align:right"><strong>${link(r.counselor_id, 'paid', UI.fmtMoney(r.collected))}</strong></td>
          <td style="text-align:right">${UI.fmtMoney(r.share)}</td>
          <td style="text-align:right"><strong style="color:var(--warn)">${UI.fmtMoney(r.due_back)}</strong></td>
          ${unpaidCol(r, r.counselor_id)}
        </tr>`).concat(d.rows.length > 1 ? [`<tr style="background:var(--primary-light);font-weight:700">
          <td>合計<span style="font-size:12px;font-weight:400;color:var(--muted)">　${
      link('all', 'paid', `已收 ${t.count} 筆`)}</span></td>
          ${d.methods.map(m => mcol(t.by_method, m, 'all')).join('')}
          <td style="text-align:right">${UI.fmtMoney(t.collected)}</td>
          <td style="text-align:right">${UI.fmtMoney(t.share)}</td>
          <td style="text-align:right">${UI.fmtMoney(t.due_back)}</td>
          ${unpaidCol(t, 'all')}</tr>`] : []),
    '本月尚無自費收款')}
        <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
          表上的筆數與金額都可以點，會列出是哪幾筆。
          「已收 N 筆」只算錢已經收到的；還沒收到的另計在「未收」欄（也標了筆數），兩者相加才是本月自費的總筆數。
          月份以收費單日期為準，跨月才收到的錢算在收款的那個月；補助方案不在這頁，請看「方案服務量」。<br>
          應繳回所方＝自費實收 − 心理師報酬；退費已從實收扣除。
          報酬金額於晤談按下「完成」時鎖定，事後改方案設定不會回頭變動此表。
          ${d.rows.some(r => (r.details || []).some(x => x.no_appointment))
    ? '標示「無對應晤談」者（如預付方案整筆收款）沒有可鎖定的報酬，報酬以 0 計，請自行核對。' : ''}</div></div>
      ${d.rows.map(r => `<div class="card"><h3>${UI.esc(r.counselor_name)}
          <span style="font-size:13px;font-weight:400;color:var(--muted)">
            ${link(r.counselor_id, 'paid', `已收 ${r.count} 筆`)}　實收 ${UI.fmtMoney(r.collected)}｜報酬 ${UI.fmtMoney(r.share)}｜應繳回 ${UI.fmtMoney(r.due_back)}
            ${r.unpaid_count ? `｜${link(r.counselor_id, 'unpaid', `另有未收 ${r.unpaid_count} 筆 ${UI.fmtMoney(r.unpaid)}`)}` : ''}</span></h3>
        ${UI.table(['方案', '已收筆數', '實收', '心理師報酬', '應繳回所方'], byPlan(r).map(p => `<tr>
          <td>${UI.esc(p.name)}</td>
          <td>${link(r.counselor_id, 'plan:' + p.name, p.n + ' 筆')}</td>
          <td style="text-align:right">${UI.fmtMoney(p.net)}</td>
          <td style="text-align:right">${UI.fmtMoney(p.share)}</td>
          <td style="text-align:right">${UI.fmtMoney(p.due_back)}</td></tr>`), '本月尚無已收款的自費，明細可看未收清單')}
        <div class="toolbar" style="margin-top:8px"><div class="spacer"></div>
          <button class="btn tiny secondary" data-open="${r.counselor_id}" data-f="all">明細／列印</button></div></div>`).join('')}`;

    el.querySelector('#m').onchange = e => { location.hash = `self-pay/${e.target.value}`; };

    // ---- 明細視窗：可切換「全部／各收款方式／未收」，列印印的就是當下這份 ----
    const FILTERS = [{ key: 'all', label: '全部' }, { key: 'paid', label: '已收' }]
      .concat(d.methods.map(m => ({ key: 'method:' + m, label: m })))
      .concat([{ key: 'unpaid', label: '未收' }]);

    const pick = (cid, f) => {
      const src = cid === 'all' ? d.rows : d.rows.filter(r => String(r.counselor_id) === String(cid));
      const rows = src.flatMap(r => r.details.map(x => ({ ...x, counselor_name: r.counselor_name })));
      if (f === 'all') return rows;
      if (f === 'paid') return rows.filter(x => x.status !== 'unpaid');
      if (f === 'unpaid') return rows.filter(x => x.status === 'unpaid');
      if (f.startsWith('method:')) return rows.filter(x => x.status !== 'unpaid' && x.method === f.slice(7));
      if (f.startsWith('plan:')) return rows.filter(x => x.status !== 'unpaid' && (x.plan_name || '未指定方案') === f.slice(5));
      return rows;
    };
    const filterLabel = f => (FILTERS.find(x => x.key === f) || {}).label
      || (f.startsWith('plan:') ? f.slice(5) : '全部');

    const detailBody = (cid, f) => {
      const rows = pick(cid, f);
      const who = cid === 'all' ? '全所' : (d.rows.find(r => String(r.counselor_id) === String(cid)) || {}).counselor_name;
      const sum = k => rows.reduce((a, b) => a + (b[k] || 0), 0);
      const paid = rows.filter(x => x.status !== 'unpaid');
      return `<div style="text-align:center;font-size:17px;font-weight:700;margin-bottom:8px">
          ${UI.esc(d.center_name || '')}　自費收款結算表</div>
        <div style="font-size:14px;margin-bottom:8px">
          心理師：${UI.esc(who || '')}　結算月份：${month}　範圍：${UI.esc(filterLabel(f))}（${rows.length} 筆）</div>
        ${UI.table((cid === 'all' ? ['日期', '心理師'] : ['日期']).concat(['個案', '方案', '收款方式', '收款', '退費', '實收', '報酬', '應繳回']),
    rows.map(x => `<tr>
          <td>${x.date}</td>
          ${cid === 'all' ? `<td>${UI.esc(x.counselor_name || '')}</td>` : ''}
          <td>${UI.esc(x.client_name || '')}</td>
          <td>${UI.esc(x.plan_name || x.item || '')}${x.topic_name ? `<span style="color:var(--muted)">／${UI.esc(x.topic_name)}</span>` : ''}</td>
          <td>${x.status === 'unpaid' ? '<span style="color:var(--danger)">未收款</span>' : UI.esc(x.method || '未填')}</td>
          <td style="text-align:right">${UI.fmtMoney(x.amount)}</td>
          <td style="text-align:right">${x.refunded ? '-' + UI.fmtMoney(x.refunded) : '—'}</td>
          <td style="text-align:right">${x.status === 'unpaid' ? '—' : UI.fmtMoney(x.net)}</td>
          <td style="text-align:right">${x.status === 'unpaid' ? '—' : UI.fmtMoney(x.share)}${x.no_appointment ? '<span style="font-size:12px;color:var(--muted)">　無對應晤談</span>' : ''}</td>
          <td style="text-align:right">${x.status === 'unpaid' ? '—' : UI.fmtMoney(x.due_back)}</td></tr>`), '這個範圍沒有資料')}
        <div style="margin-top:10px;font-size:15px;text-align:right">
          ${paid.length} 筆已收　實收合計 ${UI.fmtMoney(sum('net'))}　報酬合計 ${UI.fmtMoney(sum('share'))}　
          應繳回所方 <strong>${UI.fmtMoney(sum('due_back'))}</strong>
          ${rows.length - paid.length ? `<div style="font-size:13px;color:var(--danger)">
            另有未收 ${rows.length - paid.length} 筆 ${UI.fmtMoney(rows.filter(x => x.status === 'unpaid').reduce((a, b) => a + b.amount, 0))}</div>` : ''}</div>
        ${f === 'unpaid' ? '' : `<div style="margin-top:22px;font-size:14px">
          繳回金額：＿＿＿＿＿＿＿　繳回日期：＿＿＿＿＿＿＿　心理師簽章：＿＿＿＿＿＿＿　會計簽收：＿＿＿＿＿＿＿</div>`}`;
    };

    const openDetail = (cid, f) => {
      const who = cid === 'all' ? '全所' : (d.rows.find(r => String(r.counselor_id) === String(cid)) || {}).counselor_name;
      UI.modal({
        title: `${who || ''}　${month} 自費明細`, wide: true, hideFooter: true,
        body: `<div class="toolbar" id="fbar" style="margin-bottom:8px">
            ${FILTERS.map(x => `<button class="btn tiny ${x.key === f ? '' : 'secondary'}" data-fk="${x.key}">
              ${UI.esc(x.label)}（${pick(cid, x.key).length}）</button>`).join('')}</div>
          <div id="printable">${detailBody(cid, f)}</div>
          <button class="btn small secondary" style="margin-top:14px" onclick="window.print()">列印</button>`,
        onOpen: elm => {
          elm.querySelectorAll('[data-fk]').forEach(b => {
            b.onclick = () => {
              elm.querySelector('#printable').innerHTML = detailBody(cid, b.dataset.fk);
              elm.querySelectorAll('[data-fk]').forEach(x => {
                x.className = 'btn tiny' + (x.dataset.fk === b.dataset.fk ? '' : ' secondary');
              });
            };
          });
        }
      });
    };

    el.querySelectorAll('[data-open]').forEach(b => {
      b.onclick = e => { e.preventDefault(); openDetail(b.dataset.open, b.dataset.f); };
    });
  }
});

// ---- 方案服務量 ----
// 同一份資料換方向看：一個方案底下各心理師各做了幾次、多少錢。
App.page('plan-income', {
  title: '方案服務量',
  sub: '依方案別列出各心理師的服務次數與金額',
  help: [
    '以方案為主軸，看每個方案底下各心理師各做了幾次、收了多少、報酬多少、所方淨收多少。',
    '公部門方案的結案報表、自費方案的帶案量比較都從這裡看。',
    '只計已完成與未到的晤談；未到依所內規則按比例計費。',
  ],
  module: 'reports',
  async render(el) {
    const month = (location.hash.split('/')[1]) || UI.thisMonth();
    const d = await GET(`/plan-income/by-plan?month=${month}`);
    const kind = { self: '自費', subsidy: '補助方案', partner: '合作單位' };
    el.innerHTML = `<div class="toolbar">
        <input type="month" id="m" value="${month}">
        <div class="spacer"></div>
        <button class="btn secondary small" onclick="window.print()">列印</button></div>
      ${d.rows.map(p => `<div class="card"><h3>${UI.esc(p.plan_name)}
          ${p.plan_kind ? UI.tag(kind[p.plan_kind] || p.plan_kind, p.plan_kind === 'self' ? 'ok' : '') : ''}
          <span style="font-size:13px;font-weight:400;color:var(--muted)">
            ${p.sessions} 場｜${p.clients} 人｜服務總額 ${UI.fmtMoney(p.gross)}</span></h3>
        ${UI.table(['心理師', '完成場次', '未到', '服務人數', '服務總額', '個案自付', '方案給付', '心理師報酬', '所方淨收'],
    p.counselors.map(c => `<tr>
          <td>${UI.esc(c.counselor_name)}</td>
          <td><strong>${c.sessions}</strong></td><td>${c.no_shows || '—'}</td><td>${c.clients}</td>
          <td style="text-align:right">${UI.fmtMoney(c.gross)}</td>
          <td style="text-align:right">${UI.fmtMoney(c.self_pay)}</td>
          <td style="text-align:right">${UI.fmtMoney(c.subsidy)}</td>
          <td style="text-align:right">${UI.fmtMoney(c.share)}</td>
          <td style="text-align:right">${UI.fmtMoney(c.center)}</td></tr>`).concat(
      p.counselors.length > 1 ? [`<tr style="font-weight:700"><td>方案合計</td>
          <td>${p.sessions}</td><td>${p.no_shows || '—'}</td><td>${p.clients}</td>
          <td style="text-align:right">${UI.fmtMoney(p.gross)}</td>
          <td style="text-align:right">${UI.fmtMoney(p.self_pay)}</td>
          <td style="text-align:right">${UI.fmtMoney(p.subsidy)}</td>
          <td style="text-align:right">${UI.fmtMoney(p.share)}</td>
          <td style="text-align:right">${UI.fmtMoney(p.center)}</td></tr>`] : []))}
      </div>`).join('') || '<div class="empty">本月尚無已完成的晤談</div>'}`;
    el.querySelector('#m').onchange = e => { location.hash = `plan-income/${e.target.value}`; };
  }
});
