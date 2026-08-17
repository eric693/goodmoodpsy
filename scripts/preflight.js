// 上線前健檢：把「資料有沒有同步、設定有沒有漏、有沒有前後不一致的帳」一次列出來。
//   node scripts/preflight.js
const { db, getSetting, listSetting } = require('../src/db');
const { resolveFee } = require('../src/plans');

const problems = [], warns = [], info = [];
const check = (cond, msg, level = 'problem') => {
  if (cond) return;
  (level === 'warn' ? warns : problems).push(msg);
};

// ---- 機構與對外設定 ----
check(getSetting('center_name'), '未設定機構名稱');
check(getSetting('center_phone'), '未設定機構電話（收據、LINE 卡片與提醒都會用到）');
check(getSetting('center_address'), '未設定機構地址');
check(getSetting('center_license_no'), '未填開業執照字號（收據抬頭會缺這行）', 'warn');
check(getSetting('center_director'), '未填負責心理師（收據落款會缺）', 'warn');
check(getSetting('booking_public_url'), '未設定線上預約表單網址（LINE 卡片的預約按鈕會不見）');
check(getSetting('line_channel_token'), 'LINE 尚未串接：所有推播只會記為「待人工發送」', 'warn');
check(getSetting('line_channel_secret'), 'LINE Channel secret 未填，Webhook 無法驗證簽章', 'warn');
check(getSetting('google_form_secret'), 'Google 表單同步尚未產生密鑰', 'warn');

// ---- 方案 ----
const plans = db.prepare('SELECT * FROM service_plans WHERE active = 1').all();
check(plans.length > 0, '沒有任何啟用中的方案，預約表單會是空的');
for (const p of plans) {
  const q = resolveFee({ plan_id: p.id });
  check(q.total > 0, `方案「${p.name}」金額為 0`);
  check(q.subsidy_amount <= q.total, `方案「${p.name}」的方案給付大於總額`);
  check(q.venue_fee <= q.total, `方案「${p.name}」的場地費大於總額`);
  check(p.kind !== 'subsidy' || q.client_pay === q.venue_fee || q.venue_fee === 0,
    `方案「${p.name}」：個案自付 ${q.client_pay} 與場地費 ${q.venue_fee} 不一致，請確認`, 'warn');
  check(db.prepare('SELECT COUNT(*) n FROM plan_topics WHERE plan_id = ? AND active = 1').get(p.id).n > 0,
    `方案「${p.name}」沒有任何主題`, 'warn');
  info.push(`方案 ${p.name}：總額 ${q.total}／個案付 ${q.client_pay}／方案給付 ${q.subsidy_amount}`
    + `／場地費 ${q.venue_fee}／心理師 ${q.counselor_share}／所方 ${q.total - q.counselor_share}`);
}

// ---- 心理師與排班 ----
const counselors = db.prepare(`SELECT * FROM users WHERE active = 1 AND portal_bookable = 1
  AND role IN ('counselor','supervisor','admin')`).all();
check(counselors.length > 0, '沒有任何開放線上預約的心理師');
for (const u of counselors) {
  const slots = db.prepare('SELECT COUNT(*) n FROM availability WHERE counselor_id = ?').get(u.id).n;
  check(slots > 0, `${u.name} 尚未設定可預約時段（線上表單不會出現他的時段）`, 'warn');
}

// ---- 金額一致性 ----
const bad = db.prepare(`SELECT a.id, a.date, a.fee, a.subsidy_amount, p.name AS plan_name, p.subsidy_amount AS plan_subsidy
  FROM appointments a JOIN service_plans p ON p.id = a.plan_id
  WHERE p.subsidy_amount > 0 AND a.subsidy_amount = 0 AND a.fee > p.venue_fee`).all();
check(bad.length === 0,
  `有 ${bad.length} 筆補助方案預約仍是舊的金額寫法，請執行 node scripts/migrate-fee-semantics.js --apply`);

const mismatched = db.prepare(`SELECT i.id, i.amount, a.fee FROM invoices i
  JOIN appointments a ON a.id = i.appointment_id
  WHERE i.status = 'unpaid' AND a.status = 'done' AND i.amount != a.fee`).all();
check(mismatched.length === 0, `有 ${mismatched.length} 張未收款收費單的金額與預約不符（收費單 ID：`
  + mismatched.map(m => m.id).join(',') + '）', 'warn');

// ---- 孤兒資料 ----
const orphanAppt = db.prepare(`SELECT COUNT(*) n FROM appointments a
  LEFT JOIN clients c ON c.id = a.client_id WHERE c.id IS NULL`).get().n;
check(orphanAppt === 0, `有 ${orphanAppt} 筆預約找不到對應個案`);
const orphanInv = db.prepare(`SELECT COUNT(*) n FROM invoices i
  LEFT JOIN clients c ON c.id = i.client_id WHERE c.id IS NULL`).get().n;
check(orphanInv === 0, `有 ${orphanInv} 張收費單找不到對應個案`);
const dupReceipt = db.prepare(`SELECT receipt_no, COUNT(*) n FROM receipts GROUP BY receipt_no HAVING n > 1`).all();
check(dupReceipt.length === 0, `收據編號重複：${dupReceipt.map(r => r.receipt_no).join(',')}`);

// ---- 備份 ----
const fs = require('fs');
const path = require('path');
const backupDir = path.join(__dirname, '..', 'data', 'backups');
const backups = fs.existsSync(backupDir)
  ? fs.readdirSync(backupDir).filter(f => /^mindcare-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort() : [];
check(backups.length > 0, '尚無任何每日備份檔');
info.push(`備份檔 ${backups.length} 份，最新：${backups[backups.length - 1] || '無'}`);

// ---- 展示資料 ----
const demoUsers = db.prepare("SELECT name FROM users WHERE username IN ('lin','chen','wu','office') AND active = 1").all();
const demoClients = db.prepare("SELECT COUNT(*) n FROM clients WHERE code LIKE 'C%'").get().n;
if (demoUsers.length || demoClients) {
  warns.push(`資料庫仍有展示資料：示範帳號 ${demoUsers.map(u => u.name).join('、') || '無'}`
    + `、示範個案 ${demoClients} 筆。正式上線前可執行 node scripts/purge-demo.js --apply 清除`);
}

info.push(`統計：個案 ${db.prepare('SELECT COUNT(*) n FROM clients').get().n} 位、`
  + `預約 ${db.prepare('SELECT COUNT(*) n FROM appointments').get().n} 筆、`
  + `收費單 ${db.prepare('SELECT COUNT(*) n FROM invoices').get().n} 張、`
  + `收據 ${db.prepare('SELECT COUNT(*) n FROM receipts').get().n} 張、`
  + `線上申請 ${db.prepare('SELECT COUNT(*) n FROM booking_requests').get().n} 筆`);
info.push(`隱藏模組：${listSetting('hidden_modules').join('、') || '無'}`);

console.log('── 資訊');
info.forEach(i => console.log('  · ' + i));
if (warns.length) { console.log('\n── 提醒（不影響上線）'); warns.forEach(w => console.log('  ! ' + w)); }
if (problems.length) { console.log('\n── 必須處理'); problems.forEach(p => console.log('  ✗ ' + p)); }
else console.log('\n✓ 沒有阻擋上線的問題');
process.exit(problems.length ? 1 : 0);
