// 一次性資料調整：把既有預約的 fee 從「方案總額」改成「個案要付的錢」。
//
// 舊版把 1800 元整筆記在 appointments.fee，個案在預約單與收費單上會看到 1800，
// 但補助方案的個案實際只付 200 元場地費。這支把補助方案的預約改成
//   fee = 個案自付、subsidy_amount = 方案給付
// 並同步修正尚未收款的收費單金額；已收款的單不動（金流已發生），只列出來供人工確認。
//
//   node scripts/migrate-fee-semantics.js          # 檢視將調整哪些資料
//   node scripts/migrate-fee-semantics.js --apply  # 實際寫入

const { db } = require('../src/db');
const { resolveFee } = require('../src/plans');

const APPLY = process.argv.includes('--apply');
const rows = db.prepare(`SELECT a.*, p.name AS plan_name, p.subsidy_amount AS plan_subsidy, p.fee AS plan_fee
  FROM appointments a JOIN service_plans p ON p.id = a.plan_id
  WHERE p.subsidy_amount > 0`).all();

let fixed = 0;
const manual = [];
for (const a of rows) {
  // 已經是新語意（fee 等於自付額）就跳過
  if (a.subsidy_amount > 0) continue;
  const q = resolveFee({ plan_id: a.plan_id, topic_id: a.topic_id, counselor_id: a.counselor_id });
  if (a.fee !== q.total) continue;                 // 金額被人工改過，不亂動
  console.log(`預約 #${a.id} ${a.date} ${a.start_time}｜${a.plan_name}：`
    + `fee ${a.fee} → ${q.client_pay}，方案給付 ${q.subsidy_amount}，心理師報酬 ${a.counselor_share} → ${q.counselor_share}`);
  if (APPLY) {
    db.prepare('UPDATE appointments SET fee = ?, subsidy_amount = ?, counselor_share = ? WHERE id = ?')
      .run(q.client_pay, q.subsidy_amount, q.counselor_share, a.id);
    const invs = db.prepare("SELECT * FROM invoices WHERE appointment_id = ? AND status != 'void'").all(a.id);
    for (const inv of invs) {
      if (inv.status === 'paid' || inv.status === 'refunded') {
        manual.push(`收費單 #${inv.id}（${inv.amount} 元，已收款）對應預約 #${a.id}，請人工確認金額`);
        continue;
      }
      db.prepare('UPDATE invoices SET amount = ?, subsidy_amount = ?, self_pay = ? WHERE id = ?')
        .run(q.client_pay, q.subsidy_amount, q.client_pay, inv.id);
      console.log(`  收費單 #${inv.id} 金額 ${inv.amount} → ${q.client_pay}`);
    }
  }
  fixed++;
}

console.log(`\n${APPLY ? '已調整' : '將調整'} ${fixed} 筆預約（檢視 ${rows.length} 筆補助方案預約）。`);
manual.forEach(m => console.log('※ ' + m));
if (!APPLY && fixed) console.log('確認無誤後加上 --apply 實際寫入。');
