// 把既有資料庫的機構資訊改成「好心情心理諮商所」。
// 設定預設值只在欄位不存在時寫入，既有資料庫仍留著舊值，故用這支一次覆蓋。
//   node scripts/rebrand.js
const { db, setSetting, getSetting } = require('../src/db');

const VALUES = {
  center_name: '好心情心理諮商所',
  center_phone: '0909334443',
  center_address: '708 臺南市安平區建平七街453巷75號2樓之2',
  center_email: '',
  ui_staff_login_title: '好心情心理諮商所',
  ui_staff_login_sub: '諮商所管理系統',
  ui_portal_title: '好心情個案專區',
  ui_portal_login_sub: '預約、量表填寫與費用查詢',
  receipt_prefix: 'GM',
  case_code_prefix: 'G',
  line_official_name: '好心情心理諮商所',
  line_add_friend_url: 'https://line.me/ti/p/79QjQFFH5p',
  booking_public_url: 'https://goodmoodpsy.crownai.ink/booking.html'
};

for (const [k, v] of Object.entries(VALUES)) {
  const old = getSetting(k, '');
  if (old !== v) {
    setSetting(k, v);
    console.log(`${k}: ${old || '(空)'} → ${v}`);
  }
}

// 諮商室只有 2-3 間，若資料庫還沒建過就先給兩間（個案端不會看到，僅供後台指派）
if (!db.prepare('SELECT 1 FROM rooms LIMIT 1').get()) {
  db.prepare("INSERT INTO rooms (name, capacity, note) VALUES ('諮商室 A', 4, '個別／伴侶皆可')").run();
  db.prepare("INSERT INTO rooms (name, capacity, note) VALUES ('諮商室 B', 4, '')").run();
  console.log('已建立 2 間諮商室');
}
console.log('完成。');
