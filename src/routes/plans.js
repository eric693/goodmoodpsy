// 方案別設定（方案 × 主題 × 心理師）、額度管理，以及每位心理師每月的收支結算。

const express = require('express');
const { db, audit, today, getSetting, nowStamp } = require('../db');
const { requireStaff } = require('../auth');
const {
  resolveFee, clientUsage, clientUsageAll, counselorLoad, nextWeekHint, checkBooking, parseOptions, noShowCharge
} = require('../plans');

const router = express.Router();

const PLAN_FIELDS = ['name', 'kind', 'appt_type', 'fee_mode', 'fee', 'fee_options', 'subsidy_amount',
  'subsidy_program', 'session_minutes', 'age_min', 'age_max', 'quota_per_year',
  'counselor_week_limit', 'counselor_month_limit', 'share_mode', 'share_percent', 'share_fixed',
  'portal_visible', 'require_review', 'note', 'intro', 'sort', 'active', 'default_mode', 'venue_fee'];

function normalizePlan(b, base = {}) {
  const d = { ...base };
  for (const f of PLAN_FIELDS) if (b[f] !== undefined) d[f] = b[f];
  d.name = String(d.name || '').trim();
  d.kind = ['self', 'subsidy', 'partner'].includes(d.kind) ? d.kind : 'self';
  d.fee_mode = d.fee_mode === 'choice' ? 'choice' : 'fixed';
  d.share_mode = d.share_mode === 'fixed' ? 'fixed' : 'percent';
  // 抽成比例允許填 60 或 0.6 兩種寫法，一律收斂成 0~1
  let pct = Number(d.share_percent) || 0;
  if (pct > 1) pct = pct / 100;
  d.share_percent = Math.min(Math.max(pct, 0), 1);
  d.fee_options = parseOptions(d.fee_options).join(',');
  for (const n of ['fee', 'subsidy_amount', 'venue_fee', 'session_minutes', 'age_min', 'age_max', 'quota_per_year',
    'counselor_week_limit', 'counselor_month_limit', 'share_fixed', 'sort']) {
    d[n] = Math.max(0, Math.round(Number(d[n]) || 0));
  }
  for (const n of ['portal_visible', 'require_review', 'active']) d[n] = d[n] ? 1 : 0;
  for (const s of ['subsidy_program', 'note', 'intro']) d[s] = String(d[s] || '');
  d.appt_type = String(d.appt_type || 'individual');
  d.default_mode = d.default_mode === 'online' ? 'online' : 'onsite';
  return d;
}

// ---- 方案 ----

router.get('/service-plans', requireStaff(), (req, res) => {
  const plans = db.prepare('SELECT * FROM service_plans ORDER BY active DESC, sort, id').all();
  const topics = db.prepare('SELECT * FROM plan_topics ORDER BY sort, id').all();
  const rates = db.prepare(`SELECT pc.*, u.name AS counselor_name FROM plan_counselors pc
    JOIN users u ON u.id = pc.counselor_id ORDER BY pc.plan_id, u.name`).all();
  const ym = today().slice(0, 7);
  const used = db.prepare(`SELECT plan_id, COUNT(*) n FROM appointments
    WHERE substr(date,1,7) = ? AND status IN ('booked','arrived','done','no_show') GROUP BY plan_id`).all(ym);
  const usedMap = Object.fromEntries(used.map(r => [r.plan_id, r.n]));
  res.json(plans.map(p => ({
    ...p,
    fee_option_list: parseOptions(p.fee_options),
    topics: topics.filter(t => t.plan_id === p.id),
    rates: rates.filter(r => r.plan_id === p.id),
    month_sessions: usedMap[p.id] || 0
  })));
});

router.post('/service-plans', requireStaff('settings'), (req, res) => {
  const d = normalizePlan(req.body || {}, { active: 1, portal_visible: 1, require_review: 1, share_percent: 0.6 });
  if (!d.name) return res.status(400).json({ error: '請填寫方案名稱' });
  const cols = PLAN_FIELDS.join(', ');
  const info = db.prepare(`INSERT INTO service_plans (${cols}) VALUES (${PLAN_FIELDS.map(() => '?').join(',')})`)
    .run(...PLAN_FIELDS.map(f => d[f]));
  audit('staff', req.user.id, req.user.name, '新增方案', d.name);
  res.json({ id: info.lastInsertRowid });
});

