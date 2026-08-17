const express = require('express');
const { db, audit, today, nowStamp, addDays, listSetting, getSetting } = require('../db');
const { requireStaff, requireNoteAccess, canViewClientNotes } = require('../auth');

const router = express.Router();

// 轉介紀錄與結案後追蹤
//
// 轉介：諮商所天天在做（轉精神科、轉社福、轉他所），但最常沒留痕。
// 這裡記「轉給誰、為什麼、對方接了沒」，出事時才說得清楚已盡轉介義務。
// 追蹤：結案不等於服務結束，實務上會在結案後一段時間關懷一次。
// 結案時依設定自動建立追蹤點，逾期未追蹤會列在清單頂端。
//
// 兩者都涉及個案處遇脈絡，保密層級比照晤談紀錄。

function guardClient(req, res, next) {
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(Number(req.params.id) || 0);
  if (!c) return res.status(404).json({ error: '找不到此個案' });
  if (!canViewClientNotes(req.user, c)) {
    return res.status(403).json({ error: '轉介與追蹤紀錄僅限主責心理師、督導與管理者存取' });
  }
  req.theClient = c;
  next();
}

// ---- 轉介 ----
router.get('/clients/:id/referrals', requireStaff('notes'), guardClient, (req, res) => {
  res.json({
    rows: db.prepare(`SELECT r.*, u.name AS counselor_name FROM referrals r
      LEFT JOIN users u ON u.id = r.counselor_id
      WHERE r.client_id = ? ORDER BY r.date DESC, r.id DESC`).all(req.theClient.id),
    targets: listSetting('referral_targets')
  });
});

