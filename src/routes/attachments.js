const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { db, audit, getSetting } = require('../db');
const { requireStaff, requireClient, canViewClientNotes } = require('../auth');

const router = express.Router();

// 個案附件：轉介單、診斷證明、同意書掃描、心理衡鑑報告等。
// 安全考量：
//   1. 檔名一律改成隨機字串落地，原始檔名只存資料庫，避免路徑穿越與同名覆蓋。
//   2. 副檔名與 MIME 都要在白名單內，不接受可執行檔。
//   3. 下載走 API 並檢查權限，uploads 目錄不對外開放靜態存取。
//   4. 個案端只看得到被明確標記「開放個案端下載」且屬於自己的檔案。

const { UPLOAD_DIR } = require('../db');

// 附件多屬行政層（轉介單、同意書掃描），有個案管理權限者即可存取；
// 但臨床層的文件內容等同晤談紀錄，須比照保密邊界只開放主責心理師、督導與管理者。
const CLINICAL_KINDS = ['衡鑑報告', '晤談紀錄', '心理衡鑑報告'];
function attachmentAllowed(user, a) {
  if (!CLINICAL_KINDS.includes(a.kind)) return true;
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(a.client_id);
  return !!c && canViewClientNotes(user, c);
}

const ALLOWED = {
  '.pdf': ['application/pdf'],
  '.jpg': ['image/jpeg'], '.jpeg': ['image/jpeg'], '.png': ['image/png'],
  '.gif': ['image/gif'], '.webp': ['image/webp'], '.heic': ['image/heic'],
  '.doc': ['application/msword'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.xls': ['application/vnd.ms-excel'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  '.txt': ['text/plain']
};
const MAX_MB = 20;

// multipart 的檔名欄位由 busboy 以 latin1 解出，中文檔名會變亂碼，需自行轉回 UTF-8。
// 已經是純 ASCII 的檔名轉換後不變，故可無條件套用。
function decodeFilename(name) {
  try {
    const utf8 = Buffer.from(name, 'latin1').toString('utf8');
    return utf8.includes('�') ? name : utf8;
  } catch { return name; }
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(decodeFilename(file.originalname)).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(decodeFilename(file.originalname)).toLowerCase();
    if (!ALLOWED[ext]) return cb(new Error(`不支援的檔案類型（${ext || '無副檔名'}）`));
    // 瀏覽器送出的 MIME 不完全可信，但明顯不符時先擋下
    if (file.mimetype && !ALLOWED[ext].includes(file.mimetype) && file.mimetype !== 'application/octet-stream') {
      return cb(new Error('檔案類型與副檔名不符'));
    }
    cb(null, true);
  }
});

// multer 的錯誤要轉成一致的 JSON 格式，否則前端只會看到 500
function handleUpload(req, res, next) {
  upload.single('file')(req, res, err => {
    if (!err) return next();
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `檔案不可超過 ${MAX_MB} MB` : (err.message || '上傳失敗');
    res.status(400).json({ error: msg });
  });
}

// 原始檔名可能含有引號或非 ASCII，需同時給 filename 與 filename*
function contentDisposition(name, inline) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function sendFile(res, row, inline) {
  const full = path.join(UPLOAD_DIR, path.basename(row.stored_name));
  if (!fs.existsSync(full)) return res.status(404).json({ error: '檔案已不存在，請重新上傳' });
  res.setHeader('Content-Type', row.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', contentDisposition(row.filename, inline));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  fs.createReadStream(full).pipe(res);
}

// ---- 所內 ----

router.get('/clients/:id/attachments', requireStaff('clients'), (req, res) => {
  const rows = db.prepare(`SELECT a.*, u.name AS uploader_name FROM attachments a
    LEFT JOIN users u ON u.id = a.uploaded_by
    WHERE a.client_id = ? ORDER BY a.id DESC`).all(req.params.id);
  // 臨床類附件（如衡鑑報告）在清單就先濾掉，不會出現看得到卻下載不了的情況
  res.json(rows.filter(a => attachmentAllowed(req.user, a)));
});

router.post('/clients/:id/attachments', requireStaff('clients'), handleUpload, (req, res) => {
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  const cleanup = () => { if (req.file) fs.unlink(path.join(UPLOAD_DIR, req.file.filename), () => {}); };
  if (!c) { cleanup(); return res.status(404).json({ error: '找不到此個案' }); }
  if (!req.file) return res.status(400).json({ error: '請選擇檔案' });
  const b = req.body || {};
  const info = db.prepare(`INSERT INTO attachments
    (client_id, kind, filename, stored_name, mime, size, note, visible_to_client, uploaded_by)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    c.id, b.kind || '其他', decodeFilename(req.file.originalname), req.file.filename,
    req.file.mimetype || '', req.file.size, b.note || '',
    b.visible_to_client === '1' || b.visible_to_client === 'true' ? 1 : 0, req.user.id);
  const shownName = decodeFilename(req.file.originalname);
  audit('staff', req.user.id, req.user.name, '上傳附件', c.code, { file: shownName, size: req.file.size });
  res.json({ id: info.lastInsertRowid, filename: shownName, size: req.file.size });
});

router.get('/attachments/:id/download', requireStaff('clients'), (req, res) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: '找不到此附件' });
  if (!attachmentAllowed(req.user, a)) {
    return res.status(403).json({ error: '此類附件僅限主責心理師、督導與管理者存取' });
  }
  audit('staff', req.user.id, req.user.name, '下載附件', String(a.client_id), { file: a.filename });
  sendFile(res, a, req.query.inline === '1');
});

router.put('/attachments/:id', requireStaff('clients'), (req, res) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: '找不到此附件' });
  const b = req.body || {};
  db.prepare('UPDATE attachments SET kind = ?, note = ?, visible_to_client = ? WHERE id = ?').run(
    b.kind || a.kind, b.note === undefined ? a.note : b.note,
    b.visible_to_client === undefined ? a.visible_to_client : (b.visible_to_client ? 1 : 0), a.id);
  audit('staff', req.user.id, req.user.name, '修改附件資訊', String(a.client_id), { id: a.id });
  res.json({ ok: true });
});

router.delete('/attachments/:id', requireStaff('clients'), (req, res) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: '找不到此附件' });
  db.prepare('DELETE FROM attachments WHERE id = ?').run(a.id);
  // 先刪資料庫再刪檔案：即使檔案刪除失敗也不會留下讀不到檔的孤兒紀錄
  fs.unlink(path.join(UPLOAD_DIR, path.basename(a.stored_name)), () => {});
  audit('staff', req.user.id, req.user.name, '刪除附件', String(a.client_id), { file: a.filename });
  res.json({ ok: true });
});

// ---- 個案端：只看得到開放給自己的檔案 ----

router.get('/portal/attachments', requireClient, (req, res) => {
  res.json(db.prepare(`SELECT id, kind, filename, mime, size, created_at FROM attachments
    WHERE client_id = ? AND visible_to_client = 1 ORDER BY id DESC`).all(req.client.id));
});

router.get('/portal/attachments/:id/download', requireClient, (req, res) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id = ? AND client_id = ? AND visible_to_client = 1')
    .get(req.params.id, req.client.id);
  if (!a) return res.status(404).json({ error: '找不到此檔案' });
  sendFile(res, a, req.query.inline === '1');
});

module.exports = router;
module.exports.UPLOAD_DIR = UPLOAD_DIR;
