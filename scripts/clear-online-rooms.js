// 一次性整理：視訊晤談不在所內進行，卻被自動指派了諮商室，
// 導致諮商室使用表被視訊塞滿、看不出真正的空檔。把這些預約的空間清掉。
//
//   node scripts/clear-online-rooms.js          # 試跑
//   node scripts/clear-online-rooms.js --apply  # 實際寫入
const { db } = require('../src/db');

const rows = db.prepare(`SELECT a.id, a.date, a.start_time, r.name AS room, c.name AS client
  FROM appointments a LEFT JOIN rooms r ON r.id = a.room_id LEFT JOIN clients c ON c.id = a.client_id
  WHERE a.mode = 'online' AND a.room_id IS NOT NULL ORDER BY a.date`).all();
console.log(`視訊卻佔用空間的預約：${rows.length} 筆`);
for (const a of rows.slice(0, 10)) console.log(`  #${a.id} ${a.date} ${a.start_time} ${a.client}（${a.room}）`);
if (rows.length > 10) console.log(`  ...其餘 ${rows.length - 10} 筆`);
if (!rows.length) process.exit(0);
if (!process.argv.includes('--apply')) { console.log('\n（試跑，未寫入。加 --apply 才會實際更新）'); process.exit(0); }
db.prepare("UPDATE appointments SET room_id = NULL WHERE mode = 'online' AND room_id IS NOT NULL").run();
console.log('\n已清除，這些時段在諮商室使用表上會空出來。');
