// 清除展示資料：正式上線前把 seed 灌進來的示範帳號、示範個案與其相關紀錄刪掉。
//
//   node scripts/purge-demo.js          # 只列出會刪什麼，不動資料
//   node scripts/purge-demo.js --apply  # 實際刪除（執行前會自動備份一份資料庫）
//
// 只刪 seed 產生的展示資料：帳號 lin/chen/wu/office 與編號 C 開頭的示範個案
// （正式個案編號前綴已改為 G，見設定 case_code_prefix），真實資料不受影響。

const fs = require('fs');
const path = require('path');
const { db, DATA_DIR } = require('../src/db');

const APPLY = process.argv.includes('--apply');
const DEMO_USERS = ['lin', 'chen', 'wu', 'office'];

const users = db.prepare(`SELECT id, username, name FROM users WHERE username IN (${DEMO_USERS.map(() => '?').join(',')})`)
  .all(...DEMO_USERS);
const clients = db.prepare("SELECT id, code, name FROM clients WHERE code LIKE 'C%'").all();
const clientIds = clients.map(c => c.id);
const inClients = clientIds.length ? `(${clientIds.join(',')})` : '(0)';

const counts = {
  預約: db.prepare(`SELECT COUNT(*) n FROM appointments WHERE client_id IN ${inClients}`).get().n,
  晤談紀錄: db.prepare(`SELECT COUNT(*) n FROM session_notes WHERE client_id IN ${inClients}`).get().n,
  收費單: db.prepare(`SELECT COUNT(*) n FROM invoices WHERE client_id IN ${inClients}`).get().n,
  量表: db.prepare(`SELECT COUNT(*) n FROM assessments WHERE client_id IN ${inClients}`).get().n,
  來電登記: db.prepare('SELECT COUNT(*) n FROM intakes').get().n,
  線上申請: db.prepare('SELECT COUNT(*) n FROM booking_requests').get().n
};

console.log('示範帳號：', users.map(u => `${u.name}(${u.username})`).join('、') || '無');
console.log('示範個案：', clients.map(c => `${c.code} ${c.name}`).join('、') || '無');
console.log('連帶刪除：', Object.entries(counts).map(([k, v]) => `${k} ${v}`).join('、'));

if (!APPLY) {
  console.log('\n以上為預覽。確認無誤後執行：node scripts/purge-demo.js --apply');
  process.exit(0);
}

// 先備份，刪錯了還救得回來
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backup = path.join(DATA_DIR, 'backups', `pre-purge-${stamp}.db`);
fs.mkdirSync(path.dirname(backup), { recursive: true });
db.backup(backup).then(() => {
  console.log(`已備份：${backup}`);

  const tx = db.transaction(() => {
    // 個案相關資料多為 ON DELETE CASCADE，刪個案即連帶清掉
    for (const c of clients) db.prepare('DELETE FROM clients WHERE id = ?').run(c.id);
    db.prepare('DELETE FROM intakes').run();
    db.prepare('DELETE FROM booking_requests').run();
    db.prepare('DELETE FROM announcements').run();
    for (const u of users) {
      // 心理師名下若還有資料就只停用，避免刪出一堆孤兒紀錄
      const left = db.prepare('SELECT COUNT(*) n FROM appointments WHERE counselor_id = ?').get(u.id).n
        + db.prepare('SELECT COUNT(*) n FROM session_notes WHERE counselor_id = ?').get(u.id).n;
      if (left) {
        db.prepare('UPDATE users SET active = 0, portal_bookable = 0 WHERE id = ?').run(u.id);
        console.log(`  ${u.name} 名下仍有 ${left} 筆紀錄，改為停用`);
      } else {
        db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
        console.log(`  已刪除帳號 ${u.name}`);
      }
    }
  });
  tx();
  db.pragma('wal_checkpoint(TRUNCATE)');
  console.log('\n完成。請重新整理後台確認。');
}).catch(e => {
  console.error('備份失敗，未執行刪除：', e.message);
  process.exit(1);
});
