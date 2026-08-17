// LINE 官方帳號：綁定、Webhook、以及各種 Flex 推播的觸發點。
//
// 綁定流程刻意不讓櫃檯手抄 userId：
//   後台為個案／心理師產生 6 碼驗證碼 → 對方在官方帳號輸入 → Webhook 收到後完成綁定。
// 驗證碼有效期預設 1 天，用過即失效。

const express = require('express');
const crypto = require('crypto');
const { db, audit, today, addDays, getSetting, nowStamp } = require('../db');
const { requireStaff } = require('../auth');
const line = require('../line');

const router = express.Router();

// ---- Webhook（LINE 平台呼叫，免登入，靠簽章驗證）----
router.post('/line/webhook', express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }), async (req, res) => {
  const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  if (!line.verifySignature(raw, req.headers['x-line-signature'])) {
    // 簽章不符就當作不是 LINE 送來的，直接忽略（仍回 200，避免對方持續重送）
    return res.status(200).end();
  }
  const events = (req.body && req.body.events) || [];
  for (const ev of events) {
    try { await handleEvent(ev); } catch (e) { console.error('LINE webhook 處理失敗：', e.message); }
  }
  res.json({ ok: true });
});

function bindingWelcome(name) {
  return line.card({
    title: '綁定完成',
    subtitle: getSetting('center_name'),
    altText: '綁定完成',
    body: [
      { type: 'text', size: 'sm', wrap: true, color: '#3b4a55',
        text: `${name} 您好，之後預約成立與晤談提醒都會透過這裡通知您。` },
      line.noteBox('本帳號僅提供預約與行政通知，不處理晤談內容；如遇立即危機請撥 1925 或 119。')
    ]
  });
}

function helpFlex() {
  const url = getSetting('booking_public_url', '');
  return line.card({
    title: getSetting('center_name'),
    subtitle: '線上預約與提醒',
    altText: '預約說明',
    body: [
      { type: 'text', size: 'sm', wrap: true, color: '#3b4a55',
        text: '輸入諮商所提供的 6 碼綁定碼即可接收預約與晤談提醒。' },
      line.noteBox(`預約請點下方按鈕或來電 ${getSetting('center_phone')}`)
    ],
    footer: url ? [line.actionButton('線上預約', { type: 'uri', label: '線上預約', uri: url })] : []
  });
}

async function handleEvent(ev) {
  const lineUserId = ev.source && ev.source.userId;
  if (!lineUserId) return;

  if (ev.type === 'message' && ev.message && ev.message.type === 'text') {
    const text = String(ev.message.text || '').trim();
    const code = (text.match(/\d{6}/) || [])[0];
    if (code) {
      const bind = db.prepare("SELECT * FROM line_bindings WHERE code = ? AND status = 'pending'").get(code);
      if (bind && (!bind.expires_at || bind.expires_at >= today())) {
        const name = bind.client_id
          ? (db.prepare('SELECT name FROM clients WHERE id = ?').get(bind.client_id) || {}).name
          : (db.prepare('SELECT name FROM users WHERE id = ?').get(bind.user_id) || {}).name;
        if (bind.client_id) db.prepare('UPDATE clients SET line_user_id = ? WHERE id = ?').run(lineUserId, bind.client_id);
        if (bind.user_id) db.prepare('UPDATE users SET line_user_id = ? WHERE id = ?').run(lineUserId, bind.user_id);
        db.prepare("UPDATE line_bindings SET status = 'done', line_user_id = ?, bound_at = ? WHERE id = ?")
          .run(lineUserId, nowStamp(), bind.id);
        audit('system', null, 'LINE', '完成 LINE 綁定', String(bind.client_id || bind.user_id || ''));
        await line.replyMessages(ev.replyToken, [bindingWelcome(name || '您')]);
        return;
      }
      await line.replyMessages(ev.replyToken, [line.textMessage('綁定碼不正確或已失效，請向諮商所索取新的綁定碼。')]);
      return;
    }
    await line.replyMessages(ev.replyToken, [helpFlex()]);
    return;
  }

  if (ev.type === 'follow') {
    await line.replyMessages(ev.replyToken, [helpFlex()]);
  }
}

// ---- 後台：綁定管理 ----

