// 依好心情心理諮商所現行的 Google 預約表單，建立心理師帳號、諮商主題與 12 個諮商方案。
//   node scripts/seed-goodmood.js
//
// 可重複執行：以名稱比對，已存在者更新內容，不會產生重複資料，也不會動到既有預約。
// 補助方案的自付額一律 200 元場地費，方案給付金額 = 總額 - 200，
// 若各方案實際給付不同，於後台「方案設定」逐一調整即可。

const bcrypt = require('bcryptjs');
const { db, getSetting } = require('../src/db');

// ---- 心理師（表單「預約之心理師」）----
// 密碼一律為初始密碼，請各位心理師首次登入後自行修改。
const INIT_PASSWORD = 'goodmood2026';
const COUNSELORS = [
  { username: 'ma', name: '馬健倫', title: '所長', license_type: '諮商心理師' },
  { username: 'wang-yc', name: '王詠蕎', title: '', license_type: '諮商心理師' },
  { username: 'tsai', name: '蔡琳', title: '', license_type: '諮商心理師' },
  { username: 'wu-ty', name: '吳宗怡', title: '', license_type: '諮商心理師' },
  { username: 'wang-mc', name: '王敏慈', title: '', license_type: '諮商心理師' },
  { username: 'fang', name: '方鋮丞', title: '', license_type: '臨床心理師' },
  { username: 'lan', name: '藍挹丰', title: '', license_type: '諮商心理師', online_only: 1,
    intro: '僅接受線上通訊諮商' }
];

// ---- 諮商主題（表單「諮商主題」，各方案共用同一組）----
const TOPICS = ['自我探索', '情緒困擾', '壓力調適', '親密關係', '原生家庭/親子關係',
  '人際關係', '生涯議題', '心理疾患', '創傷與失落', '職場議題', '其他'];

// ---- 諮商方案（表單「諮商方案」）----
// subsidy 類方案：total 為方案總額，個案自付 200 元場地費，其餘由方案給付。
const SELF_PAY_FEE = 200;
const PLANS = [
  { name: '個別心理諮商（50 分鐘）', kind: 'self', appt_type: 'individual',
    fee: 2000, session_minutes: 50 },
  { name: '個別心理諮商（80 分鐘）', kind: 'self', appt_type: 'individual',
    fee: 3000, session_minutes: 80 },
  { name: '婚姻伴侶/家庭諮商（80 分鐘）', kind: 'self', appt_type: 'couple',
    fee: 3000, session_minutes: 80, fee_mode: 'choice', fee_options: '3000,3600,4500' },
  { name: '通訊（視訊）諮商（50 分鐘）', kind: 'self', appt_type: 'individual',
    fee: 2000, session_minutes: 50, default_mode: 'online' },
  { name: '親子/家長諮詢（80 分鐘）', kind: 'self', appt_type: 'family',
    fee: 3000, session_minutes: 80 },
  { name: '115 年度 15-45 歲青壯世代心理健康支持方案', kind: 'subsidy', appt_type: 'individual',
    fee: 1800, session_minutes: 50, age_min: 15, age_max: 45, quota_per_year: 3,
    counselor_week_limit: 6, subsidy_program: '青壯世代心理健康支持方案',
    intro: '一年 3 次，需自付 200 元場地費。' },
  { name: '115 年度臺南市教師支持方案', kind: 'subsidy', appt_type: 'individual',
    fee: 1800, session_minutes: 50, quota_per_year: 6, subsidy_program: '臺南市教師支持方案',
    intro: '一年 6 次，需自付 200 元場地費。' },
  { name: '115 年度國軍心理健康方案', kind: 'subsidy', appt_type: 'individual',
    fee: 1800, session_minutes: 50, quota_per_year: 6, subsidy_program: '國軍心理健康方案',
    intro: '一年 6 次，需自付 200 元場地費。' },
  { name: '臺南市政府員工協助方案', kind: 'subsidy', appt_type: 'individual',
    fee: 1800, session_minutes: 50, quota_per_year: 4, subsidy_program: '臺南市政府員工協助方案',
    intro: '一年 4 次，需自付 200 元場地費。' },
  { name: '1219 台北捷運心理健康支持方案', kind: 'subsidy', appt_type: 'individual',
    fee: 1800, session_minutes: 50, subsidy_program: '1219 台北捷運心理健康支持方案',
    intro: '需自付 200 元場地費。' },
  { name: '馬太鞍溪心理健康支持方案', kind: 'subsidy', appt_type: 'individual',
    fee: 1800, session_minutes: 50, subsidy_program: '馬太鞍溪心理健康支持方案',
    intro: '需自付 200 元場地費。' },
  { name: 'LGBTQ+ 族群個別諮商方案（40 分鐘）', kind: 'self', appt_type: 'individual',
    fee: 1200, session_minutes: 40, quota_per_year: 3,
    intro: '限使用 3 次。' }
];

