// 補上個案專區的預設密碼（手機末 6 碼，首次登入強制更換）。
//
// 早期匯入進來的個案沒有寫入密碼，password_hash 是空字串，
// 結果個案在專區怎麼輸入都登不進去（後端要求 password_hash 存在才比對）。
//
//   node scripts/backfill-portal-password.js          # 試跑
//   node scripts/backfill-portal-password.js --apply  # 實際寫入
const bcrypt = require('bcryptjs');
const { db } = require('../src/db');

const rows = db.prepare(`SELECT id, code, name, phone FROM clients
  WHERE active = 1 AND (password_hash IS NULL OR password_hash = '')`).all();
const ok = rows.filter(c => String(c.phone || '').replace(/\D/g, '').length >= 6);
const noPhone = rows.length - ok.length;

console.log(`沒有密碼的個案：${rows.length} 位`);
console.log(`  可用手機末 6 碼補上：${ok.length} 位`);
console.log(`  手機空白或位數不足、無法補：${noPhone} 位（這些人請櫃檯用「重設個案端密碼」處理）`);
for (const c of ok.slice(0, 5)) console.log(`  例：${c.code} ${c.name} ${c.phone} → ${String(c.phone).replace(/\D/g, '').slice(-6)}`);
if (!ok.length) process.exit(0);
if (!process.argv.includes('--apply')) { console.log('\n（試跑，未寫入。加 --apply 才會實際更新）'); process.exit(0); }

const upd = db.prepare('UPDATE clients SET password_hash = ?, must_change_password = 1 WHERE id = ?');
let n = 0;
db.transaction(() => {
  for (const c of ok) {
    upd.run(bcrypt.hashSync(String(c.phone).replace(/\D/g, '').slice(-6), 10), c.id);
    n++;
  }
})();
console.log(`\n已補上 ${n} 位個案的預設密碼（首次登入會要求更換）。`);