router.post('/line/bind-code', requireStaff(), (req, res) => {
  const b = req.body || {};
  const clientId = Number(b.client_id) || null;
  const userId = Number(b.user_id) || null;
  if (!clientId && !userId) return res.status(400).json({ error: '請指定個案或心理師' });
  // 心理師只能替自己產生綁定碼，除非有帳號管理權限
  if (userId && userId !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: '只能為自己產生綁定碼' });
  }
  const code = String(crypto.randomInt(100000, 999999));
  db.prepare(`INSERT INTO line_bindings (code, client_id, user_id, expires_at) VALUES (?,?,?,?)`)
    .run(code, clientId, userId, addDays(today(), 1));
  audit('staff', req.user.id, req.user.name, '產生 LINE 綁定碼', String(clientId || userId));
  res.json({ code, expires_at: addDays(today(), 1), add_friend_url: getSetting('line_add_friend_url') });
});

router.delete('/line/binding', requireStaff(), (req, res) => {
  const clientId = Number(req.query.client_id) || 0;
  const userId = Number(req.query.user_id) || 0;
  if (userId && userId !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: '只能解除自己的綁定' });
  }
  if (clientId) db.prepare("UPDATE clients SET line_user_id = '' WHERE id = ?").run(clientId);
  if (userId) db.prepare("UPDATE users SET line_user_id = '' WHERE id = ?").run(userId);
  audit('staff', req.user.id, req.user.name, '解除 LINE 綁定', String(clientId || userId));
  res.json({ ok: true });
});

router.get('/line/status', requireStaff(), (req, res) => {
  res.json({
    enabled: line.lineEnabled(),
    official_name: getSetting('line_official_name'),
    add_friend_url: getSetting('line_add_friend_url'),
    reminder_hours: Number(getSetting('line_reminder_hours', '24')),
    daily_enabled: getSetting('line_counselor_daily_enabled', '1') === '1',
    daily_time: getSetting('line_counselor_daily_time', '20:00'),
    me_bound: !!req.user.line_user_id,
    clients_bound: db.prepare("SELECT COUNT(*) n FROM clients WHERE line_user_id != '' AND active = 1").get().n,
    clients_total: db.prepare('SELECT COUNT(*) n FROM clients WHERE active = 1').get().n,
    staff_bound: db.prepare("SELECT COUNT(*) n FROM users WHERE line_user_id != '' AND active = 1").get().n,
    recent: db.prepare(`SELECT n.*, c.name AS client_name FROM notifications n
      LEFT JOIN clients c ON c.id = n.client_id
      WHERE n.channel IN ('line','manual') ORDER BY n.id DESC LIMIT 50`).all()
  });
});

// ---- 推播：晤談提醒（個案）----

function apptForFlex(id) {
  return db.prepare(`SELECT a.*, c.name AS client_name, c.code AS client_code, c.line_user_id,
      c.risk_level, u.name AS counselor_name, p.name AS plan_name, t.name AS topic_name
    FROM appointments a
    JOIN clients c ON c.id = a.client_id
    LEFT JOIN users u ON u.id = a.counselor_id
    LEFT JOIN service_plans p ON p.id = a.plan_id
    LEFT JOIN plan_topics t ON t.id = a.topic_id
    WHERE a.id = ?`).get(id);
}

router.post('/line/remind/:id', requireStaff('schedule'), async (req, res) => {
  const a = apptForFlex(req.params.id);
  if (!a) return res.status(404).json({ error: '找不到此預約' });
  const out = await line.pushFlex({
    to: a.line_user_id, flex: line.reminderFlex(a), kind: 'reminder',
    client_id: a.client_id, appointment_id: a.id, user: req.user
  });
  if (out.status === 'sent') db.prepare('UPDATE appointments SET reminded_at = ? WHERE id = ?').run(nowStamp(), a.id);
  res.json(out);
});

// 整批推播某日的晤談提醒（預設明日）
router.post('/line/remind-batch', requireStaff('schedule'), async (req, res) => {
  const date = String((req.body || {}).date || addDays(today(), 1));
  const rows = db.prepare(`SELECT a.id FROM appointments a WHERE a.date = ? AND a.status = 'booked'`).all(date);
  const results = [];
  for (const r of rows) {
    const a = apptForFlex(r.id);
    const out = await line.pushFlex({
      to: a.line_user_id, flex: line.reminderFlex(a), kind: 'reminder',
      client_id: a.client_id, appointment_id: a.id, user: req.user
    });
    if (out.status === 'sent') db.prepare('UPDATE appointments SET reminded_at = ? WHERE id = ?').run(nowStamp(), a.id);
    results.push({ id: a.id, client_name: a.client_name, ...out });
  }
  audit('staff', req.user.id, req.user.name, 'LINE 批次晤談提醒', date, { count: results.length });
  res.json({ date, count: results.length,
    sent: results.filter(r => r.status === 'sent').length, results });
});