router.post('/clients/:id/referrals', requireStaff('notes'), guardClient, (req, res) => {
  const b = req.body || {};
  if (!String(b.target || '').trim()) return res.status(400).json({ error: '請填寫轉介對象' });
  if (!String(b.reason || '').trim()) return res.status(400).json({ error: '請填寫轉介原因' });
  const info = db.prepare(`INSERT INTO referrals
    (client_id, counselor_id, date, direction, target, contact, reason, note, status)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    req.theClient.id, req.user.id, b.date || today(),
    b.direction === 'in' ? 'in' : 'out', String(b.target).trim(), b.contact || '',
    String(b.reason).trim(), b.note || '', b.status || 'sent');
  audit('staff', req.user.id, req.user.name, '新增轉介紀錄', req.theClient.code, { target: b.target });
  res.json({ id: info.lastInsertRowid });
});

router.put('/referrals/:id', requireStaff('notes'), (req, res) => {
  const r = db.prepare('SELECT * FROM referrals WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此轉介紀錄' });
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(r.client_id);
  if (!canViewClientNotes(req.user, c)) return res.status(403).json({ error: '無權限修改此紀錄' });
  const b = { ...r, ...req.body };
  // 狀態一改成「已接案／未接案」就記下回覆時間，省得再填一次
  const replied = ['accepted', 'declined'].includes(b.status) && !r.replied_at ? nowStamp() : (b.replied_at || r.replied_at);
  db.prepare(`UPDATE referrals SET date = ?, direction = ?, target = ?, contact = ?, reason = ?, note = ?,
      status = ?, replied_at = ?, reply_note = ? WHERE id = ?`).run(
    b.date, b.direction === 'in' ? 'in' : 'out', b.target, b.contact || '', b.reason, b.note || '',
    b.status, replied, b.reply_note || '', r.id);
  audit('staff', req.user.id, req.user.name, '修改轉介紀錄', String(r.client_id), { id: r.id, status: b.status });
  res.json({ ok: true });
});

router.delete('/referrals/:id', requireStaff('notes'), (req, res) => {
  const r = db.prepare('SELECT * FROM referrals WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此轉介紀錄' });
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(r.client_id);
  if (!canViewClientNotes(req.user, c)) return res.status(403).json({ error: '無權限刪除此紀錄' });
  db.prepare('DELETE FROM referrals WHERE id = ?').run(r.id);
  audit('staff', req.user.id, req.user.name, '刪除轉介紀錄', String(r.client_id), { id: r.id });
  res.json({ ok: true });
});

// ---- 結案後追蹤 ----
router.get('/clients/:id/follow-ups', requireStaff('notes'), guardClient, (req, res) => {
  res.json({
    rows: db.prepare(`SELECT f.*, u.name AS done_by_name FROM follow_ups f
      LEFT JOIN users u ON u.id = f.done_by
      WHERE f.client_id = ? ORDER BY f.due_date`).all(req.theClient.id),
    channels: listSetting('follow_up_channels')
  });
});

router.post('/clients/:id/follow-ups', requireStaff('notes'), guardClient, (req, res) => {
  const b = req.body || {};
  if (!b.due_date) return res.status(400).json({ error: '請填寫預定追蹤日' });
  const info = db.prepare(`INSERT INTO follow_ups (client_id, counselor_id, due_date, kind, note)
    VALUES (?,?,?,?,?)`).run(
    req.theClient.id, req.theClient.counselor_id || req.user.id, b.due_date,
    b.kind || '結案追蹤', b.note || '');
  audit('staff', req.user.id, req.user.name, '新增結案追蹤', req.theClient.code, { due: b.due_date });
  res.json({ id: info.lastInsertRowid });
});

router.put('/follow-ups/:id', requireStaff('notes'), (req, res) => {
  const f = db.prepare('SELECT * FROM follow_ups WHERE id = ?').get(req.params.id);
  if (!f) return res.status(404).json({ error: '找不到此追蹤紀錄' });
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(f.client_id);
  if (!canViewClientNotes(req.user, c)) return res.status(403).json({ error: '無權限修改此紀錄' });
  const b = { ...f, ...req.body };
  const status = ['pending', 'done', 'skipped'].includes(b.status) ? b.status : f.status;
  if (status === 'done' && !String(b.result || '').trim()) {
    return res.status(400).json({ error: '完成追蹤請填寫追蹤結果' });
  }
  const doneAt = status === 'done' ? (f.done_at || nowStamp()) : '';
  db.prepare(`UPDATE follow_ups SET due_date = ?, kind = ?, status = ?, channel = ?, result = ?,
      note = ?, done_at = ?, done_by = ? WHERE id = ?`).run(
    b.due_date, b.kind, status, b.channel || '', b.result || '', b.note || '',
    doneAt, status === 'done' ? req.user.id : null, f.id);
  audit('staff', req.user.id, req.user.name, '更新結案追蹤', String(f.client_id), { id: f.id, status });
  res.json({ ok: true });
});

router.delete('/follow-ups/:id', requireStaff('notes'), (req, res) => {
  const f = db.prepare('SELECT * FROM follow_ups WHERE id = ?').get(req.params.id);
  if (!f) return res.status(404).json({ error: '找不到此追蹤紀錄' });
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(f.client_id);
  if (!canViewClientNotes(req.user, c)) return res.status(403).json({ error: '無權限刪除此紀錄' });
  db.prepare('DELETE FROM follow_ups WHERE id = ?').run(f.id);
  res.json({ ok: true });
});

// 待追蹤清單：心理師看自己的個案，督導與管理者看全所。
// 逐案端點以 canViewClientNotes 把關，這裡改用 notes 模組，
// 才不會出現「行政看得到清單卻按不動完成追蹤」的落差。
router.get('/follow-ups', requireStaff('notes'), (req, res) => {
  const mine = req.user.role === 'counselor' ? 'AND c.counselor_id = ' + req.user.id : '';
  const rows = db.prepare(`SELECT f.*, c.name AS client_name, c.code AS client_code, c.status AS client_status,
      c.phone AS client_phone, c.close_date, u.name AS counselor_name,
      CAST(julianday('now','localtime') - julianday(f.due_date) AS INTEGER) AS days_late
    FROM follow_ups f JOIN clients c ON c.id = f.client_id
    LEFT JOIN users u ON u.id = c.counselor_id
    WHERE f.status = 'pending' ${mine}
    ORDER BY f.due_date`).all();
  // 只列已到期或即將到期（7 天內）的，避免清單被未來的追蹤點洗版
  res.json({
    rows: rows.filter(r => r.days_late >= -7),
    overdue: rows.filter(r => r.days_late > 0).length,
    upcoming: rows.filter(r => r.days_late <= 0 && r.days_late >= -7).length
  });
});

// 結案時依系統設定自動建立追蹤點（clients.js 結案流程呼叫）
function createCloseFollowUps(client, userId) {
  const days = String(getSetting('follow_up_days', ''))
    .split(',').map(n => Number(String(n).trim())).filter(n => n > 0);
  if (!days.length) return 0;
  const base = client.close_date || today();
  const ins = db.prepare(`INSERT INTO follow_ups (client_id, counselor_id, due_date, kind, note)
    VALUES (?,?,?,'結案追蹤',?)`);
  let n = 0;
  for (const d of days) {
    const due = addDays(base, d);
    // 已有同一天的結案追蹤就不重複建立（重複結案／改期結案日時會遇到）
    const dup = db.prepare("SELECT 1 FROM follow_ups WHERE client_id = ? AND due_date = ? AND kind = '結案追蹤'")
      .get(client.id, due);
    if (dup) continue;
    ins.run(client.id, client.counselor_id || userId || null, due, `結案後 ${d} 天關懷追蹤`);
    n++;
  }
  return n;
}

module.exports = router;
module.exports.createCloseFollowUps = createCloseFollowUps;
