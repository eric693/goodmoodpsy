const { db, getSetting, audit } = require('./db');

// 對外提醒發送。
// 台灣諮商所實務上以簡訊或 LINE 通知個案，各家服務商 API 不同，
// 因此這裡走一個通用 webhook：所方在系統設定填入自家簡訊商／LINE Bot 的接收網址，
// 系統以 JSON POST 過去，由該端負責實際發送。
// 未設定網址時不對外送出任何個資，只把訊息記為「待人工發送」，行為與原本相同。
//
// 送出內容刻意只帶姓名、電話與訊息本文，不含晤談紀錄等敏感欄位。

async function sendNotification({ kind = 'reminder', client_id = null, appointment_id = null,
  target = '', content = '', user = null }) {
  const url = getSetting('notify_webhook_url', '').trim();
  const token = getSetting('notify_webhook_token', '').trim();
  const insert = (channel, status, error) => db.prepare(`INSERT INTO notifications
    (kind, client_id, appointment_id, channel, target, content, status, error, sent_by)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(kind, client_id, appointment_id, channel, target, content,
    status, error, user ? user.id : null).lastInsertRowid;

  if (!url) {
    insert('manual', 'manual', '');
    return { channel: 'manual', status: 'manual', message: '未設定發送通道，已記錄為人工發送' };
  }
  if (!target) {
    insert('webhook', 'failed', '個案未留聯絡電話');
    return { channel: 'webhook', status: 'failed', message: '個案未留聯絡電話，未送出' };
  }

  try {
    // 逾時 10 秒即放棄，避免櫃檯畫面卡住
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ kind, to: target, message: content }),
      signal: ctl.signal
    });
    clearTimeout(timer);
    if (!resp.ok) {
      const body = (await resp.text().catch(() => '')).slice(0, 200);
      insert('webhook', 'failed', `HTTP ${resp.status} ${body}`);
      return { channel: 'webhook', status: 'failed', message: `發送失敗（HTTP ${resp.status}）` };
    }
    insert('webhook', 'sent', '');
    if (user) audit('staff', user.id, user.name, '發送提醒', String(client_id || ''), { kind });
    return { channel: 'webhook', status: 'sent', message: '已送出' };
  } catch (e) {
    const msg = e.name === 'AbortError' ? '連線逾時' : String(e.message || e).slice(0, 200);
    insert('webhook', 'failed', msg);
    return { channel: 'webhook', status: 'failed', message: `發送失敗：${msg}` };
  }
}

module.exports = { sendNotification };