// ---- 推播：心理師行程 ----

function counselorSchedule(counselorId, date) {
  return db.prepare(`SELECT a.start_time, a.end_time, a.mode, c.name AS client_name, c.code AS client_code,
      c.risk_level, p.name AS plan_name
    FROM appointments a JOIN clients c ON c.id = a.client_id
    LEFT JOIN service_plans p ON p.id = a.plan_id
    WHERE a.counselor_id = ? AND a.date = ? AND a.status IN ('booked','arrived')
    ORDER BY a.start_time`).all(counselorId, date);
}

async function pushCounselorDay(counselor, date, title) {
  const rows = counselorSchedule(counselor.id, date);
  return line.pushFlex({
    to: counselor.line_user_id, kind: 'staff_schedule',
    flex: line.counselorScheduleFlex({ counselor_name: counselor.name, date, rows, title }),
    summary: `${title}：${date} 共 ${rows.length} 場`
  });
}

router.post('/line/counselor-schedule', requireStaff('schedule'), async (req, res) => {
  const b = req.body || {};
  const date = String(b.date || addDays(today(), 1));
  const targets = b.counselor_id
    ? db.prepare('SELECT id, name, line_user_id FROM users WHERE id = ?').all(Number(b.counselor_id))
    : db.prepare(`SELECT id, name, line_user_id FROM users WHERE active = 1
        AND role IN ('counselor','supervisor','admin') AND line_user_id != ''`).all();
  const results = [];
  for (const u of targets) {
    const rows = counselorSchedule(u.id, date);
    if (!rows.length && !b.include_empty) continue;
    results.push({ counselor: u.name, ...(await pushCounselorDay(u, date, b.title || '晤談行程')) });
  }
  audit('staff', req.user.id, req.user.name, 'LINE 推播心理師行程', date, { count: results.length });
  res.json({ date, results });
});

// 心理師自己測試：確認綁定與卡片樣式
router.post('/line/test', requireStaff(), async (req, res) => {
  if (!req.user.line_user_id) return res.status(400).json({ error: '您尚未綁定 LINE 官方帳號' });
  const out = await pushCounselorDay(req.user, String((req.body || {}).date || addDays(today(), 1)), '晤談行程（測試）');
  res.json(out);
});

// ---- 排程：每日自動推播 ----
// server.js 每 10 分鐘呼叫一次；到了設定時間且當天尚未推過就送出。
let lastDailyRun = '';
async function runDailyPush() {
  if (getSetting('line_counselor_daily_enabled', '1') !== '1' || !line.lineEnabled()) return;
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const at = getSetting('line_counselor_daily_time', '20:00');
  const day = today();
  if (lastDailyRun === day || hhmm < at) return;
  lastDailyRun = day;
  const date = addDays(day, 1);
  const staff = db.prepare(`SELECT id, name, line_user_id FROM users
    WHERE active = 1 AND role IN ('counselor','supervisor','admin') AND line_user_id != ''`).all();
  for (const u of staff) {
    const rows = counselorSchedule(u.id, date);
    if (!rows.length) continue;
    try { await pushCounselorDay(u, date, '明日晤談行程'); } catch (e) { console.error('LINE 行程推播失敗：', e.message); }
  }
  // 個案的晤談提醒：依設定的提前時數，推明天有晤談且尚未提醒過的個案
  const hours = Number(getSetting('line_reminder_hours', '24'));
  if (hours >= 12) {
    const appts = db.prepare(`SELECT id FROM appointments WHERE date = ? AND status = 'booked' AND reminded_at = ''`).all(date);
    for (const r of appts) {
      const a = apptForFlex(r.id);
      if (!a || !a.line_user_id) continue;
      try {
        const out = await line.pushFlex({ to: a.line_user_id, flex: line.reminderFlex(a), kind: 'reminder',
          client_id: a.client_id, appointment_id: a.id });
        if (out.status === 'sent') db.prepare('UPDATE appointments SET reminded_at = ? WHERE id = ?').run(nowStamp(), a.id);
      } catch (e) { console.error('LINE 晤談提醒失敗：', e.message); }
    }
  }
}

module.exports = router;
module.exports.runDailyPush = runDailyPush;
