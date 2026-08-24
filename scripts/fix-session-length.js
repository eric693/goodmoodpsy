// 把「尚未發生」的預約時長，對齊其方案設定的晤談時長。
//
// 預約的結束時間是建立當下算好的，方案時長之後才調整（或早期改方案時沒有重算），
// 就會出現同一方案有 13:00-13:50 也有 13:00-13:40、伴侶 80 分鐘卻只排 50 分鐘。
// 已經過去的預約不動（那是歷史紀錄），只重算今天以後的。
//
//   node scripts/fix-session-length.js            # 試跑，只列出會改什麼
//   node scripts/fix-session-length.js --apply    # 實際寫入
//   node scripts/fix-session-length.js --plan 10  # 只處理某個方案
const { db, getSetting } = require('../src/db');

const apply = process.argv.includes('--apply');
const pi = process.argv.indexOf('--plan');
const onlyPlan = pi > -1 ? Number(process.argv[pi + 1]) : null;
const fallback = Number(getSetting('session_minutes', '50')) || 50;

const rows = db.prepare(`SELECT a.id, a.date, a.start_time, a.end_time, a.plan_id,
    p.name AS plan_name, p.session_minutes
  FROM appointments a JOIN service_plans p ON p.id = a.plan_id
  WHERE a.date >= date('now','localtime') AND a.status IN ('booked','arrived')
    ${onlyPlan ? 'AND a.plan_id = ' + onlyPlan : ''}
  ORDER BY a.date, a.start_time`).all();

const endOf = (start, mins) => {
  const [h, m] = start.split(':').map(Number);
  const t = h * 60 + m + mins;
  return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
const fix = rows.map(a => ({ ...a, want: endOf(a.start_time, a.session_minutes || fallback) }))
  .filter(a => a.want !== a.end_time);

console.log(`檢查 ${rows.length} 筆未來預約，需修正 ${fix.length} 筆：`);
for (const a of fix) {
  console.log(`  #${a.id} ${a.date} ${a.start_time} ${a.end_time} → ${a.want}　${a.plan_name}`);
}
if (!fix.length) process.exit(0);
if (!apply) { console.log('\n（試跑，未寫入。加 --apply 才會實際更新）'); process.exit(0); }

const upd = db.prepare('UPDATE appointments SET end_time = ? WHERE id = ?');
db.transaction(() => { for (const a of fix) upd.run(a.want, a.id); })();
console.log('\n已寫入。');