const SHARE_PERCENT = 0.6;   // 心理師抽成預設值，後台可逐方案／逐心理師調整

// ---- 心理師帳號 ----
const findUser = db.prepare('SELECT * FROM users WHERE username = ? OR name = ?');
for (const c of COUNSELORS) {
  const exist = findUser.get(c.username, c.name);
  if (exist) {
    db.prepare(`UPDATE users SET name = ?, title = ?, license_type = ?, online_only = ?, intro = ?,
        role = CASE WHEN role = 'admin' THEN role ELSE 'counselor' END, active = 1 WHERE id = ?`)
      .run(c.name, c.title || '', c.license_type, c.online_only || 0, c.intro || '', exist.id);
    console.log(`更新心理師：${c.name}`);
  } else {
    db.prepare(`INSERT INTO users (username, password_hash, name, role, title, license_type, online_only, intro)
      VALUES (?,?,?,'counselor',?,?,?,?)`).run(
      c.username, bcrypt.hashSync(INIT_PASSWORD, 10), c.name, c.title || '',
      c.license_type, c.online_only || 0, c.intro || '');
    console.log(`新增心理師：${c.name}（帳號 ${c.username}，初始密碼 ${INIT_PASSWORD}）`);
  }
}

// ---- 方案與主題 ----
const PLAN_COLS = ['name', 'kind', 'appt_type', 'fee_mode', 'fee', 'fee_options', 'subsidy_amount',
  'subsidy_program', 'session_minutes', 'age_min', 'age_max', 'quota_per_year',
  'counselor_week_limit', 'counselor_month_limit', 'share_mode', 'share_percent', 'share_fixed',
  'portal_visible', 'require_review', 'note', 'intro', 'sort', 'active', 'default_mode'];

const findPlan = db.prepare('SELECT * FROM service_plans WHERE name = ?');
const insTopic = db.prepare('INSERT INTO plan_topics (plan_id, name, sort) VALUES (?,?,?)');
const hasTopic = db.prepare('SELECT id FROM plan_topics WHERE plan_id = ? AND name = ?');

PLANS.forEach((p, idx) => {
  const row = {
    name: p.name,
    kind: p.kind,
    appt_type: p.appt_type,
    fee_mode: p.fee_mode || 'fixed',
    fee: p.fee,
    fee_options: p.fee_options || '',
    // 補助方案：個案只付場地費，其餘由方案給付
    subsidy_amount: p.kind === 'subsidy' ? Math.max(0, p.fee - SELF_PAY_FEE) : 0,
    subsidy_program: p.subsidy_program || '',
    session_minutes: p.session_minutes || 0,
    age_min: p.age_min || 0,
    age_max: p.age_max || 0,
    quota_per_year: p.quota_per_year || 0,
    counselor_week_limit: p.counselor_week_limit || 0,
    counselor_month_limit: 0,
    share_mode: 'percent',
    share_percent: SHARE_PERCENT,
    share_fixed: 0,
    portal_visible: 1,
    require_review: 1,
    note: '',
    intro: p.intro || '',
    sort: idx + 1,
    active: 1,
    default_mode: p.default_mode || 'onsite'
  };
  const exist = findPlan.get(p.name);
  let planId;
  if (exist) {
    db.prepare(`UPDATE service_plans SET ${PLAN_COLS.map(c => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(...PLAN_COLS.map(c => row[c]), exist.id);
    planId = exist.id;
    console.log(`更新方案：${p.name}`);
  } else {
    planId = db.prepare(`INSERT INTO service_plans (${PLAN_COLS.join(',')})
      VALUES (${PLAN_COLS.map(() => '?').join(',')})`).run(...PLAN_COLS.map(c => row[c])).lastInsertRowid;
    console.log(`新增方案：${p.name}`);
  }
  TOPICS.forEach((t, i) => { if (!hasTopic.get(planId, t)) insTopic.run(planId, t, i + 1); });
});

// 舊的示範方案若沒被任何預約引用就移除，避免表單上出現兩套方案
const keep = new Set(PLANS.map(p => p.name));
for (const p of db.prepare('SELECT * FROM service_plans').all()) {
  if (keep.has(p.name)) continue;
  const used = db.prepare('SELECT COUNT(*) n FROM appointments WHERE plan_id = ?').get(p.id).n;
  if (used) {
    db.prepare('UPDATE service_plans SET active = 0, portal_visible = 0 WHERE id = ?').run(p.id);
    console.log(`停用舊方案（已有 ${used} 筆預約）：${p.name}`);
  } else {
    db.prepare('DELETE FROM service_plans WHERE id = ?').run(p.id);
    console.log(`移除舊方案：${p.name}`);
  }
}

console.log(`\n完成。方案 ${PLANS.length} 個、主題 ${TOPICS.length} 項、心理師 ${COUNSELORS.length} 位。`);
console.log(`機構名稱：${getSetting('center_name')}`);
