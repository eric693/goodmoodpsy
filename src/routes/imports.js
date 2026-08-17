const express = require('express');
const multer = require('multer');
const { db, audit } = require('../db');
const { requireStaff } = require('../auth');
const { listImports, getImport, buildContext, validate } = require('../imports');
const { readTable } = require('../xlsx-read');
const { buildWorkbook } = require('../xlsx');

const router = express.Router();

// 匯入流程：範本下載 → 上傳預覽（不寫入）→ 確認匯入。
// 檔案存在記憶體不落地：匯入用的原始檔含個案個資，處理完即釋放，不留在硬碟上。
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 }
});

function handleUpload(req, res, next) {
  upload.single('file')(req, res, err => {
    if (!err) return next();
    const msg = err.code === 'LIMIT_FILE_SIZE' ? '檔案不可超過 10 MB' : (err.message || '上傳失敗');
    res.status(400).json({ error: msg });
  });
}

// 匯入權限跟著各自的模組走：能建個案的人才能匯入個案名冊
function requireImport(req, res, next) {
  const def = getImport(req.params.key);
  if (!def) return res.status(404).json({ error: '找不到此匯入項目' });
  req.importDef = def;
  return requireStaff(def.module)(req, res, next);
}

router.get('/imports', requireStaff(), (req, res) => {
  // 只列出使用者有權限的項目，避免點進去才被擋
  res.json(listImports().filter(i => req.user.role === 'admin' || req.userModules.includes(i.module)));
});

// 範本：表頭 + 兩列範例資料，讓所方直接把舊資料貼進來
router.get('/imports/:key/template', requireImport, (req, res) => {
  const def = req.importDef;
  const columns = def.columns.map(c => ({ key: c.key, label: c.label + (c.required ? '（必填）' : '') }));
  const rows = (def.sample || []).map(s => {
    const row = {};
    for (const c of def.columns) row[c.key] = s[c.key] ?? '';
    return row;
  });
  const buf = buildWorkbook(def.title, columns, rows);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="mindcare_import_${def.key}.xlsx"; filename*=UTF-8''${encodeURIComponent(def.title)}.xlsx`);
  res.send(buf);
});

// 預覽：完全不寫入資料庫，只回報每一列的驗證結果
router.post('/imports/:key/preview', requireImport, handleUpload, (req, res) => {
  const def = req.importDef;
  if (!req.file) return res.status(400).json({ error: '請選擇檔案' });
  let table;
  try {
    table = readTable(req.file.buffer, req.file.originalname || '');
  } catch (e) {
    return res.status(400).json({ error: e.message || '檔案無法讀取' });
  }
  if (!table.header.length) return res.status(400).json({ error: '檔案沒有可辨識的表頭' });
  if (!table.rows.length) return res.status(400).json({ error: '檔案沒有資料列' });
  if (table.rows.length > 5000) return res.status(400).json({ error: '單次匯入請勿超過 5000 列，請分批處理' });

  const result = validate(def, table, buildContext());
  if (result.fatal) return res.status(400).json({ error: result.fatal, unknown: result.unknown });
  res.json(result);
});

// 確認匯入：重新讀檔並重新驗證，不信任前端送回的資料。
// 有任何一列錯誤即整批拒絕，避免留下匯入到一半的殘缺資料。
router.post('/imports/:key/commit', requireImport, handleUpload, (req, res) => {
  const def = req.importDef;
  if (!req.file) return res.status(400).json({ error: '請選擇檔案' });
  const mode = req.body && req.body.mode === 'update' ? 'update' : 'skip';
  if (mode === 'update' && !def.update) {
    return res.status(400).json({ error: '此項目不支援更新既有資料' });
  }

  let table;
  try {
    table = readTable(req.file.buffer, req.file.originalname || '');
  } catch (e) {
    return res.status(400).json({ error: e.message || '檔案無法讀取' });
  }
  const ctx = buildContext();
  const result = validate(def, table, ctx);
  if (result.fatal) return res.status(400).json({ error: result.fatal });

  const bad = result.rows.filter(r => r.errors.length);
  if (bad.length) {
    return res.status(400).json({
      error: `有 ${bad.length} 列資料有誤，已取消整批匯入`,
      rows: bad.slice(0, 20)
    });
  }

  let inserted = 0, updated = 0, skipped = 0;
  try {
    db.transaction(() => {
      for (const r of result.rows) {
        if (r.existing) {
          if (mode === 'update') { def.update(r.existing, r.data, ctx); updated++; }
          else skipped++;
        } else {
          def.insert(r.data, ctx);
          inserted++;
        }
      }
    })();
  } catch (e) {
    // 交易已整批回滾，資料庫維持匯入前的狀態
    return res.status(400).json({ error: `匯入失敗，已全部回復：${e.message}` });
  }

  audit('staff', req.user.id, req.user.name, '匯入資料', def.title,
    { mode, inserted, updated, skipped, total: result.rows.length });
  res.json({ ok: true, inserted, updated, skipped, total: result.rows.length });
});

module.exports = router;
