#!/usr/bin/env node
// 補上匯入排程缺的方案與費用。
//
// 從諮商室使用表匯入的預約只有時間與人名，沒有 plan_id 也沒有費用，
// 於是「方案人次」「心理師收支」「統計報表」全部算不出東西。
// 這支依備註裡的線索（教師／學生／馬太鞍／伴侶／視訊）與晤談形式回推方案，
// 再用 plans.resolveFee() 算出個案自付額、補助額與心理師抽成——與櫃檯排約走的是同一套計價。
//
// 不會產生收費單：這批是早就收過錢的歷史資料，補開帳只會多出幾千張假的未收款。
//
//   node scripts/backfill-plan-fees.js          # 試算，不寫入
//   node scripts/backfill-plan-fees.js --apply  # 實際寫入

const { db, audit } = require('../src/db');
const plans = require('../src/plans');

const APPLY = process.argv.includes('--apply');

const byName = name => {
  const r = db.prepare('SELECT id FROM service_plans WHERE name LIKE ?').get(`%${name}%`);
  if (!r) throw new Error(`找不到方案「${name}」，請先確認方案設定`);
  return r.id;
};
const PLAN = {
  teacher: byName('教師支持方案'),
  student: byName('大學生方案'),
  matai: byName('馬太鞍'),
  couple: byName('婚姻伴侶'),
  family: byName('親子/家長'),
  online: byName('通訊（視訊）諮商'),
  individual: byName('個別心理諮商（50 分鐘）')
};

// 判方案：備註寫得最具體的優先，其次看晤談類型與形式，都沒有才落到自費個別諮商
function pickPlan(a) {
  const note = a.note || '';
  if (/教師/.test(note)) return [PLAN.teacher, '備註「教師」'];
  if (/學生/.test(note)) return [PLAN.student, '備註「學生」'];
  if (/馬太鞍/.test(note)) return [PLAN.matai, '備註「馬太鞍」'];
  if (/伴侶|家族/.test(note) || a.type === 'couple') return [PLAN.couple, '伴侶／家族'];
  if (a.type === 'family') return [PLAN.family, '親子／家長'];
  if (a.mode === 'online' || /視訊/.test(note)) return [PLAN.online, '視訊'];
  return [PLAN.individual, '預設：自費個別諮商'];
}

const rows = db.prepare('SELECT * FROM appointments WHERE plan_id IS NULL').all();
const tally = new Map();
let money = 0;

const run = db.transaction(() => {
  for (const a of rows) {
    const [planId, why] = pickPlan(a);
    const q = plans.resolveFee({ plan_id: planId, counselor_id: a.counselor_id });
    tally.set(why, (tally.get(why) || 0) + 1);
    money += q.fee;
    if (!APPLY) continue;
    db.prepare(`UPDATE appointments SET plan_id = ?, fee = ?, subsidy_amount = ?, counselor_share = ?
      WHERE id = ?`).run(planId, q.fee, q.subsidy_amount, q.counselor_share, a.id);
  }
  if (APPLY) audit('system', null, '整理', '補登匯入排程的方案與費用', `${rows.length} 筆`);
});
run();

console.log(`待補方案的預約 ${rows.length} 筆，判定依據：`);
for (const [why, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)} 筆　${why}`);
console.log(`\n個案自付額合計 ${money.toLocaleString()} 元（不產生收費單，僅供報表統計）`);
console.log(APPLY ? '\n已寫入資料庫。' : '\n以上為試算，未寫入。加上 --apply 才會實際補登。');
