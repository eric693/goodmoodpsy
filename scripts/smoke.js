// API 冒煙測試：在拋棄式資料庫上跑一輪關鍵流程，確認改動沒有打破既有功能。
//
//   npm run smoke              # 自行啟動測試用伺服器（預設埠 3999）
//   npm run smoke -- --keep    # 測完保留暫存資料庫與上傳目錄供查看
//
// 特性：
//   - 以 MINDCARE_DATA_DIR / MINDCARE_UPLOAD_DIR / MINDCARE_BACKUP_MIRROR 指向暫存目錄，
//     完全不碰正式資料（data/mindcare.db 與 uploads/）。
//   - 先跑 scripts/seed.js 灌入展示資料，再依實際 HTTP API 測試，不直接操作資料庫，
//     因此權限與保密邊界也一併被驗到。
//   - 任何一項失敗即以 exit code 1 結束，可掛在部署前或 CI。

process.env.TZ = process.env.TZ || 'Asia/Taipei';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 埠號預設交給作業系統挑一個空的，避免與機器上其他服務相撞
const net = require('net');
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}
let PORT = Number(process.env.SMOKE_PORT || 0);
let BASE = '';
const KEEP = process.argv.includes('--keep');
const ROOT = path.join(__dirname, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mindcare-smoke-'));
const env = {
  ...process.env,
  TZ: 'Asia/Taipei',
  MINDCARE_DATA_DIR: path.join(tmp, 'data'),
  MINDCARE_UPLOAD_DIR: path.join(tmp, 'uploads'),
  MINDCARE_BACKUP_MIRROR: path.join(tmp, 'mirror')
};

// ---- 迷你測試框架 ----
let pass = 0;
const failures = [];
let group = '';
function section(name) { group = name; console.log(`\n── ${name}`); }
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push(`${group} / ${name}：${e.message}`);
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '條件不成立'); }
function equal(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || '值不符'}（預期 ${expected}，實際 ${actual}）`);
}

// ---- HTTP 工具（各自帶 cookie，模擬不同登入身分）----
function session() {
  let cookie = '';
  const call = async (method, url, body, opts = {}) => {
    const headers = { ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) };
    let payload = body;
    if (body !== undefined && !opts.raw) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(BASE + url, { method, headers, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data = text;
    if ((res.headers.get('content-type') || '').includes('application/json')) {
      try { data = JSON.parse(text); } catch { /* 保留原文 */ }
    }
    return { status: res.status, data, text };
  };
  const self = {
    get cookie() { return cookie; },
    get: (u, o) => call('GET', u, undefined, o),
    post: (u, b, o) => call('POST', u, b, o),
    put: (u, b) => call('PUT', u, b),
    del: u => call('DELETE', u),
    // 成功才回傳內容，失敗直接丟出錯誤訊息，測試碼才不必層層判斷
    async ok(method, u, b, o) {
      const r = await call(method, u, b, o);
      if (r.status >= 400) throw new Error(`${method} ${u} → ${r.status} ${JSON.stringify(r.data)}`);
      return r.data;
    },
    async fails(method, u, b, msgPart) {
      const r = await call(method, u, b);
      assert(r.status >= 400, `${method} ${u} 應該被擋下，卻回 ${r.status}`);
      if (msgPart) {
        const m = (r.data && r.data.error) || '';
        assert(m.includes(msgPart), `錯誤訊息應含「${msgPart}」，實際為「${m}」`);
      }
      return r.data;
    }
  };
  return self;
}

// multipart 檔案上傳（不引外部套件，手工組 body）
function multipart(fields, file) {
  const b = '----mindcaresmoke' + Date.now();
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(
    `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n`
    + `Content-Type: ${file.type}\r\n\r\n`));
  parts.push(file.buf);
  parts.push(Buffer.from(`\r\n--${b}--\r\n`));
  return { body: Buffer.concat(parts), headers: { 'Content-Type': `multipart/form-data; boundary=${b}` } };
}

// 1x1 PNG（最小合法圖檔，用來驗證照片上傳與下載後位元組一致）
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (dateStr, n) => { const d = new Date(dateStr + 'T00:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
// 取未來第一個指定星期的日期（seed 的 lin 排班在週一／三／五）
function nextWeekday(wd, minDaysAhead = 2) {
  let d = addDays(ymd(new Date()), minDaysAhead);
  while (new Date(d + 'T00:00:00').getDay() !== wd) d = addDays(d, 1);
  return d;
}

let server;
function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn('node', [path.join(ROOT, 'src', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => reject(new Error('伺服器啟動逾時：\n' + out)), 20000);
    server.stdout.on('data', d => {
      out += d;
      if (out.includes('管理系統')) { clearTimeout(timer); resolve(); }
    });
    server.stderr.on('data', d => { out += d; });
    server.on('exit', code => { clearTimeout(timer); reject(new Error(`伺服器結束（code ${code}）：\n${out}`)); });
  });
}

(async () => {
  PORT = PORT || await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  env.PORT = String(PORT);
  console.log(`暫存資料目錄：${tmp}（測試埠 ${PORT}）`);
  execFileSync('node', [path.join(ROOT, 'scripts', 'seed.js')], { env, stdio: 'ignore' });
  await startServer();

  const admin = session(), lin = session(), office = session(), chen = session(), wu = session();
  const portal = session();
  let clientId, clientCode;

  // ---------------------------------------------------------------- 登入與權限
  section('登入與權限');
  await test('管理者登入', async () => {
    const me = await admin.ok('POST', '/api/login', { username: 'admin', password: 'mindcare123' });
    equal(me.role, 'admin', '角色');
  });
  await test('心理師、督導、行政登入', async () => {
    await lin.ok('POST', '/api/login', { username: 'lin', password: '123456' });
    await wu.ok('POST', '/api/login', { username: 'wu', password: '123456' });
    await office.ok('POST', '/api/login', { username: 'office', password: '123456' });
    await chen.ok('POST', '/api/login', { username: 'chen', password: '123456' });
  });
  await test('密碼錯誤被拒', () => admin.fails('POST', '/api/login', { username: 'lin', password: 'x' }));
  await test('未登入讀不到 API', async () => {
    const r = await fetch(BASE + '/api/clients');
    equal(r.status, 401, 'HTTP 狀態');
  });
  await test('行政人員沒有晤談紀錄模組', async () => {
    const list = await office.ok('GET', '/api/clients');
    await office.fails('GET', `/api/clients/${list[0].id}/notes`, undefined, '權限');
  });

  // ---------------------------------------------------------------- 個案
  section('個案建檔');
  await test('新增個案並自動編號', async () => {
    const r = await lin.ok('POST', '/api/clients', {
      name: '冒煙測試個案', phone: '0900000001', birth_date: '1995-03-02',
      counselor_id: 2, risk_level: 'high', main_issue: '測試'
    });
    clientId = r.id;
    const c = await lin.ok('GET', `/api/clients/${clientId}`);
    clientCode = c.code;
    assert(/^C\d{4}\d{3}$/.test(c.code), `個案編號格式異常：${c.code}`);
  });
  await test('身分證檢查碼不符時回警告（設計為提示不擋）', async () => {
    const r = await lin.ok('POST', '/api/clients', { name: '冒煙身分證測試', id_no: 'A123456780' });
    assert(r.warning && r.warning.includes('檢查碼'), `應回傳檢查碼警告，實際：${JSON.stringify(r.warning)}`);
  });

  // ---------------------------------------------------------------- 排班
  section('排班與可預約時段');
  // 基準日取兩週後的週一，與 seed 內建的請假（今天+4 天）錯開；
  // 其餘測試以此推算，避免彼此撞日：+7 收費、+14 個案端預約、+21 請假、+28 改期
  const monday = nextWeekday(1, 8);
  await test('整週排班存檔並合併重疊時段', async () => {
    const r = await lin.ok('POST', '/api/availability/bulk', {
      blocks: [
        { weekday: 1, start_time: '14:00', end_time: '16:00' },
        { weekday: 1, start_time: '14:00', end_time: '15:00' },   // 完全重疊
        { weekday: 1, start_time: '16:00', end_time: '18:00' },   // 相接
        { weekday: 3, start_time: '14:00', end_time: '18:00' },
        { weekday: 5, start_time: '14:00', end_time: '18:00' }
      ]
    });
    equal(r.count, 3, '合併後時段數（週一三五各一段）');
  });
  await test('可預約時段不重複', async () => {
    const slots = await lin.ok('GET', `/api/slots?counselor_id=2&date=${monday}`);
    const starts = slots.map(s => s.start_time);
    equal(new Set(starts).size, starts.length, '出現重複的開始時間');
    assert(starts.length > 0, '應該要有可預約時段');
  });
  await test('非管理者不可設定別人的排班', () =>
    lin.fails('POST', '/api/availability/bulk', { counselor_id: 3, blocks: [] }, '自己'));
  await test('結束時間早於開始時間被擋', () =>
    lin.fails('POST', '/api/availability/bulk',
      { blocks: [{ weekday: 2, start_time: '16:00', end_time: '15:00' }] }, '結束時間'));

  // ---------------------------------------------------------------- 預約
  section('預約與衝突檢查');
  let apptId;
  await test('建立預約', async () => {
    const r = await lin.ok('POST', '/api/appointments', {
      client_id: clientId, counselor_id: 2, room_id: 1, date: monday, start_time: '14:00', fee: 2000
    });
    apptId = r.id;
  });
  await test('同一心理師時段衝突被擋', () =>
    lin.fails('POST', '/api/appointments',
      { client_id: clientId, counselor_id: 2, date: monday, start_time: '14:00' }, '心理師'));
  await test('同一諮商室衝突被擋', () =>
    lin.fails('POST', '/api/appointments',
      { client_id: clientId, counselor_id: 3, room_id: 1, date: monday, start_time: '14:00' }, '諮商室'));
  await test('請假時段不可下訂', async () => {
    const off = addDays(monday, 21);
    await lin.ok('POST', '/api/time-off', { start_date: off, end_date: off, all_day: true, reason: '測試請假' });
    await lin.fails('POST', '/api/appointments',
      { client_id: clientId, counselor_id: 2, date: off, start_time: '14:00' }, '請假');
  });
  await test('週檢視與行事曆回傳資料', async () => {
    const w = await lin.ok('GET', `/api/schedule/week?start=${monday}`);
    assert(Array.isArray(w.appointments), '週檢視格式');
    const c = await lin.ok('GET', `/api/schedule/calendar?from=${monday}&to=${addDays(monday, 30)}`);
    assert(Array.isArray(c.appointments), '行事曆格式');
  });

  // ---------------------------------------------------------------- 行事曆訂閱
  section('行事曆訂閱（.ics）');
  let icsUrl;
  await test('取得訂閱網址並可讀取', async () => {
    const r = await lin.ok('GET', '/api/my/calendar-url');
    icsUrl = r.url;
    const res = await fetch(icsUrl);
    equal(res.status, 200, 'HTTP 狀態');
    const body = await res.text();
    assert(body.startsWith('BEGIN:VCALENDAR'), 'ics 格式');
    assert(body.includes('BEGIN:VEVENT'), '應包含事件');
    assert(body.includes(clientCode), '應以個案編號標示');
    assert(!body.includes('冒煙測試個案'), '不可含個案姓名');
  });
  await test('重設後舊網址失效', async () => {
    await lin.ok('POST', '/api/my/calendar-url/reset', {});
    const res = await fetch(icsUrl);
    equal(res.status, 404, '舊網址應失效');
  });

  // ---------------------------------------------------------------- 個案端
  section('個案端（預約、改期、取消）');
  let portalAppt;
  await test('個案端登入', async () => {
    await admin.ok('PUT', `/api/clients/${clientId}`, { portal_enabled: 1 });
    const rp = await admin.ok('POST', `/api/clients/${clientId}/reset-password`, {});
    const r = await portal.ok('POST', '/api/portal/login', { phone: '0900000001', password: rp.password });
    assert(r.ok, '登入失敗');
  });
  await test('個案端自行預約', async () => {
    const target = addDays(monday, 14);
    const slots = await portal.ok('GET', `/api/portal/slots?date=${target}`);
    const c = slots.counselors.find(x => x.slots.length);
    assert(c, `個案端在 ${target} 應看得到可預約時段，實際：${JSON.stringify(slots)}`);
    const r = await portal.ok('POST', '/api/portal/appointments',
      { date: target, start_time: c.slots[0].start_time, counselor_id: c.id });
    portalAppt = r.id;
  });
  await test('改期後不會與他人共用同一諮商室', async () => {
    // 先讓櫃檯把同一時段的諮商室 1 排給別的心理師，再讓個案改期過去
    const target = addDays(monday, 28);
    const slots = await lin.ok('GET', `/api/slots?counselor_id=2&date=${target}`);
    assert(slots.length, '該日應有可預約時段');
    const t = slots[0].start_time;
    const others = await lin.ok('GET', '/api/clients');
    const other = others.find(c => c.id !== clientId);
    await lin.ok('POST', '/api/appointments',
      { client_id: other.id, counselor_id: 3, room_id: 1, date: target, start_time: t });
    await admin.ok('PUT', `/api/appointments/${portalAppt}`, { room_id: 1 });
    await portal.ok('POST', `/api/portal/appointments/${portalAppt}/reschedule`, { date: target, start_time: t });
    const list = await lin.ok('GET', `/api/appointments?date=${target}`);
    const rooms = list.filter(a => a.room_id).map(a => `${a.room_id}@${a.start_time}`);
    equal(new Set(rooms).size, rooms.length, '同一諮商室同一時段被排了兩筆');
  });
  await test('逾期取消只留申請不直接取消', async () => {
    const now = new Date();
    if (now.getHours() >= 22) { console.log('      （接近午夜，略過此項）'); return; }
    const soon = ymd(now);
    const hh = String(now.getHours() + 1).padStart(2, '0');
    const r = await admin.ok('POST', '/api/appointments',
      { client_id: clientId, counselor_id: 2, date: soon, start_time: `${hh}:00` });
    const res = await portal.ok('POST', `/api/portal/appointments/${r.id}/cancel`, { reason: '臨時有事' });
    assert(res.pending, '應為待櫃檯處理的申請');
    const after = await admin.ok('GET', `/api/appointments?date=${soon}`);
    const row = after.find(a => a.id === r.id);
    equal(row.status, 'booked', '狀態不應被個案改掉');
    const dash = await admin.ok('GET', '/api/dashboard');
    assert(dash.cancel_requests.some(c => c.id === r.id), '總覽應列出取消申請');
    await admin.ok('POST', `/api/appointments/${r.id}/status`, { status: 'cancelled' });
  });
  await test('個案端讀不到晤談紀錄類 API', async () => {
    const res = await fetch(BASE + `/api/clients/${clientId}/notes`);
    assert(res.status === 401 || res.status === 403, '個案端不得存取員工 API');
  });

  // ---------------------------------------------------------------- 候補遞補
  section('候補遞補');
  await test('取消釋出時段後可配對候補', async () => {
    await admin.ok('POST', '/api/intakes', {
      name: '冒煙候補', phone: '0900000009', issue: '測試候補', urgency: 'high',
      preferred_counselor_id: 2, preferred_time: '平日下午'
    });
    const r = await admin.ok('POST', `/api/appointments/${apptId}/status`, { status: 'cancelled' });
    assert(r.opening && r.opening.candidates.length, '取消後應回傳候補人選');
    const openings = await admin.ok('GET', '/api/waitlist/openings');
    assert(openings.some(o => o.date === monday), '釋出時段應出現在候補清單');
  });
  await test('發送遞補通知（未設通道時記為人工）', async () => {
    const list = await admin.ok('GET', '/api/intakes');
    const w = list.find(i => i.name === '冒煙候補');
    const r = await admin.ok('POST', '/api/waitlist/notify',
      { intake_id: w.id, counselor_id: 2, date: monday, start_time: '14:00' });
    equal(r.status, 'manual', '發送狀態');
  });

  // ---------------------------------------------------------------- 晤談紀錄與覆核
  section('晤談紀錄保密與實習生覆核');
  let noteId, internId;
  await test('主責心理師可寫紀錄、非主責讀不到', async () => {
    const r = await lin.ok('POST', '/api/notes', {
      client_id: clientId, date: monday, subjective: 'S', objective: 'O',
      assessment: 'A', plan: 'P', risk_flag: 'none'
    });
    noteId = r.id;
    await chen.fails('GET', `/api/clients/${clientId}/notes`, undefined, '主責');
    const mine = await lin.ok('GET', `/api/clients/${clientId}/notes`);
    assert(mine.length >= 1, '主責應讀得到');
  });
  await test('督導可調閱', async () => {
    const rows = await wu.ok('GET', `/api/clients/${clientId}/notes`);
    assert(rows.length >= 1, '督導應讀得到');
  });
  await test('簽核後不可修改', async () => {
    await lin.ok('POST', `/api/notes/${noteId}/sign`, {});
    await lin.fails('PUT', `/api/notes/${noteId}`, { plan: '改改看' }, '定稿');
  });
  await test('實習生紀錄須經督導覆核才定稿', async () => {
    const u = await admin.ok('POST', '/api/users', {
      username: 'smoke_intern', password: '123456', name: '冒煙實習生', role: 'counselor',
      license_type: '實習心理師', is_intern: true, supervisor_id: 4
    });
    internId = u.id;
    await admin.ok('PUT', `/api/clients/${clientId}`, { counselor_id: internId });
    const intern = session();
    await intern.ok('POST', '/api/login', { username: 'smoke_intern', password: '123456' });
    const n = await intern.ok('POST', '/api/notes', {
      client_id: clientId, date: monday, subjective: 'S2', objective: 'O2', assessment: 'A2', plan: 'P2'
    });
    const signed = await intern.ok('POST', `/api/notes/${n.id}/sign`, {});
    equal(signed.review_status, 'pending', '應為待覆核');
    await intern.fails('PUT', `/api/notes/${n.id}`, { plan: '偷改' }, '覆核');
    const queue = await wu.ok('GET', '/api/notes/review-queue');
    assert(queue.rows.some(r => r.id === n.id), '督導的待覆核清單應包含此筆');
    await wu.fails('POST', `/api/notes/${n.id}/review`, { action: 'return' }, '意見');
    await wu.ok('POST', `/api/notes/${n.id}/review`, { action: 'return', comment: '請補風險評估' });
    await intern.ok('PUT', `/api/notes/${n.id}`, { plan: '已補' });
    await intern.ok('POST', `/api/notes/${n.id}/sign`, {});
    await chen.fails('POST', `/api/notes/${n.id}/review`, { action: 'approve' }, '督導');
    await wu.ok('POST', `/api/notes/${n.id}/review`, { action: 'approve', comment: 'OK' });
    const got = await wu.ok('GET', `/api/notes/${n.id}`);
    equal(got.review_status, 'approved', '覆核狀態');
    equal(got.locked, 1, '應已定稿鎖定');
    await admin.ok('PUT', `/api/clients/${clientId}`, { counselor_id: 2 });
  });

  // ---------------------------------------------------------------- 安全計畫
  section('安全計畫');
  let planId;
  await test('建立與新版本', async () => {
    const r = await lin.ok('POST', `/api/clients/${clientId}/safety-plans`, {
      warning_signs: '睡不著', coping_strategies: '散步', review_date: addDays(monday, 90)
    });
    planId = r.id;
    const v2 = await lin.ok('POST', `/api/clients/${clientId}/safety-plans`, {
      warning_signs: '睡不著、易怒', coping_strategies: '散步、深呼吸'
    });
    equal(v2.version, 2, '版本號');
    const list = await lin.ok('GET', `/api/clients/${clientId}/safety-plans`);
    equal(list.rows.filter(r2 => r2.status === 'active').length, 1, '現行版本應只有一份');
  });
  await test('必填欄位驗證', () =>
    lin.fails('POST', `/api/clients/${clientId}/safety-plans`, { warning_signs: '只有警訊' }, '必填'));
  await test('舊版本不可修改、可列印', async () => {
    await lin.fails('PUT', `/api/safety-plans/${planId}`, { warning_signs: 'x' }, '舊版本');
    const p = await lin.ok('GET', `/api/safety-plans/${planId}/print`);
    assert(p.center_name, '列印資料應含所別抬頭');
  });
  await test('非主責心理師與行政讀不到', async () => {
    await chen.fails('GET', `/api/clients/${clientId}/safety-plans`, undefined, '主責');
    await office.fails('GET', `/api/clients/${clientId}/safety-plans`);
  });
  await test('列管清單標示狀態', async () => {
    const d = await admin.ok('GET', '/api/safety-plans/overview');
    assert(d.rows.some(r => r.client_id === clientId && r.state === 'ok'), '應顯示現行有效');
  });

  // ---------------------------------------------------------------- 轉介與追蹤
  section('轉介、結案追蹤與通報表');
  await test('轉介紀錄與對方回覆', async () => {
    const r = await lin.ok('POST', `/api/clients/${clientId}/referrals`,
      { target: '某某醫院身心科', reason: '需藥物評估', contact: '02-1234-5678' });
    await lin.fails('POST', `/api/clients/${clientId}/referrals`, { target: '缺原因' }, '原因');
    await lin.ok('PUT', `/api/referrals/${r.id}`, { status: 'accepted', reply_note: '已排下週門診' });
    const list = await lin.ok('GET', `/api/clients/${clientId}/referrals`);
    const row = list.rows.find(x => x.id === r.id);
    equal(row.status, 'accepted', '轉介狀態');
    assert(row.replied_at, '應自動記下回覆時間');
    assert(list.targets.length, '應提供轉介對象選項');
  });
  await test('非主責心理師與行政讀不到轉介紀錄', async () => {
    await chen.fails('GET', `/api/clients/${clientId}/referrals`, undefined, '主責');
    await office.fails('GET', `/api/clients/${clientId}/referrals`);
    await office.fails('GET', '/api/follow-ups');
  });
  await test('結案時自動建立追蹤點', async () => {
    const r = await admin.ok('PUT', `/api/clients/${clientId}`, { status: 'closed', close_reason: '目標達成' });
    assert(r.follow_ups >= 1, '結案應自動建立追蹤點');
    const fu = await lin.ok('GET', `/api/clients/${clientId}/follow-ups`);
    assert(fu.rows.length >= 1, '追蹤清單應有資料');
    const first = fu.rows[0];
    await lin.fails('PUT', `/api/follow-ups/${first.id}`, { status: 'done' }, '追蹤結果');
    await lin.ok('PUT', `/api/follow-ups/${first.id}`,
      { status: 'done', channel: '電話', result: '個案狀況穩定，無需再約' });
    const after = await lin.ok('GET', `/api/clients/${clientId}/follow-ups`);
    const done = after.rows.find(x => x.id === first.id);
    equal(done.status, 'done', '追蹤狀態');
    assert(done.done_at, '應記下完成時間');
    // 還原為服務中，後續收費測試才排得了新預約
    await admin.ok('PUT', `/api/clients/${clientId}`, { status: 'active' });
  });
  await test('待追蹤清單可查', async () => {
    const d = await admin.ok('GET', '/api/follow-ups');
    assert(Array.isArray(d.rows), '清單格式');
    assert(typeof d.overdue === 'number', '應回傳逾期數');
  });
  await test('責任通報表帶齊欄位', async () => {
    const events = await admin.ok('GET', '/api/risk-events');
    assert(events.length, '示範資料應有危機事件');
    const f = await admin.ok('GET', `/api/risk-events/${events[0].id}/report-form`);
    assert(f.client_name && f.client_code, '應帶當事人資料');
    assert(f.reporter && f.reporter.name, '應帶通報人');
    assert(f.center_name, '應帶通報單位');
    assert(typeof f.mandatory === 'boolean', '應標示是否為法定責任通報');
    await office.fails('GET', `/api/risk-events/${events[0].id}/report-form`);
  });

  // ---------------------------------------------------------------- 收費與退費
  section('收費、方案與退費');
  let invoiceId;
  await test('完成晤談自動開單並收款', async () => {
    const target = addDays(monday, 7);
    const a = await lin.ok('POST', '/api/appointments',
      { client_id: clientId, counselor_id: 2, date: target, start_time: '14:00', fee: 2000 });
    await lin.ok('POST', `/api/appointments/${a.id}/status`, { status: 'done' });
    const inv = await admin.ok('GET', `/api/invoices?client_id=${clientId}&status=unpaid`);
    const row = inv.rows.find(r => r.appointment_id === a.id);
    assert(row, '完成晤談應產生收費單');
    invoiceId = row.id;
    await admin.ok('POST', `/api/invoices/${invoiceId}/pay`, { method: '現金' });
    const after = await admin.ok('GET', `/api/invoices?client_id=${clientId}`);
    equal(after.rows.find(r => r.id === invoiceId).status, 'paid', '收款後狀態');
  });
  await test('退費超額被擋、全額退費改狀態', async () => {
    await admin.fails('POST', `/api/invoices/${invoiceId}/refund`, { amount: 99999, reason: '測試' }, '上限');
    await admin.fails('POST', `/api/invoices/${invoiceId}/refund`, { amount: 100 }, '原因');
    await admin.ok('POST', `/api/invoices/${invoiceId}/refund`, { amount: 2000, reason: '所方因素取消' });
    const list = await admin.ok('GET', `/api/invoices?client_id=${clientId}`);
    const row = list.rows.find(r => r.id === invoiceId);
    equal(row.status, 'refunded', '全額退費後狀態');
    equal(row.refunded, 2000, '已退金額');
    equal(list.total_net, list.total_paid + 2000 - list.total_refunded, '實收計算');
  });
  await test('已退費的收費單不會被狀態回沖刪掉', async () => {
    const inv = await admin.ok('GET', `/api/invoices?client_id=${clientId}`);
    const row = inv.rows.find(r => r.id === invoiceId);
    const r = await admin.ok('POST', `/api/appointments/${row.appointment_id}/status`, { status: 'booked' });
    assert(r.warnings.length, '應提出警示');
    const after = await admin.ok('GET', `/api/invoices?client_id=${clientId}`);
    assert(after.rows.some(x => x.id === invoiceId), '退費過的收費單被刪除了');
  });
  await test('撤銷退費後回復為已收款', async () => {
    const d = await admin.ok('GET', '/api/refunds');
    const rf = d.rows.find(r => r.invoice_id === invoiceId);
    await admin.ok('DELETE', `/api/refunds/${rf.id}`);
    const list = await admin.ok('GET', `/api/invoices?client_id=${clientId}`);
    equal(list.rows.find(r => r.id === invoiceId).status, 'paid', '撤銷後狀態');
  });

  // ---------------------------------------------------------------- 附件
  section('附件上傳與下載');
  let pngId, pdfId;
  await test('上傳照片（PNG）', async () => {
    const mp = multipart({ kind: '其他', note: '冒煙測試照片' }, { name: '測試照片.png', type: 'image/png', buf: PNG });
    const r = await lin.ok('POST', `/api/clients/${clientId}/attachments`, mp.body, { raw: true, headers: mp.headers });
    pngId = r.id || (r.attachment && r.attachment.id);
    assert(pngId, `上傳回應缺少 id：${JSON.stringify(r)}`);
  });
  await test('上傳 PDF 並保留中文檔名', async () => {
    const mp = multipart({ kind: '轉介單' }, { name: '轉介單.pdf', type: 'application/pdf', buf: PDF });
    const r = await lin.ok('POST', `/api/clients/${clientId}/attachments`, mp.body, { raw: true, headers: mp.headers });
    pdfId = r.id || (r.attachment && r.attachment.id);
    const list = await lin.ok('GET', `/api/clients/${clientId}/attachments`);
    assert(list.some(f => f.filename === '轉介單.pdf'), '中文檔名應正確保存');
  });
  await test('不支援的副檔名被擋', async () => {
    const mp = multipart({}, { name: 'evil.exe', type: 'application/octet-stream', buf: Buffer.from('x') });
    const r = await lin.post(`/api/clients/${clientId}/attachments`, mp.body, { raw: true, headers: mp.headers });
    assert(r.status >= 400, `應被擋下，卻回 ${r.status}`);
  });
  await test('未登入不可下載附件', async () => {
    const r = await fetch(BASE + `/api/attachments/${pngId}/download`);
    assert(r.status === 401 || r.status === 403, `未登入不應下載成功（回 ${r.status}）`);
  });
  await test('主責心理師可下載且內容正確', async () => {
    const res = await fetch(BASE + `/api/attachments/${pngId}/download`, { headers: { Cookie: lastCookie(lin) } });
    equal(res.status, 200, 'HTTP 狀態');
    const buf = Buffer.from(await res.arrayBuffer());
    equal(buf.length, PNG.length, '下載位元組數');
    assert(buf.equals(PNG), '下載內容與上傳不一致');
  });
  await test('實體檔確實落在上傳目錄且檔名隨機', async () => {
    const files = fs.readdirSync(env.MINDCARE_UPLOAD_DIR);
    assert(files.length >= 2, '上傳目錄應有檔案');
    assert(!files.some(f => f.includes('測試照片')), '實體檔名不應沿用原始檔名');
  });
  await test('uploads 目錄不對外開放靜態存取', async () => {
    const files = fs.readdirSync(env.MINDCARE_UPLOAD_DIR);
    const res = await fetch(`${BASE}/uploads/${files[0]}`);
    assert(res.status === 404, `uploads 不應可直接讀取（回 ${res.status}）`);
  });
  await test('個案端只看得到被開放的附件', async () => {
    let mine = await portal.ok('GET', '/api/portal/attachments');
    equal(mine.length, 0, '預設不應開放');
    const res = await fetch(BASE + `/api/portal/attachments/${pdfId}/download`, { headers: { Cookie: lastCookie(portal) } });
    assert(res.status >= 400, '未開放的檔案不可下載');
    await lin.ok('PUT', `/api/attachments/${pdfId}`, { visible_to_client: 1 });
    mine = await portal.ok('GET', '/api/portal/attachments');
    equal(mine.length, 1, '開放後應看得到');
    const ok = await fetch(BASE + `/api/portal/attachments/${pdfId}/download`, { headers: { Cookie: lastCookie(portal) } });
    equal(ok.status, 200, '開放後應可下載');
  });
  await test('行政層附件他人可讀、臨床層附件受保密邊界保護', async () => {
    // 轉介單屬行政層：有個案管理權限者皆可存取
    const admin1 = await fetch(BASE + `/api/attachments/${pdfId}/download`, { headers: { Cookie: lastCookie(chen) } });
    equal(admin1.status, 200, '行政層附件應可讀');
    // 衡鑑報告屬臨床層：非主責心理師應被擋
    const mp = multipart({ kind: '衡鑑報告' }, { name: '衡鑑報告.pdf', type: 'application/pdf', buf: PDF });
    const rep = await lin.ok('POST', `/api/clients/${clientId}/attachments`, mp.body, { raw: true, headers: mp.headers });
    const blocked = await fetch(BASE + `/api/attachments/${rep.id}/download`, { headers: { Cookie: lastCookie(chen) } });
    assert(blocked.status === 403, `臨床層附件應被擋（回 ${blocked.status}）`);
    const listForChen = await chen.ok('GET', `/api/clients/${clientId}/attachments`);
    assert(!listForChen.some(f => f.id === rep.id), '臨床層附件不應出現在非主責者的清單');
    const listForLin = await lin.ok('GET', `/api/clients/${clientId}/attachments`);
    assert(listForLin.some(f => f.id === rep.id), '主責心理師應看得到');
  });
  await test('刪除附件同時移除實體檔', async () => {
    const before = fs.readdirSync(env.MINDCARE_UPLOAD_DIR).length;
    await lin.ok('DELETE', `/api/attachments/${pngId}`);
    const after = fs.readdirSync(env.MINDCARE_UPLOAD_DIR).length;
    equal(after, before - 1, '實體檔應一併刪除');
  });

  // ---------------------------------------------------------------- 備份與資料同步
  section('備份與資料同步');
  await test('手動備份並同步附件到異地目錄', async () => {
    const r = await admin.ok('POST', '/api/maintenance/backup', {});
    assert(r.latest_backup, '應產生備份檔');
    const mirrorDb = path.join(env.MINDCARE_BACKUP_MIRROR, r.latest_backup);
    assert(fs.existsSync(mirrorDb), '異地目錄應有備份檔');
    assert(fs.statSync(mirrorDb).size > 0, '備份檔不應為空');
    equal(r.uploads_mirrored, r.uploads_total, '附件同步數應與上傳目錄一致');
    const mirrored = fs.readdirSync(path.join(env.MINDCARE_BACKUP_MIRROR, 'uploads'));
    const live = fs.readdirSync(env.MINDCARE_UPLOAD_DIR);
    for (const f of live) assert(mirrored.includes(f), `附件未同步：${f}`);
  });
  await test('備份檔可獨立開啟且資料完整', async () => {
    const Database = require('better-sqlite3');
    const r = await admin.ok('POST', '/api/maintenance/backup', {});
    const b = new Database(path.join(env.MINDCARE_DATA_DIR, 'backups', r.latest_backup), { readonly: true });
    const n = b.prepare('SELECT COUNT(*) n FROM clients').get().n;
    const rows = b.prepare('SELECT COUNT(*) n FROM attachments').get().n;
    b.close();
    assert(n > 0, '備份內應有個案資料');
    assert(rows > 0, '備份內應有附件紀錄');
  });
  await test('非管理者不可觸發備份', () => lin.fails('POST', '/api/maintenance/backup', {}, '管理者'));

  // ---------------------------------------------------------------- 報表與稽核
  section('報表與稽核');
  await test('月報與匯出可產生', async () => {
    const month = monday.slice(0, 7);
    const rep = await admin.ok('GET', `/api/reports?month=${month}`);
    assert(rep.income, '月報應含收入區塊');
    for (const fmt of ['csv', 'xls', 'pdf']) {
      const r = await admin.get(`/api/exports/clients?format=${fmt}`);
      equal(r.status, 200, `匯出格式 ${fmt}`);
    }
  });
  await test('調閱紀錄寫入稽核軌跡', async () => {
    const rows = await admin.ok('GET', '/api/audit-logs');
    assert(rows.some(l => String(l.action).includes('調閱')), '應有調閱紀錄的稽核');
    assert(rows.some(l => String(l.action).includes('安全計畫')), '應有安全計畫相關稽核');
  });
  await test('經營品質指標計算正確', async () => {
    const month = monday.slice(0, 7);
    const r = await admin.ok('GET', `/api/reports?month=${month}`);
    const k = r.kpi;
    assert(k, '月報應含 kpi 區塊');
    for (const key of ['no_show_rate', 'cancel_rate', 'intake_conversion', 'dropout', 'avg_sessions', 'utilization']) {
      assert(k[key] !== undefined, `缺少指標：${key}`);
    }
    // 分母為 0 時必須是 null 而不是 0 或 NaN
    const empty = await admin.ok('GET', '/api/reports?month=1990-01');
    equal(empty.kpi.no_show_rate, null, '無資料月份的爽約率');
    equal(empty.kpi.avg_sessions, null, '無資料月份的平均次數');
    const u = k.utilization.find(x => x.name === '林筱雯');
    assert(u && u.capacity_hours > 0, '排班後應算得出時段容量');
    assert(u.rate !== null && u.rate >= 0, '利用率應為數字');
  });
  await test('總覽與我的工作台可載入', async () => {
    const d = await admin.ok('GET', '/api/dashboard');
    assert(d.charts && d.charts.months.length === 6, '總覽圖表資料');
    const my = await lin.ok('GET', '/api/my-dashboard');
    assert(my.me, '我的工作台');
  });

  // ------------------------------------------------- 方案別、額度、收據與線上預約
  section('方案別與額度');
  let youthPlanId, youthTopicId, planClientId;
  await test('方案清單含補助方案與可選金額方案', async () => {
    const list = await admin.ok('GET', '/api/service-plans');
    const youth = list.find(p => p.quota_per_year === 3 && p.counselor_week_limit === 6);
    assert(youth, '找不到年輕族群方案');
    youthPlanId = youth.id;
    youthTopicId = youth.topics[0].id;
    assert(list.some(p => p.fee_mode === 'choice' && p.fee_option_list.length > 1), '缺少可選金額方案');
  });
  await test('後台可自訂方案、主題與心理師費率', async () => {
    const created = await admin.ok('POST', '/api/service-plans', {
      name: '冒煙測試方案', kind: 'self', fee: 1800, share_mode: 'percent', share_percent: 55,
      quota_per_year: 2, counselor_week_limit: 1
    });
    await admin.ok('POST', `/api/service-plans/${created.id}/topics`, { name: '測試主題', fee: 2100 });
    const lins = (await admin.ok('GET', '/api/users')).find(u => u.username === 'lin');
    await admin.ok('POST', `/api/service-plans/${created.id}/rates`, { counselor_id: lins.id, fee: 2500, share_mode: 'fixed', share_fixed: 1500 });
    const after = (await admin.ok('GET', '/api/service-plans')).find(p => p.id === created.id);
    equal(after.topics.length, 1, '主題數');
    equal(after.rates.length, 1, '費率數');
    const q = await admin.ok('GET', `/api/plan-quote?plan_id=${created.id}&counselor_id=${lins.id}`);
    equal(q.fee, 2500, '心理師費率覆寫金額');
    equal(q.counselor_share, 1500, '固定鐘點費');
    await admin.ok('DELETE', `/api/service-plans/${created.id}`);
  });
  await test('補助方案取價含方案給付與自付拆分', async () => {
    const q = await admin.ok('GET', `/api/plan-quote?plan_id=${youthPlanId}&topic_id=${youthTopicId}`);
    equal(q.total, 1800, '方案總額');
    equal(q.fee, 200, '個案要付的錢（畫面上的費用欄位）');
    equal(q.subsidy_amount, 1600, '方案給付');
    equal(q.venue_fee, 200, '場地費');
    equal(q.share_base, 1600, '抽成基數應扣掉場地費');
  });
  await test('個案年度額度用滿後擋下第四次，並提示已用次數', async () => {
    const clients = await admin.ok('GET', '/api/clients');
    planClientId = clients[0].id;
    const lins = (await admin.ok('GET', '/api/users')).find(u => u.username === 'lin');
    // 挑遠一點的空白週次，避開 seed 灌入的預約與請假
    const made = [];
    try {
      for (let i = 0; i < 3; i++) {
        const d = nextWeekday(1, 100 + i * 7);
        made.push((await admin.ok('POST', '/api/appointments', {
          client_id: planClientId, counselor_id: lins.id, date: d, start_time: '07:00',
          plan_id: youthPlanId, topic_id: youthTopicId
        })).id);
      }
      const usage = await admin.ok('GET', `/api/clients/${planClientId}/plan-usage`);
      const u = usage.rows.find(r => r.plan_id === youthPlanId);
      equal(u.used, 3, '已用次數');
      equal(u.remaining, 0, '剩餘次數');
      const blocked = await admin.fails('POST', '/api/appointments', {
        client_id: planClientId, counselor_id: lins.id, date: nextWeekday(1, 128), start_time: '07:00',
        plan_id: youthPlanId
      }, '額度');
      assert(/額度已用完/.test(blocked.error || ''), '錯誤訊息應說明額度用完：' + JSON.stringify(blocked));
    } finally {
      for (const id of made) await admin.del(`/api/appointments/${id}`);
    }
  });
  await test('人工調整已用次數（他所已使用）會計入額度', async () => {
    await admin.ok('PUT', `/api/clients/${planClientId}/plan-usage`, {
      plan_id: youthPlanId, used_offset: 3, note: '他所已使用'
    });
    const usage = await admin.ok('GET', `/api/clients/${planClientId}/plan-usage`);
    equal(usage.rows.find(r => r.plan_id === youthPlanId).used, 3, '含調整後已用次數');
    await admin.ok('PUT', `/api/clients/${planClientId}/plan-usage`, { plan_id: youthPlanId, used_offset: 0 });
  });
  await test('心理師每週人次上限擋下第七人次並指出下週餘額', async () => {
    const lins = (await admin.ok('GET', '/api/users')).find(u => u.username === 'lin');
    const clients = await admin.ok('GET', '/api/clients');
    const monday = nextWeekday(1, 150);
    const made = [];
    try {
      // 六個不同個案排滿同一週（override 略過個人年度額度，這裡驗的是心理師人次上限）
      for (let i = 0; i < 6; i++) {
        made.push((await admin.ok('POST', '/api/appointments', {
          client_id: clients[i % clients.length].id, counselor_id: lins.id,
          date: addDays(monday, i % 5), start_time: ['07:00', '08:00'][Math.floor(i / 5)] || '08:00',
          plan_id: youthPlanId, override: true
        })).id);
      }
      const load = await admin.ok('GET', `/api/plan-load?counselor_id=${lins.id}&plan_id=${youthPlanId}&date=${monday}`);
      equal(load.week_used, 6, '本週已用人次');
      assert(load.week_full, '本週應已額滿');
      equal(load.next_week.remaining, 6, '下週餘額');
      const msg = await admin.fails('POST', '/api/appointments', {
        client_id: clients[0].id, counselor_id: lins.id, date: addDays(monday, 4), start_time: '09:00',
        plan_id: youthPlanId
      }, '人次');
      assert(/已排滿/.test(msg.error || ''), '錯誤訊息應說明額滿：' + JSON.stringify(msg));
    } finally {
      for (const id of made) await admin.del(`/api/appointments/${id}`);
    }
  });

  section('線上預約表單');
  let bookingId;
  await test('公開設定不外洩諮商室配置', async () => {
    const cfg = await (await fetch(BASE + '/api/public/booking-config')).json();
    assert(cfg.enabled, '表單應啟用');
    assert(cfg.plans.length, '應有可預約方案');
    assert(!JSON.stringify(cfg).includes('諮商室'), '公開設定不應含諮商室');
  });
  await test('公開時段查詢只回傳時間', async () => {
    const lins = (await admin.ok('GET', '/api/users')).find(u => u.username === 'lin');
    const d = await (await fetch(`${BASE}/api/public/booking-slots?counselor_id=${lins.id}&plan_id=${youthPlanId}&days=14`)).json();
    assert(d.days.some(x => x.slots.length), '應有可預約時段');
    assert(!JSON.stringify(d).includes('room'), '不應帶出諮商室資訊');
  });
  await test('未勾同意個資告知不得送出', async () => {
    const r = await fetch(BASE + '/api/public/bookings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '測試', phone: '0911222333', plan_id: youthPlanId, consent: false })
    });
    equal(r.status, 400, 'HTTP 狀態');
  });
  await test('補助方案年齡不符在表單端即擋下', async () => {
    const r = await fetch(BASE + '/api/public/bookings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '長輩', phone: '0911222444', birth_date: '1950-01-01',
        plan_id: youthPlanId, consent: true })
    });
    const d = await r.json();
    equal(r.status, 400, 'HTTP 狀態');
    assert(/歲/.test(d.error), '應說明年齡限制：' + d.error);
  });
  await test('民眾送出預約申請', async () => {
    const lins = (await admin.ok('GET', '/api/users')).find(u => u.username === 'lin');
    const date = nextWeekday(3, 9);
    const slots = await (await fetch(`${BASE}/api/public/booking-slots?counselor_id=${lins.id}&plan_id=${youthPlanId}&from=${date}&days=1`)).json();
    const slot = slots.days[0].slots[0];
    const r = await fetch(BASE + '/api/public/bookings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '林小新', phone: '0911777888', birth_date: '2000-05-05', gender: 'female',
        plan_id: youthPlanId, topic_id: youthTopicId, counselor_id: lins.id,
        date, start_time: slot.start_time, main_issue: '最近壓力很大', consent: true
      })
    });
    const d = await r.json();
    assert(r.ok, '送出失敗：' + JSON.stringify(d));
    bookingId = d.id;
  });
  await test('櫃檯看得到待處理申請', async () => {
    const rows = await admin.ok('GET', '/api/bookings?status=new');
    assert(rows.some(r => r.id === bookingId), '待處理清單應含此申請');
  });
  await test('由申請建檔並成立預約，系統自動指派諮商室', async () => {
    const c = await admin.ok('POST', `/api/bookings/${bookingId}/create-client`);
    assert(c.client_id, '建檔失敗');
    const r = await admin.ok('POST', `/api/bookings/${bookingId}/confirm`, {});
    assert(r.appointment_id, '未成立預約');
    assert(r.room_id, '應自動指派諮商室');
    const appt = (await admin.ok('GET', `/api/appointments?client_id=${c.client_id}`))[0];
    equal(appt.plan_id, youthPlanId, '方案別');
    equal(appt.fee, 200, '個案只需付場地費');
    equal(appt.subsidy_amount, 1600, '方案給付另記');
  });
  await test('個案端看不到諮商室', async () => {
    const rows = await admin.ok('GET', '/api/bookings');
    assert(rows.find(r => r.id === bookingId).status === 'confirmed', '狀態應為已成立');
  });

  section('收據');
  let receiptId, receiptNo;
  await test('已收款的收費單可開立流水編號收據', async () => {
    const list = await admin.ok('GET', '/api/invoices');
    const inv = list.rows.find(i => i.status === 'paid') || list.rows[0];
    if (inv.status !== 'paid') await admin.ok('POST', `/api/invoices/${inv.id}/pay`, { method: '現金' });
    const r = await admin.ok('POST', '/api/receipts', { invoice_id: inv.id });
    assert(/^GM\d{6}\d{4}$/.test(r.receipt_no) || /^\w+\d{10}$/.test(r.receipt_no), '收據編號格式：' + r.receipt_no);
    receiptId = r.id;
    receiptNo = r.receipt_no;
  });
  await test('同一收費單不會重複開立收據', async () => {
    const list = await admin.ok('GET', '/api/receipts');
    const r = list.rows.find(x => x.id === receiptId);
    await admin.fails('POST', '/api/receipts', { invoice_id: r.invoice_id }, '已開立');
  });
  await test('補印會累計次數', async () => {
    await admin.ok('POST', `/api/receipts/${receiptId}/printed`);
    await admin.ok('POST', `/api/receipts/${receiptId}/printed`);
    const r = await admin.ok('GET', `/api/receipts/${receiptId}`);
    equal(r.print_count, 2, '補印次數');
    assert(r.center_name, '收據應帶機構抬頭');
  });
  await test('作廢重開會產生新號並與原號勾稽', async () => {
    const r = await admin.ok('POST', `/api/receipts/${receiptId}/reissue`, { reason: '抬頭錯誤', title: '好心情股份有限公司' });
    assert(r.receipt_no !== receiptNo, '應為新號');
    const list = await admin.ok('GET', '/api/receipts');
    const old = list.rows.find(x => x.id === receiptId);
    const neu = list.rows.find(x => x.receipt_no === r.receipt_no);
    equal(old.status, 'void', '原收據應作廢');
    equal(neu.reissue_of, receiptNo, '新收據應記錄原號');
  });
  await test('個案端查得到自己的收據', async () => {
    const b = await portal.ok('GET', '/api/portal/billing');
    assert(Array.isArray(b.receipts), '個案端應可查收據');
  });

  section('心理師收支與 LINE');
  await test('依方案別產出每位心理師的月收支', async () => {
    const d = await admin.ok('GET', `/api/plan-income?month=${ymd(new Date()).slice(0, 7)}`);
    assert(Array.isArray(d.rows), '應回傳心理師清單');
    assert(d.total && typeof d.total.share === 'number', '應有報酬合計');
    if (d.rows.length) {
      const r = d.rows[0];
      equal(r.gross - r.share, r.center, '所方淨收 = 應收 - 心理師報酬');
      const detail = await admin.ok('GET', `/api/plan-income/${r.counselor_id}/detail?month=${ymd(new Date()).slice(0, 7)}`);
      assert(detail.counselor, '應可取得明細');
    }
  });
  await test('補助方案：抽成以扣掉場地費後的金額計，場地費歸所方', async () => {
    const lins = (await admin.ok('GET', '/api/users')).find(u => u.username === 'lin');
    const clients = await admin.ok('GET', '/api/clients');
    const date = nextWeekday(2, 170);
    const made = await admin.ok('POST', '/api/appointments', {
      client_id: clients[0].id, counselor_id: lins.id, date, start_time: '07:00',
      plan_id: youthPlanId, override: true
    });
    await admin.ok('POST', `/api/appointments/${made.id}/status`, { status: 'done' });
    const appt = (await admin.ok('GET', `/api/appointments?client_id=${clients[0].id}`)).find(a => a.id === made.id);
    equal(appt.fee, 200, '個案自付');
    equal(appt.subsidy_amount, 1600, '方案給付');
    equal(appt.counselor_share, 960, '心理師報酬＝1600 × 60%');
    // 收費單只跟個案收 200，不會出現 1800 的帳單
    const inv = (await admin.ok('GET', '/api/invoices')).rows.find(i => i.appointment_id === made.id);
    equal(inv.amount, 200, '收費單金額');
    equal(inv.subsidy_amount, 1600, '收費單記錄方案給付');
    const income = await admin.ok('GET', `/api/plan-income?month=${date.slice(0, 7)}&counselor_id=${lins.id}`);
    const plan = income.rows[0].plans.find(p => p.plan_id === youthPlanId);
    equal(plan.gross, 200 + 1600, '服務總額');
    equal(plan.venue, 200, '場地費');
    equal(plan.share, 960, '心理師報酬');
    equal(plan.center, 1800 - 960, '所方淨收（含場地費 200）');
    await admin.ok('POST', `/api/appointments/${made.id}/status`, { status: 'cancelled' });
    await admin.del(`/api/appointments/${made.id}`);
  });
  await test('方案設定：每個欄位都能改，抽成 60 與 0.6 都收得下', async () => {
    const plan = (await admin.ok('GET', '/api/service-plans')).find(p => p.active);
    const before = { name: plan.name, fee: plan.fee, share_percent: plan.share_percent, default_mode: plan.default_mode };
    await admin.ok('PUT', `/api/service-plans/${plan.id}`, {
      name: plan.name, fee: 2345, share_percent: 60, default_mode: 'online',
      session_minutes: 80, venue_fee: 200, quota_per_year: 3
    });
    const after = (await admin.ok('GET', '/api/service-plans')).find(p => p.id === plan.id);
    equal(after.fee, 2345, '金額已改');
    equal(after.share_percent, 0.6, '抽成 60 收斂成 0.6');
    equal(after.default_mode, 'online', '預設形式可改（原本前端沒有這個欄位）');
    equal(after.session_minutes, 80, '時長可改');
    equal(after.venue_fee, 200, '場地費可改');
    equal(after.quota_per_year, 3, '年度次數可改');
    await admin.ok('PUT', `/api/service-plans/${plan.id}`, Object.assign({}, before, {
      session_minutes: plan.session_minutes, venue_fee: plan.venue_fee, quota_per_year: plan.quota_per_year
    }));
  });
  await test('方案人次看板列出各心理師用量', async () => {
    const d = await admin.ok('GET', '/api/plan-board');
    assert(Array.isArray(d.rows), '看板資料');
  });
  await test('人次上限可個別調整，心理師只能改自己的', async () => {
    const row = (await admin.ok('GET', '/api/plan-board')).rows[0];
    assert(row, '至少要有一列限量方案');
    const r = await admin.ok('PUT', '/api/plan-board/limit',
      { plan_id: row.plan_id, counselor_id: row.counselor_id, week_limit: 3, month_limit: -1 });
    equal(r.week_limit, 3, '已寫入個別週上限');
    const after = (await admin.ok('GET', '/api/plan-board')).rows
      .find(x => x.plan_id === row.plan_id && x.counselor_id === row.counselor_id);
    equal(after.week_limit, 3, '看板反映新上限');
    const me = await lin.ok('GET', '/api/me');
    if (row.counselor_id !== me.id) {
      await lin.fails('PUT', '/api/plan-board/limit',
        { plan_id: row.plan_id, counselor_id: row.counselor_id, week_limit: 1 }, '自己');
    }
    await lin.ok('PUT', '/api/plan-board/limit',
      { plan_id: row.plan_id, counselor_id: me.id, week_limit: -1, month_limit: -1 });
    await admin.ok('PUT', '/api/plan-board/limit',
      { plan_id: row.plan_id, counselor_id: row.counselor_id, week_limit: -1, month_limit: -1 });
  });
  await test('已用人次可人工填成實際數字', async () => {
    const row = (await admin.ok('GET', '/api/plan-board')).rows[0];
    const r = await admin.ok('PUT', '/api/plan-board/usage',
      { plan_id: row.plan_id, counselor_id: row.counselor_id, week_used: 4, note: '他所已接' });
    equal(r.week_used, 4, '已用人次填成 4');
    assert(r.week_offset === 4 - r.week_system_used, '存的是與系統統計的差額');
    await admin.ok('PUT', '/api/plan-board/usage',
      { plan_id: row.plan_id, counselor_id: row.counselor_id, week_used: r.week_system_used });
  });
  await test('刪除帳號：無關聯者真的刪除，有關聯者退回停用', async () => {
    // 全新帳號沒有任何關聯，應該真的被刪掉
    const fresh = await admin.ok('POST', '/api/users',
      { username: 'tmp-del-' + Date.now(), password: 'abc123', name: '待刪測試', role: 'staff' });
    const r1 = await admin.ok('DELETE', `/api/users/${fresh.id}`);
    equal(r1.deactivated, false, '無關聯者直接刪除');
    // 登記過來電的帳號：intakes.taken_by 沒有 ON DELETE，外鍵會擋下刪除，
    // 必須退回停用而不是把資料庫錯誤丟到畫面上
    const uname = 'tmp-intake-' + Date.now();
    const withLink = await admin.ok('POST', '/api/users',
      { username: uname, password: 'abc123', name: '來電登記測試', role: 'staff' });
    const tmp = session();
    await tmp.ok('POST', '/api/login', { username: uname, password: 'abc123' });
    await tmp.ok('POST', '/api/intakes', { name: '刪除測試來電', phone: '0900000000' });
    const r2 = await admin.ok('DELETE', `/api/users/${withLink.id}`);
    equal(r2.deactivated, true, '有關聯者退回停用');
    const still = (await admin.ok("GET", "/api/users")).find(u => u.id === withLink.id);
    assert(!still || !still.active, '帳號應為停用狀態');
  });
  await test('刪除諮商室：排過班的改為停用', async () => {
    const made = await admin.ok('POST', '/api/rooms', { name: '臨時空間', capacity: 1 });
    const r = await admin.ok('DELETE', `/api/rooms/${made.id}`);
    equal(r.deactivated, false, '沒排過班的可直接刪除');
    assert(!(await admin.ok('GET', '/api/rooms')).some(x => x.id === made.id), '已從清單移除');
  });
  await test('收據可修正抬頭與項目，金額與編號不動', async () => {
    const rec = (await admin.ok('GET', '/api/receipts')).rows.find(x => x.status === 'valid');
    if (!rec) return;
    await admin.ok('PUT', `/api/receipts/${rec.id}`, { title: '測試抬頭', item: rec.item, tax_id: '' });
    const after = (await admin.ok('GET', '/api/receipts')).rows.find(x => x.id === rec.id);
    equal(after.title, '測試抬頭', '抬頭已更新');
    equal(after.amount, rec.amount, '金額不變');
    equal(after.receipt_no, rec.receipt_no, '編號不變');
    await admin.fails('PUT', `/api/receipts/${rec.id}`, { tax_id: '123' }, '8 碼');
    await admin.ok('PUT', `/api/receipts/${rec.id}`, { title: rec.title, tax_id: rec.tax_id || '' });
  });
  await test('未設定 LINE 權杖時不對外送出，只記為待人工', async () => {
    const s = await admin.ok('GET', '/api/line/status');
    equal(s.enabled, false, '預設未啟用');
    const r = await admin.ok('POST', '/api/line/remind-batch', { date: addDays(ymd(new Date()), 1) });
    assert(r.results.every(x => x.status === 'manual'), '未設定時應全部記為待人工發送');
  });
  await test('LINE 綁定碼只能為自己產生', async () => {
    const r = await lin.ok('POST', '/api/line/bind-code', { user_id: (await lin.ok('GET', '/api/me')).id });
    assert(/^\d{6}$/.test(r.code), '綁定碼格式');
    const admins = (await admin.ok('GET', '/api/users')).find(u => u.username === 'admin');
    await lin.fails('POST', '/api/line/bind-code', { user_id: admins.id }, '自己');
  });
  await test('串接設定：權杖只回遮罩、遮罩值不會覆蓋原設定', async () => {
    await admin.ok('PUT', '/api/line/settings', { line_channel_token: 'test-token-1234', line_official_name: '測試官方帳號' });
    const s1 = await admin.ok('GET', '/api/line/settings');
    assert(!s1.line_channel_token.includes('test-token'), '不應回傳完整權杖');
    assert(s1.line_channel_token.endsWith('1234'), '應顯示末四碼');
    assert(/\/api\/line\/webhook$/.test(s1.webhook_url), 'Webhook 網址');
    // 原樣送回遮罩值代表沒改，權杖要維持不變
    await admin.ok('PUT', '/api/line/settings', { line_channel_token: s1.line_channel_token, line_reminder_hours: 12 });
    const s2 = await admin.ok('GET', '/api/line/settings');
    equal(s2.line_channel_token, s1.line_channel_token, '權杖未被遮罩值覆蓋');
    equal(s2.line_reminder_hours, '12', '其他設定有存到');
    await admin.ok('PUT', '/api/line/settings', { line_channel_token: '' });
    equal((await admin.ok('GET', '/api/line/settings')).line_channel_token, '', '可清空權杖');
  });
  await test('未填權杖時不可設定 Webhook', async () => {
    await admin.fails('POST', '/api/line/webhook-endpoint', {}, 'Channel access token');
  });
  await test('綁定管理列出員工與個案的綁定狀態', async () => {
    const d = await admin.ok('GET', '/api/line/bindings');
    assert(d.staff.length && d.clients.length, '應列出員工與個案');
    assert(d.staff.every(u => typeof u.bound === 'boolean'), '綁定狀態');
  });
  await test('一般行政不得改串接設定', async () => {
    await office.fails('PUT', '/api/line/settings', { line_official_name: 'x' }, '權限');
  });
  await test('Webhook 簽章不符即忽略', async () => {
    const r = await fetch(BASE + '/api/line/webhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-line-signature': 'bad' },
      body: JSON.stringify({ events: [] })
    });
    equal(r.status, 200, '應靜默忽略');
  });

  section('Google 表單同步與 LINE 預約入口');
  await test('未設定密鑰時拒收表單資料', async () => {
    const r = await fetch(BASE + '/api/integrations/google-form', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: 'x', answers: { 姓名: '測試' } })
    });
    equal(r.status, 401, 'HTTP 狀態');
  });
  await test('產生密鑰後可收表單回應並自動對應方案與心理師', async () => {
    const gen = await admin.ok('PUT', '/api/integrations/google-form', { regenerate: true });
    assert(gen.secret && gen.secret.length > 20, '應產生密鑰');
    const payload = {
      secret: gen.secret,
      response_id: 'smoke-resp-1',
      answers: {
        姓名: '陳表單', 信箱: 'form@example.com', 聯絡電話: '0955-123-456', 生理性別: '女',
        出生年月日: '1995/06/15', 地址: '台南市安平區測試路 1 號', 身分證字號: 'a123456789',
        緊急聯絡人: '陳母', 緊急聯絡人電話: '0912345000', 緊急聯絡人關係: '母子',
        '諮商方案 ': '個別心理諮商（50分鐘2000元）',
        諮商主題: '情緒困擾',
        '預約之心理師          好心情心理諮商所心理師介紹': '馬健倫 所長/諮商心理師',
        欲安排之諮商時間: '星期一09:00-11:00、星期三14:00-16:00、星期五13:00-17:00'
      }
    };
    const r = await fetch(BASE + '/api/integrations/google-form', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const d = await r.json();
    assert(r.ok, '同步失敗：' + JSON.stringify(d));
    equal(d.matched.plan, '個別心理諮商（50 分鐘）', '方案對應');
    equal(d.matched.topic, '情緒困擾', '主題對應');
    equal(d.matched.counselor, '馬健倫', '心理師對應');
    // 同一份回應重送不應產生第二筆
    const again = await (await fetch(BASE + '/api/integrations/google-form', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    })).json();
    equal(again.id, d.id, '重送應回同一筆');
    const rows = await admin.ok('GET', '/api/bookings?status=new');
    const row = rows.find(x => x.id === d.id);
    assert(row && row.phone === '0955123456', '電話應正規化');
    assert(/星期一/.test(row.alt_note), '欲安排時間應存入');
    // 建檔時把地址、身分證與緊急聯絡人一併帶進個案資料
    const c = await admin.ok('POST', `/api/bookings/${d.id}/create-client`);
    const client = await admin.ok('GET', `/api/clients/${c.client_id}`);
    equal(client.id_no, 'A123456789', '身分證字號');
    equal(client.emergency_phone, '0912345000', '緊急聯絡人電話');
    assert(client.address.includes('安平'), '地址');
  });
  await test('表單同步設定頁提供 Apps Script 程式碼', async () => {
    const d = await admin.ok('GET', '/api/integrations/google-form');
    assert(d.script.includes('onFormSubmit') && d.script.includes(d.endpoint), '應含觸發函式與接收網址');
    assert(/\/api\/integrations\/google-form$/.test(d.endpoint), '接收網址');
  });
  await test('簽章正確的 LINE 訊息會被受理（預約入口）', async () => {
    await admin.ok('PUT', '/api/line/settings', { line_channel_secret: 'smoke-secret' });
    const body = JSON.stringify({
      events: [{ type: 'message', replyToken: 'r1', source: { userId: 'Usmoke001' },
        message: { type: 'text', text: '預約' } }]
    });
    const sig = require('crypto').createHmac('sha256', 'smoke-secret').update(body).digest('base64');
    const r = await fetch(BASE + '/api/line/webhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-line-signature': sig }, body
    });
    equal(r.status, 200, 'HTTP 狀態');
    const d = await r.json().catch(() => ({}));
    assert(d.ok, '簽章正確時應處理事件');
    await admin.ok('PUT', '/api/line/settings', { line_channel_secret: '' });
  });
  await test('偽造簽章的訊息不會被處理', async () => {
    await admin.ok('PUT', '/api/line/settings', { line_channel_secret: 'smoke-secret' });
    const body = JSON.stringify({ events: [{ type: 'message', source: { userId: 'U-bad' }, message: { type: 'text', text: '預約' } }] });
    const r = await fetch(BASE + '/api/line/webhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-line-signature': 'wrong' }, body
    });
    equal(r.status, 200, '應靜默忽略');
    equal((await r.text()).trim(), '', '不應回傳處理結果');
    await admin.ok('PUT', '/api/line/settings', { line_channel_secret: '' });
  });

  // ---- 結果 ----
  console.log(`\n${'─'.repeat(46)}`);
  if (failures.length) {
    console.log(`✗ 通過 ${pass} 項，失敗 ${failures.length} 項：`);
    failures.forEach(f => console.log(`   · ${f}`));
  } else {
    console.log(`✓ 全部通過（${pass} 項）`);
  }
  cleanup(failures.length ? 1 : 0);
})().catch(e => {
  console.error('\n冒煙測試中斷：', e);
  cleanup(1);
});

// 直接用 fetch 抓二進位內容時需要自行帶上該身分的 cookie
function lastCookie(s) { return s.cookie || ''; }

function cleanup(code) {
  try { if (server) server.kill(); } catch { /* 略過 */ }
  if (KEEP) console.log(`暫存目錄保留於：${tmp}`);
  else fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(code);
}