router.put('/service-plans/:id', requireStaff('settings'), (req, res) => {
  const p = db.prepare('SELECT * FROM service_plans WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '找不到此方案' });
  const d = normalizePlan(req.body || {}, p);
  if (!d.name) return res.status(400).json({ error: '請填寫方案名稱' });
  db.prepare(`UPDATE service_plans SET ${PLAN_FIELDS.map(f => `${f} = ?`).join(', ')} WHERE id = ?`)
    .run(...PLAN_FIELDS.map(f => d[f]), p.id);
  audit('staff', req.user.id, req.user.name, '修改方案', d.name);
  res.json({ ok: true });
});

// 已被預約引用過的方案不刪除只停用，否則歷史帳目會失去方案別
router.delete('/service-plans/:id', requireStaff('settings'), (req, res) => {
  const p = db.prepare('SELECT * FROM service_plans WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '找不到此方案' });
  const used = db.prepare('SELECT COUNT(*) n FROM appointments WHERE plan_id = ?').get(p.id).n;
  if (used) {
    db.prepare('UPDATE service_plans SET active = 0 WHERE id = ?').run(p.id);
    audit('staff', req.user.id, req.user.name, '停用方案', p.name, { used });
    return res.json({ ok: true, disabled: true, message: `此方案已有 ${used} 筆預約使用，已改為停用（保留歷史紀錄）` });
  }
  db.prepare('DELETE FROM service_plans WHERE id = ?').run(p.id);
  audit('staff', req.user.id, req.user.name, '刪除方案', p.name);
  res.json({ ok: true });
});

// ---- 主題 ----

router.post('/service-plans/:id/topics', requireStaff('settings'), (req, res) => {
  const p = db.prepare('SELECT * FROM service_plans WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '找不到此方案' });
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: '請填寫主題名稱' });
  const info = db.prepare(`INSERT INTO plan_topics (plan_id, name, fee, fee_options, note, sort, active)
    VALUES (?,?,?,?,?,?,1)`).run(p.id, name, Math.max(0, Number(b.fee) || 0),
    parseOptions(b.fee_options).join(','), String(b.note || ''), Number(b.sort) || 0);
  audit('staff', req.user.id, req.user.name, '新增方案主題', `${p.name}／${name}`);
  res.json({ id: info.lastInsertRowid });
});

router.put('/topics/:id', requireStaff('settings'), (req, res) => {
  const t = db.prepare('SELECT * FROM plan_topics WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: '找不到此主題' });
  const b = { ...t, ...req.body };
  db.prepare('UPDATE plan_topics SET name = ?, fee = ?, fee_options = ?, note = ?, sort = ?, active = ? WHERE id = ?')
    .run(String(b.name || t.name).trim(), Math.max(0, Number(b.fee) || 0),
      parseOptions(b.fee_options).join(','), String(b.note || ''), Number(b.sort) || 0, b.active ? 1 : 0, t.id);
  audit('staff', req.user.id, req.user.name, '修改方案主題', String(b.name || t.name));
  res.json({ ok: true });
});

router.delete('/topics/:id', requireStaff('settings'), (req, res) => {
  const t = db.prepare('SELECT * FROM plan_topics WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: '找不到此主題' });
  const used = db.prepare('SELECT COUNT(*) n FROM appointments WHERE topic_id = ?').get(t.id).n;
  if (used) {
    db.prepare('UPDATE plan_topics SET active = 0 WHERE id = ?').run(t.id);
    return res.json({ ok: true, disabled: true, message: `此主題已有 ${used} 筆預約使用，已改為停用` });
  }
  db.prepare('DELETE FROM plan_topics WHERE id = ?').run(t.id);
  audit('staff', req.user.id, req.user.name, '刪除方案主題', t.name);
  res.json({ ok: true });
});

// ---- 心理師費率（方案 × 心理師 [× 主題]）----

router.post('/service-plans/:id/rates', requireStaff('settings'), (req, res) => {
  const p = db.prepare('SELECT * FROM service_plans WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '找不到此方案' });
  const b = req.body || {};
  const counselorId = Number(b.counselor_id) || 0;
  if (!counselorId) return res.status(400).json({ error: '請選擇心理師' });
  const topicId = Number(b.topic_id) || null;
  const exists = db.prepare(`SELECT id FROM plan_counselors WHERE plan_id = ? AND counselor_id = ?
    AND ((topic_id IS NULL AND ? IS NULL) OR topic_id = ?)`).get(p.id, counselorId, topicId, topicId);
  if (exists) return res.status(400).json({ error: '此心理師在該方案（主題）已設定費率，請直接編輯' });
  let pct = Number(b.share_percent) || 0;
  if (pct > 1) pct = pct / 100;
  const info = db.prepare(`INSERT INTO plan_counselors
    (plan_id, counselor_id, topic_id, fee, share_mode, share_percent, share_fixed, week_limit, month_limit, bookable, active)
    VALUES (?,?,?,?,?,?,?,?,?,?,1)`).run(p.id, counselorId, topicId,
    Math.max(0, Number(b.fee) || 0), b.share_mode === 'fixed' || b.share_mode === 'percent' ? b.share_mode : '',
    Math.min(Math.max(pct, 0), 1), Math.max(0, Number(b.share_fixed) || 0),
    b.week_limit === '' || b.week_limit === undefined ? -1 : Number(b.week_limit),
    b.month_limit === '' || b.month_limit === undefined ? -1 : Number(b.month_limit),
    b.bookable === false ? 0 : 1);
  audit('staff', req.user.id, req.user.name, '設定心理師方案費率', p.name, { counselorId });
  res.json({ id: info.lastInsertRowid });
});

router.put('/rates/:id', requireStaff('settings'), (req, res) => {
  const r = db.prepare('SELECT * FROM plan_counselors WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此費率設定' });
  const b = { ...r, ...req.body };
  let pct = Number(b.share_percent) || 0;
  if (pct > 1) pct = pct / 100;
  db.prepare(`UPDATE plan_counselors SET fee = ?, share_mode = ?, share_percent = ?, share_fixed = ?,
      week_limit = ?, month_limit = ?, bookable = ?, active = ? WHERE id = ?`).run(
    Math.max(0, Number(b.fee) || 0),
    b.share_mode === 'fixed' || b.share_mode === 'percent' ? b.share_mode : '',
    Math.min(Math.max(pct, 0), 1), Math.max(0, Number(b.share_fixed) || 0),
    b.week_limit === '' ? -1 : Number(b.week_limit), b.month_limit === '' ? -1 : Number(b.month_limit),
    b.bookable ? 1 : 0, b.active ? 1 : 0, r.id);
  audit('staff', req.user.id, req.user.name, '修改心理師方案費率', String(r.id));
  res.json({ ok: true });
});

router.delete('/rates/:id', requireStaff('settings'), (req, res) => {
  db.prepare('DELETE FROM plan_counselors WHERE id = ?').run(req.params.id);
  audit('staff', req.user.id, req.user.name, '刪除心理師方案費率', String(req.params.id));
  res.json({ ok: true });
});

// ---- 取價試算與額度查詢（預約表單即時顯示）----

router.get('/plan-quote', requireStaff(), (req, res) => {
  const q = req.query;
  const quote = resolveFee({
    plan_id: q.plan_id, topic_id: q.topic_id, counselor_id: q.counselor_id,
    fee_choice: q.fee_choice, fee_override: q.fee_override
  });
  const client = q.client_id ? db.prepare('SELECT * FROM clients WHERE id = ?').get(Number(q.client_id)) : null;
  const check = q.plan_id
    ? checkBooking({ plan_id: q.plan_id, client, counselor_id: q.counselor_id,
      date: q.date || today(), appointment_id: q.appointment_id })
    : { errors: [], warnings: [] };
  res.json({
    fee: quote.fee,                       // 個案要付的錢（畫面上的「費用」欄位）
    total: quote.total,                   // 方案總額
    client_pay: quote.client_pay,
    venue_fee: quote.venue_fee,           // 場地費（所方收入，不列入抽成）
    share_base: quote.share_base,
    fee_options: quote.fee_options, subsidy_amount: quote.subsidy_amount,
    self_pay: quote.self_pay, counselor_share: quote.counselor_share,
    session_minutes: quote.session_minutes, subsidy_program: quote.subsidy_program,
    plan_name: quote.plan ? quote.plan.name : '', topic_name: quote.topic ? quote.topic.name : '',
    ...check
  });
});

// 某位心理師某方案的人次負載（本週／本月／下週）
router.get('/plan-load', requireStaff(), (req, res) => {
  const { counselor_id, plan_id, date = today() } = req.query;
  if (!counselor_id || !plan_id) return res.status(400).json({ error: '請指定心理師與方案' });
  res.json({
    ...counselorLoad(Number(counselor_id), Number(plan_id), date),
    next_week: nextWeekHint(Number(counselor_id), Number(plan_id), date)
  });
});

// 方案人次看板：每位心理師在各限量方案的本週／本月用量，一眼看出誰還能排
router.get('/plan-board', requireStaff('schedule'), (req, res) => {
  const date = req.query.date || today();
  const plans = db.prepare(`SELECT * FROM service_plans WHERE active = 1
    AND (counselor_week_limit > 0 OR counselor_month_limit > 0 OR quota_per_year > 0) ORDER BY sort, id`).all();
  const counselors = db.prepare("SELECT id, name FROM users WHERE active = 1 AND role IN ('counselor','supervisor','admin') ORDER BY name").all();
  const rows = [];
  for (const p of plans) {
    for (const c of counselors) {
      const load = counselorLoad(c.id, p.id, date);
      if (!load.week_limit && !load.month_limit && !load.week_used && !load.month_used) continue;
      // 帶出這位心理師是否另有個別上限，看板上才分得出「沿用方案」與「個別調整」
      const ov = db.prepare(`SELECT week_limit, month_limit FROM plan_counselors
        WHERE plan_id = ? AND counselor_id = ? AND topic_id IS NULL`).get(p.id, c.id) || {};
      rows.push({
        plan_id: p.id, plan_name: p.name, counselor_id: c.id, counselor_name: c.name,
        plan_week_limit: p.counselor_week_limit, plan_month_limit: p.counselor_month_limit,
        override_week: ov.week_limit === undefined ? -1 : ov.week_limit,
        override_month: ov.month_limit === undefined ? -1 : ov.month_limit,
        ...load, next_week: load.week_full ? nextWeekHint(c.id, p.id, date) : null
      });
    }
  }
  res.json({ date, rows });
});

// 已用人次可以人工填成實際數字（他所已接的案、系統外排的場次）。
// 存的是差額，之後系統內新增預約仍會照常累加。
router.put('/plan-board/usage', requireStaff('schedule'), (req, res) => {
  const b = req.body || {};
  const planId = Number(b.plan_id) || 0;
  const counselorId = Number(b.counselor_id) || 0;
  const date = b.date || today();
  if (!planId || !counselorId) return res.status(400).json({ error: '請指定方案與心理師' });
  const canEditOthers = req.user.role === 'admin' || req.userModules.includes('settings');
  if (!canEditOthers && counselorId !== req.user.id) {
    return res.status(403).json({ error: '只能調整自己的已用人次' });
  }
  const load = counselorLoad(counselorId, planId, date);
  const save = (type, key, systemUsed, wanted) => {
    if (wanted === undefined || wanted === null || wanted === '') return;
    const offset = Math.max(0, Math.floor(Number(wanted) || 0)) - systemUsed;
    db.prepare(`INSERT INTO plan_counselor_usage_adj (plan_id, counselor_id, period_type, period_key, used_offset, note, updated_at)
      VALUES (?,?,?,?,?,?,datetime('now','localtime'))
      ON CONFLICT (plan_id, counselor_id, period_type, period_key)
      DO UPDATE SET used_offset = excluded.used_offset, note = excluded.note, updated_at = excluded.updated_at`)
      .run(planId, counselorId, type, key, offset, String(b.note || ''));
  };
  save('week', load.week_start, load.week_system_used, b.week_used);
  save('month', load.month, load.month_system_used, b.month_used);
  audit('staff', req.user.id, req.user.name, '調整方案已用人次', String(planId),
    { counselorId, week_used: b.week_used, month_used: b.month_used });
  res.json({ ok: true, ...counselorLoad(counselorId, planId, date) });
});

// 直接在人次看板調整某位心理師在某方案的上限，不必繞到方案設定頁改費率。
// -1 沿用方案設定、0 不限、>0 個別上限。
// 心理師可以調整「自己」的上限（自己接多少自己最清楚）；要改別人的則需 settings 權限。
router.put('/plan-board/limit', requireStaff('schedule'), (req, res) => {
  const b = req.body || {};
  const planId = Number(b.plan_id) || 0;
  const counselorId = Number(b.counselor_id) || 0;
  if (!planId || !counselorId) return res.status(400).json({ error: '請指定方案與心理師' });
  const canEditOthers = req.user.role === 'admin' || req.userModules.includes('settings');
  if (!canEditOthers && counselorId !== req.user.id) {
    return res.status(403).json({ error: '只能調整自己的人次上限' });
  }
  const plan = db.prepare('SELECT name FROM service_plans WHERE id = ?').get(planId);
  if (!plan) return res.status(404).json({ error: '找不到此方案' });
  const norm = v => {
    if (v === '' || v === null || v === undefined) return -1;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : -1;
  };
  const week = norm(b.week_limit);
  const month = norm(b.month_limit);
  const row = db.prepare(`SELECT id FROM plan_counselors
    WHERE plan_id = ? AND counselor_id = ? AND topic_id IS NULL`).get(planId, counselorId);
  if (row) {
    db.prepare('UPDATE plan_counselors SET week_limit = ?, month_limit = ?, active = 1 WHERE id = ?')
      .run(week, month, row.id);
  } else {
    db.prepare(`INSERT INTO plan_counselors (plan_id, counselor_id, topic_id, week_limit, month_limit)
      VALUES (?,?,NULL,?,?)`).run(planId, counselorId, week, month);
  }
  audit('staff', req.user.id, req.user.name, '調整方案人次上限', plan.name,
    { counselorId, week_limit: week, month_limit: month });
  res.json({ ok: true, week_limit: week, month_limit: month });
});

// ---- 個案的方案使用次數（標記用了幾次青壯年方案）----

router.get('/clients/:id/plan-usage', requireStaff('clients'), (req, res) => {
  const year = req.query.year || String(new Date().getFullYear());
  const rows = clientUsageAll(req.params.id, year);
  const history = db.prepare(`SELECT a.date, a.start_time, a.status, a.fee, p.name AS plan_name,
      t.name AS topic_name, u.name AS counselor_name
    FROM appointments a
    LEFT JOIN service_plans p ON p.id = a.plan_id
    LEFT JOIN plan_topics t ON t.id = a.topic_id
    LEFT JOIN users u ON u.id = a.counselor_id
    WHERE a.client_id = ? AND a.plan_id IS NOT NULL AND substr(a.date,1,4) = ?
    ORDER BY a.date DESC`).all(Number(req.params.id), year);
  res.json({ year, rows, history });
});

// 人工調整已用次數（例如個案在其他諮商所已使用過的次數）
router.put('/clients/:id/plan-usage', requireStaff('clients'), (req, res) => {
  const b = req.body || {};
  const planId = Number(b.plan_id) || 0;
  const year = String(b.year || new Date().getFullYear());
  if (!planId) return res.status(400).json({ error: '請指定方案' });
  const offset = Math.max(0, Number(b.used_offset) || 0);
  db.prepare(`INSERT INTO plan_usage_adjustments (client_id, plan_id, year, used_offset, note, updated_by, updated_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(client_id, plan_id, year) DO UPDATE SET
      used_offset = excluded.used_offset, note = excluded.note,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .run(Number(req.params.id), planId, year, offset, String(b.note || ''), req.user.id, nowStamp());
  audit('staff', req.user.id, req.user.name, '調整方案已用次數', String(req.params.id), { planId, year, offset });
  res.json({ ok: true, usage: clientUsage(req.params.id, planId, year) });
});

// ---- 每位心理師每月收支 ----
//
// 收入面以「已完成的晤談」為準（未到只收部分費用，故另計）；
// 心理師報酬取當時鎖定的 counselor_share，沒有的（舊資料或無方案）才即時試算。
// 實收金額另外由收費單的收款狀態算，讓所方看得出「該收多少」與「實際收到多少」的差。
router.get('/plan-income', requireStaff('reports'), (req, res) => {
  const month = String(req.query.month || today().slice(0, 7));
  const counselorFilter = Number(req.query.counselor_id) || 0;
  const appts = db.prepare(`SELECT a.*, u.name AS counselor_name, p.name AS plan_name, p.kind AS plan_kind,
      t.name AS topic_name, c.name AS client_name, c.code AS client_code
    FROM appointments a
    JOIN users u ON u.id = a.counselor_id
    LEFT JOIN service_plans p ON p.id = a.plan_id
    LEFT JOIN plan_topics t ON t.id = a.topic_id
    LEFT JOIN clients c ON c.id = a.client_id
    WHERE substr(a.date,1,7) = ? AND a.status IN ('done','no_show')
      ${counselorFilter ? 'AND a.counselor_id = ?' : ''}
    ORDER BY a.date, a.start_time`).all(...(counselorFilter ? [month, counselorFilter] : [month]));

  // 收費單以月份彙整，用來對照實收
  const invoices = db.prepare(`SELECT i.*, a.counselor_id,
      (SELECT COALESCE(SUM(amount),0) FROM refunds rf WHERE rf.invoice_id = i.id) AS refunded
    FROM invoices i LEFT JOIN appointments a ON a.id = i.appointment_id
    WHERE substr(i.date,1,7) = ? AND i.status != 'void'`).all(month);

  const byCounselor = new Map();
  const ensure = (id, name) => {
    if (!byCounselor.has(id)) {
      byCounselor.set(id, {
        counselor_id: id, counselor_name: name, sessions: 0, no_shows: 0,
        gross: 0, subsidy: 0, self_pay: 0, venue: 0, share: 0, center: 0,
        collected: 0, uncollected: 0, plans: new Map()
      });
    }
    return byCounselor.get(id);
  };

  for (const a of appts) {
    const row = ensure(a.counselor_id, a.counselor_name);
    const q = resolveFee({ plan_id: a.plan_id, topic_id: a.topic_id, counselor_id: a.counselor_id, fee_override: a.fee });
    // 未到只收部分費用：固定規費時換算成等效比例，各項才會一致縮放
    const rate = a.status === 'no_show' ? noShowCharge(a.fee).rate : 1;
    // 未到只收部分費用：個案自付與方案給付都按同一比例計，心理師報酬亦然
    const clientPay = Math.round((a.fee || 0) * rate);
    const subsidy = Math.round((a.subsidy_amount || 0) * rate);
    const gross = clientPay + subsidy;
    const venue = Math.round((q.venue_fee || 0) * rate);
    const share = Math.round((a.counselor_share || q.counselor_share) * rate);

    if (a.status === 'no_show') row.no_shows++; else row.sessions++;
    row.gross += gross; row.subsidy += subsidy; row.self_pay += clientPay;
    row.venue += venue; row.share += share; row.center += gross - share;

    const key = a.plan_id || 0;
    if (!row.plans.has(key)) {
      row.plans.set(key, {
        plan_id: a.plan_id, plan_name: a.plan_name || '未指定方案', plan_kind: a.plan_kind || '',
        sessions: 0, gross: 0, subsidy: 0, self_pay: 0, venue: 0, share: 0, center: 0
      });
    }
    const pr = row.plans.get(key);
    pr.sessions++; pr.gross += gross; pr.subsidy += subsidy; pr.self_pay += clientPay;
    pr.venue += venue; pr.share += share; pr.center += gross - share;
  }

  for (const inv of invoices) {
    if (!inv.counselor_id) continue;
    if (counselorFilter && inv.counselor_id !== counselorFilter) continue;
    const row = byCounselor.get(inv.counselor_id);
    if (!row) continue;
    if (inv.status === 'paid') row.collected += inv.amount - (inv.refunded || 0);
    else if (inv.status === 'unpaid') row.uncollected += inv.amount;
  }

  const payouts = db.prepare(`SELECT p.*, u.name AS counselor_name FROM payouts p
    JOIN users u ON u.id = p.user_id WHERE p.month = ?`).all(month);

  const rows = [...byCounselor.values()].map(r => ({
    ...r,
    plans: [...r.plans.values()].sort((a, b) => b.gross - a.gross),
    payout_recorded: payouts.filter(p => p.user_id === r.counselor_id).reduce((a, b) => a + b.gross, 0),
    payout_status: payouts.some(p => p.user_id === r.counselor_id && p.status === 'paid') ? 'paid'
      : payouts.some(p => p.user_id === r.counselor_id) ? 'pending' : 'none'
  })).sort((a, b) => b.gross - a.gross);

  const total = rows.reduce((acc, r) => ({
    sessions: acc.sessions + r.sessions, no_shows: acc.no_shows + r.no_shows,
    gross: acc.gross + r.gross, subsidy: acc.subsidy + r.subsidy, self_pay: acc.self_pay + r.self_pay,
    venue: acc.venue + r.venue, share: acc.share + r.share, center: acc.center + r.center,
    collected: acc.collected + r.collected, uncollected: acc.uncollected + r.uncollected
  }), { sessions: 0, no_shows: 0, gross: 0, subsidy: 0, self_pay: 0, venue: 0, share: 0, center: 0,
    collected: 0, uncollected: 0 });

  res.json({ month, rows, total });
});

// 單一心理師的當月明細（可列印給心理師對帳）
router.get('/plan-income/:counselorId/detail', requireStaff('reports'), (req, res) => {
  const month = String(req.query.month || today().slice(0, 7));
  const cid = Number(req.params.counselorId);
  const u = db.prepare('SELECT id, name, title FROM users WHERE id = ?').get(cid);
  if (!u) return res.status(404).json({ error: '找不到此心理師' });
  const rows = db.prepare(`SELECT a.date, a.start_time, a.end_time, a.status, a.fee, a.subsidy_amount, a.counselor_share,
      c.code AS client_code, c.name AS client_name, p.name AS plan_name, t.name AS topic_name,
      (SELECT i.status FROM invoices i WHERE i.appointment_id = a.id AND i.status != 'void' LIMIT 1) AS invoice_status
    FROM appointments a
    LEFT JOIN clients c ON c.id = a.client_id
    LEFT JOIN service_plans p ON p.id = a.plan_id
    LEFT JOIN plan_topics t ON t.id = a.topic_id
    WHERE a.counselor_id = ? AND substr(a.date,1,7) = ? AND a.status IN ('done','no_show')
    ORDER BY a.date, a.start_time`).all(cid, month);
  const detail = rows.map(r => {
    const share = r.counselor_share || resolveFee({ fee_override: r.fee }).counselor_share;
    return { ...r, counselor_share: r.status === 'no_show'
      ? Math.round(share * noShowCharge(r.fee).rate) : share };
  });
  res.json({
    month, counselor: u, rows: detail,
    total_gross: detail.reduce((a, b) => a + (b.fee || 0) + (b.subsidy_amount || 0), 0),
    total_share: detail.reduce((a, b) => a + (b.counselor_share || 0), 0),
    center_name: getSetting('center_name')
  });
});

module.exports = router;
