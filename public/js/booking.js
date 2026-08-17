// 線上預約表單（公開頁，免登入）。
// 個案只看得到：方案 → 主題 → 心理師 → 可預約時段 → 基本資料。
// 諮商室配置全程不出現；時段本身已排除被占用與請假的時間，並依方案人次上限過濾。

const BK = {
  cfg: null,
  sel: { plan: null, topic: null, counselor: null, date: '', time: '', fee: 0 },

  async boot() {
    try {
      BK.cfg = await fetch('/api/public/booking-config').then(r => r.json());
    } catch {
      document.getElementById('app').innerHTML = '<div class="bk-card">目前無法載入預約表單，請稍後再試或直接來電預約。</div>';
      return;
    }
    // 從 LINE 進來時網址會帶 userId，用於預約結果直接推播回 LINE
    BK.lineUserId = new URLSearchParams(location.search).get('line_user_id') || '';
    if (!BK.cfg.enabled) {
      document.getElementById('app').innerHTML = `<div class="bk-card">
        <h2>線上預約暫停開放</h2>
        <div class="bk-note">請直接來電預約：${UI.esc(BK.cfg.center_phone || '')}</div></div>`;
      return;
    }
    BK.render();
  },

  render() {
    const c = BK.cfg;
    document.getElementById('app').innerHTML = `
      <div class="bk-head">
        <h1>${UI.esc(c.center_name)}</h1>
        <div class="sub">線上預約表單${c.center_phone ? `　電話 <a href="tel:${UI.esc(c.center_phone)}">${UI.esc(c.center_phone)}</a>` : ''}
          ${c.center_address ? `<br>${UI.esc(c.center_address)}` : ''}</div>
      </div>

      <div class="bk-card">
        <h2><span class="step">1</span>選擇方案</h2>
        <div class="opt-list" id="plans">${c.plans.map(p => `
          <div class="opt" data-plan="${p.id}">
            <div class="t">${UI.esc(p.name)}　${p.fee_mode === 'choice'
    ? UI.esc(p.fee_options.map(f => 'NT$' + f).join(' / '))
    : 'NT$' + p.fee}</div>
            <div class="d">${UI.esc(p.intro || '')}
              ${p.session_minutes ? `｜${p.session_minutes} 分鐘` : ''}
              ${p.age_min || p.age_max ? `｜限 ${p.age_min || 0}-${p.age_max || '不限'} 歲` : ''}
              ${p.quota_per_year ? `｜每人每年 ${p.quota_per_year} 次` : ''}
              ${p.subsidy_amount ? `｜方案給付 NT$${p.subsidy_amount}，自付 NT$${p.self_pay}` : ''}</div>
          </div>`).join('')}</div>
      </div>

      <div class="bk-card" id="topic-card" style="display:none">
        <h2><span class="step">2</span>想談的主題</h2>
        <div class="chip-row" id="topics"></div>
        <div class="bk-field" id="fee-choice" style="display:none;margin-top:12px">
          <label>方案金額</label><div class="chip-row" id="fees"></div>
        </div>
      </div>

      <div class="bk-card" id="counselor-card" style="display:none">
        <h2><span class="step">3</span>選擇心理師</h2>
        <div class="opt-list" id="counselors"></div>
      </div>

      <div class="bk-card" id="slot-card" style="display:none">
        <h2><span class="step">4</span>選擇時段</h2>
        <div id="slots">載入中…</div>
        <div class="bk-field" style="margin-top:10px">
          <label>其他可配合的時段（選填）</label>
          <input id="alt_note" placeholder="例：平日晚上、週六上午皆可">
        </div>
      </div>

      <div class="bk-card" id="info-card" style="display:none">
        <h2><span class="step">5</span>基本資料</h2>
        <div class="bk-field"><label>姓名 *</label><input id="name" autocomplete="name"></div>
        <div class="bk-field"><label>手機 *</label><input id="phone" inputmode="numeric" placeholder="09xxxxxxxx" autocomplete="tel">
          <div class="hint">預約結果與提醒會以電話或 LINE 通知您。</div></div>
        <div class="bk-field"><label>出生日期 ${BK.cfg.require_birth ? '*' : ''}</label><input id="birth_date" type="date">
          <div class="hint">用於核對方案資格（如補助方案的年齡限制）。</div></div>
        <div class="bk-field"><label>性別</label>
          <select id="gender"><option value="">不方便透露</option><option value="female">女</option>
            <option value="male">男</option><option value="other">其他</option></select></div>
        <div class="bk-field"><label>Email（選填）</label><input id="email" type="email" autocomplete="email"></div>
        <div class="bk-field" id="partner-row" style="display:none"><label>同行者姓名與關係</label>
          <input id="partner_name" placeholder="例：王小明（配偶）"></div>
        <div class="bk-field"><label>想談的困擾（選填）</label>
          <textarea id="main_issue" rows="3" placeholder="簡單描述即可，晤談時再詳談"></textarea></div>
        <div class="bk-field"><label>對諮商的期待（選填）</label>
          <textarea id="expectation" rows="2"></textarea></div>
        <div class="bk-field">
          <label style="display:flex;gap:8px;align-items:flex-start;font-weight:400;font-size:13.5px">
            <input type="checkbox" id="consent" style="width:auto;margin-top:3px">
            <span>我已閱讀並同意個人資料蒐集告知事項</span></label>
          <div class="hint">${UI.esc(c.privacy || '')}</div>
        </div>
        <div class="bk-note">${UI.esc(c.notice || '')}</div>
        <div class="bk-err" id="err"></div>
        <button class="btn bk-submit" id="submit">送出預約申請</button>
      </div>

      <div class="bk-card">
        <div class="bk-note">${UI.esc(c.crisis_note || '')}</div>
      </div>`;

    document.querySelectorAll('[data-plan]').forEach(elm => {
      elm.onclick = () => BK.pickPlan(Number(elm.dataset.plan));
    });
  },

  pickPlan(id) {
    const p = BK.cfg.plans.find(x => x.id === id);
    BK.sel = { plan: p, topic: null, counselor: null, date: '', time: '', fee: p.fee };
    document.querySelectorAll('[data-plan]').forEach(e => e.classList.toggle('on', Number(e.dataset.plan) === id));

    document.getElementById('topic-card').style.display = '';
    document.getElementById('topics').innerHTML = p.topics.length
      ? p.topics.map(t => `<button class="chip" data-topic="${t.id}">${UI.esc(t.name)}</button>`).join('')
      : '<span class="bk-note">此方案不需選擇主題</span>';
    document.querySelectorAll('[data-topic]').forEach(b => {
      b.onclick = () => {
        BK.sel.topic = Number(b.dataset.topic);
        document.querySelectorAll('[data-topic]').forEach(x => x.classList.toggle('on', x === b));
      };
    });

    // 伴侶／家庭諮商這類方案由個案自己挑金額
    const feeBox = document.getElementById('fee-choice');
    if (p.fee_mode === 'choice' && p.fee_options.length) {
      feeBox.style.display = '';
      document.getElementById('fees').innerHTML = p.fee_options
        .map(f => `<button class="chip${f === p.fee ? ' on' : ''}" data-fee="${f}">NT$ ${f}</button>`).join('');
      document.querySelectorAll('[data-fee]').forEach(b => {
        b.onclick = () => {
          BK.sel.fee = Number(b.dataset.fee);
          document.querySelectorAll('[data-fee]').forEach(x => x.classList.toggle('on', x === b));
        };
      });
    } else {
      feeBox.style.display = 'none';
    }

    document.getElementById('partner-row').style.display =
      ['couple', 'family'].includes(p.appt_type) ? '' : 'none';

    document.getElementById('counselor-card').style.display = '';
    document.getElementById('counselors').innerHTML = p.counselors.length
      ? p.counselors.map(u => `<div class="opt" data-cid="${u.id}">
          <div class="t">${UI.esc(u.name)} ${UI.esc(u.title || '')}</div>
          ${u.specialty ? `<div class="d">${UI.esc(u.specialty)}</div>` : ''}</div>`).join('')
      : '<span class="bk-note">此方案目前無可預約的心理師，請來電洽詢。</span>';
    document.querySelectorAll('[data-cid]').forEach(b => {
      b.onclick = () => {
        BK.sel.counselor = Number(b.dataset.cid);
        document.querySelectorAll('[data-cid]').forEach(x => x.classList.toggle('on', x === b));
        BK.loadSlots();
      };
    });
    document.getElementById('slot-card').style.display = 'none';
    document.getElementById('info-card').style.display = 'none';
    document.getElementById('counselor-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  },

  async loadSlots() {
    const card = document.getElementById('slot-card');
    const box = document.getElementById('slots');
    card.style.display = '';
    box.innerHTML = '載入中…';
    const q = new URLSearchParams({ counselor_id: BK.sel.counselor, plan_id: BK.sel.plan.id, days: 21 });
    const data = await fetch('/api/public/booking-slots?' + q).then(r => r.json()).catch(() => null);
    if (!data || !data.days) { box.innerHTML = '<span class="bk-note">目前無法取得時段，請來電預約。</span>'; return; }
    const days = data.days.filter(d => d.slots.length || d.full);
    if (!days.length) {
      box.innerHTML = '<span class="bk-note">近期沒有開放的時段，請來電或填寫下方「其他可配合時段」，我們會再與您聯繫。</span>';
    } else {
      box.innerHTML = days.map(d => `<div class="day-block">
        <div class="d-label">${d.date}（${['日', '一', '二', '三', '四', '五', '六'][new Date(d.date + 'T00:00:00').getDay()]}）</div>
        ${d.slots.length
    ? `<div class="chip-row">${d.slots.map(s => `<button class="chip" data-d="${d.date}" data-t="${s.start_time}">${s.start_time}</button>`).join('')}</div>`
    : `<div class="full">${UI.esc(d.full ? d.full.reason : '無開放時段')}${d.full && d.full.next_week
      ? `，下週（${d.full.next_week.week_start} 起）尚可預約` : ''}</div>`}
      </div>`).join('');
      box.querySelectorAll('[data-t]').forEach(b => {
        b.onclick = () => {
          BK.sel.date = b.dataset.d;
          BK.sel.time = b.dataset.t;
          box.querySelectorAll('[data-t]').forEach(x => x.classList.toggle('on', x === b));
          document.getElementById('info-card').style.display = '';
          document.getElementById('info-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
        };
      });
    }
    // 沒有可選時段時仍讓人送出申請（填可配合時段），由櫃檯協調
    document.getElementById('info-card').style.display = '';
    document.getElementById('submit').onclick = BK.submit;
  },

  async submit() {
    const err = document.getElementById('err');
    const btn = document.getElementById('submit');
    const val = id => (document.getElementById(id).value || '').trim();
    err.textContent = '';
    btn.disabled = true;
    try {
      const body = {
        name: val('name'), phone: val('phone'), email: val('email'),
        gender: val('gender'), birth_date: val('birth_date'),
        plan_id: BK.sel.plan && BK.sel.plan.id, topic_id: BK.sel.topic,
        counselor_id: BK.sel.counselor, date: BK.sel.date, start_time: BK.sel.time,
        alt_note: val('alt_note'), fee_choice: BK.sel.fee,
        partner_name: val('partner_name'), main_issue: val('main_issue'),
        expectation: val('expectation'),
        consent: document.getElementById('consent').checked,
        line_user_id: BK.lineUserId, source: BK.lineUserId ? 'line' : 'web'
      };
      const r = await fetch('/api/public/bookings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      }).then(async res => {
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || '送出失敗，請稍後再試');
        return d;
      });
      BK.done(r);
    } catch (e) {
      err.textContent = e.message;
      btn.disabled = false;
    }
  },

  done(r) {
    const c = BK.cfg;
    document.getElementById('app').innerHTML = `<div class="bk-card done-box">
      <div class="ok">✓</div>
      <h2 style="justify-content:center">已收到您的預約申請</h2>
      <div class="bk-note" style="text-align:left;margin-top:10px">
        ${UI.esc(r.message)}
        ${BK.sel.date ? `\n\n希望時段：${BK.sel.date} ${BK.sel.time}` : ''}
        ${BK.sel.plan ? `\n方案：${BK.sel.plan.name}（NT$ ${r.fee}${r.self_pay !== r.fee ? `，自付 NT$ ${r.self_pay}` : ''}）` : ''}
        ${r.center_phone ? `\n\n如需修改或有疑問，請來電 ${r.center_phone}。` : ''}
      </div>
      ${r.line_add_friend_url ? `<a class="btn" style="margin-top:14px;display:inline-block"
        href="${UI.esc(r.line_add_friend_url)}" target="_blank" rel="noopener">加入 LINE 接收提醒</a>` : ''}
      <div class="bk-note" style="margin-top:16px">${UI.esc(c.crisis_note || '')}</div>
    </div>`;
  }
};

BK.boot();
