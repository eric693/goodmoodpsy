// .xlsx 讀取器（與 src/xlsx.js 的產生器成對，同樣零外部相依）。
//
// xlsx 是一個 ZIP，內含：
//   xl/workbook.xml           工作表清單
//   xl/worksheets/sheetN.xml  儲存格資料
//   xl/sharedStrings.xml      字串共用表（儲存格 t="s" 時值是這裡的索引）
// 這裡只做「讀出表格文字」需要的最小實作：ZIP 解壓（stored 與 deflate）＋三個 XML 的解析。
//
// 廟方手上的舊資料幾乎都是 Excel，要求他們另存 CSV 常會遇到編碼與換行問題，
// 所以寧可自己讀 xlsx；CSV 仍然支援，兩者共用同一套匯入流程。
const zlib = require('zlib');

// ---- ZIP ----

// 由中央目錄尾端記錄往回找，比逐一掃描本地檔頭可靠（檔案可能有前置資料）
function findEndOfCentralDirectory(buf) {
  const min = Math.max(0, buf.length - 66 * 1024);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function unzip(buf) {
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd < 0) throw new Error('檔案不是有效的 Excel（.xlsx）格式');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  const files = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);

    // 本地檔頭的 extra 長度可能與中央目錄不同，資料位置要以本地檔頭為準
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);

    if (method === 0) files[name] = raw;
    else if (method === 8) files[name] = zlib.inflateRawSync(raw);
    // 其他壓縮方式（如 bzip2）Excel 不會產生，略過即可

    offset += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// ---- XML ----

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function decodeXml(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] !== undefined ? ENTITIES[e] : m;
  });
}

// sharedStrings：一個 <si> 是一個字串，內部可能被切成多個 <t>（含格式時）
function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let si;
  while ((si = siRe.exec(xml))) {
    let text = '';
    const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tRe.exec(si[1]))) text += decodeXml(t[1]);
    out.push(text);
  }
  return out;
}

// 'BC12' → { col: 54, row: 12 }（col 由 0 起算）
function parseRef(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref || '');
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(m[2]) };
}

// Excel 日期序號 → YYYY-MM-DD。1900 系統，且 Excel 誤把 1900 當閏年，故基準取 1899-12-30
function serialToDate(n) {
  const days = Math.floor(n);
  if (!(days > 0) || days > 2958465) return null;
  const d = new Date(Date.UTC(1899, 11, 30) + days * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// 判斷哪些 style 是日期格式：儲存格只存序號，要靠 numFmt 才知道它是不是日期
function parseDateStyles(stylesXml) {
  const dateStyles = new Set();
  if (!stylesXml) return dateStyles;
  // 內建的日期格式代號（14–22 為各式日期時間，27–36、45–58 為地區日期格式）
  const builtinDate = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
    45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
  const customDate = new Set();
  const fmtRe = /<numFmt[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g;
  let f;
  while ((f = fmtRe.exec(stylesXml))) {
    const code = decodeXml(f[2]);
    // 有年月日字樣又沒有百分比與貨幣符號的，視為日期
    if (/[yYmMdD]/.test(code) && !/[%$]/.test(code)) customDate.add(Number(f[1]));
  }
  const xfBlock = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml);
  if (!xfBlock) return dateStyles;
  const xfRe = /<xf[^>]*numFmtId="(\d+)"[^>]*\/?>/g;
  let xf, idx = 0;
  while ((xf = xfRe.exec(xfBlock[1]))) {
    const id = Number(xf[1]);
    if (builtinDate.has(id) || customDate.has(id)) dateStyles.add(idx);
    idx++;
  }
  return dateStyles;
}

// 解析單一工作表為二維陣列（全部轉為字串，交給匯入定義各自轉型）
function parseSheet(xml, shared, dateStyles) {
  const rows = [];
  const rowRe = /<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  let r;
  while ((r = rowRe.exec(xml))) {
    const rowNo = Number(r[1]);
    const cells = [];
    // 空白儲存格寫成自閉合的 <c .../>；必須先試自閉合，否則 <c ...> 那條會一路吃到
    // 下一個 </c>，把後面好幾格併成一格（Google 試算表匯出的檔滿是空白格，必踩）
    const cellRe = /<c([^>]*?)\/>|<c([^>]*)>([\s\S]*?)<\/c>/g;
    let c;
    while ((c = cellRe.exec(r[2]))) {
      const attrs = c[1] !== undefined ? c[1] : (c[2] || '');
      const inner = c[3] || '';
      const ref = /r="([A-Z]+\d+)"/.exec(attrs);
      const pos = ref ? parseRef(ref[1]) : null;
      const type = (/t="([^"]+)"/.exec(attrs) || [])[1] || 'n';
      const styleIdx = Number((/s="(\d+)"/.exec(attrs) || [])[1] || -1);

      let value = '';
      if (type === 'inlineStr') {
        const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
        let t;
        while ((t = tRe.exec(inner))) value += decodeXml(t[1]);
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        const raw = v ? decodeXml(v[1]) : '';
        if (type === 's') value = shared[Number(raw)] ?? '';
        else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
        else if (type === 'str' || type === 'e') value = raw;
        else {
          // 數字：若套用了日期格式就轉成日期字串，否則保留原樣（避免把電話號碼變成科學記號）
          value = raw;
          if (raw !== '' && dateStyles.has(styleIdx)) {
            const d = serialToDate(Number(raw));
            if (d) value = d;
          }
        }
      }
      if (pos) cells[pos.col] = value;
      else cells.push(value);
    }
    // 保留列號，錯誤訊息才能指出「第幾列」與 Excel 一致
    rows.push({ row_no: rowNo, cells: Array.from(cells, x => (x === undefined ? '' : String(x).trim())) });
  }
  return rows;
}

// 讀取第一個工作表；回傳 { header: [...], rows: [{ row_no, cells }] }
function readXlsx(buf) {
  const files = unzip(buf);
  const shared = parseSharedStrings(files['xl/sharedStrings.xml'] && files['xl/sharedStrings.xml'].toString('utf8'));
  const dateStyles = parseDateStyles(files['xl/styles.xml'] && files['xl/styles.xml'].toString('utf8'));

  // 依 workbook 的順序取第一張工作表；找不到就退回 sheet1.xml
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const wb = files['xl/workbook.xml'] && files['xl/workbook.xml'].toString('utf8');
  const rels = files['xl/_rels/workbook.xml.rels'] && files['xl/_rels/workbook.xml.rels'].toString('utf8');
  if (wb && rels) {
    const firstSheet = /<sheet[^>]*r:id="([^"]+)"/.exec(wb);
    if (firstSheet) {
      const rel = new RegExp(`<Relationship[^>]*Id="${firstSheet[1]}"[^>]*Target="([^"]+)"`).exec(rels);
      if (rel) {
        const target = rel[1].replace(/^\/?xl\//, '').replace(/^\//, '');
        if (files[`xl/${target}`]) sheetPath = `xl/${target}`;
      }
    }
  }
  if (!files[sheetPath]) throw new Error('Excel 檔中找不到工作表資料');

  const all = parseSheet(files[sheetPath].toString('utf8'), shared, dateStyles);
  const firstNonEmpty = all.findIndex(r => r.cells.some(c => c !== ''));
  if (firstNonEmpty < 0) return { header: [], rows: [] };
  return {
    header: all[firstNonEmpty].cells,
    rows: all.slice(firstNonEmpty + 1).filter(r => r.cells.some(c => c !== ''))
  };
}

// 讀取「所有」工作表；回傳 [{ name, rows: [{ row_no, cells }] }]，順序同 Excel 的分頁順序。
// 諮商室使用表這類一週一張分頁的檔案要靠這個一次讀完，分頁名稱本身就是週次。
function readSheets(buf) {
  const files = unzip(buf);
  const shared = parseSharedStrings(files['xl/sharedStrings.xml'] && files['xl/sharedStrings.xml'].toString('utf8'));
  const dateStyles = parseDateStyles(files['xl/styles.xml'] && files['xl/styles.xml'].toString('utf8'));
  const wb = files['xl/workbook.xml'] && files['xl/workbook.xml'].toString('utf8');
  const rels = files['xl/_rels/workbook.xml.rels'] && files['xl/_rels/workbook.xml.rels'].toString('utf8');
  if (!wb || !rels) return [{ name: '', rows: parseSheet(files['xl/worksheets/sheet1.xml'].toString('utf8'), shared, dateStyles) }];

  const out = [];
  for (const m of wb.matchAll(/<sheet[^>]*>/g)) {
    const name = decodeXml((/name="([^"]*)"/.exec(m[0]) || [])[1] || '');
    const rid = (/r:id="([^"]+)"/.exec(m[0]) || [])[1];
    if (!rid) continue;
    const rel = new RegExp(`<Relationship[^>]*Id="${rid}"[^>]*Target="([^"]+)"`).exec(rels);
    if (!rel) continue;
    const path = 'xl/' + rel[1].replace(/^\/?xl\//, '').replace(/^\//, '');
    if (!files[path]) continue;
    out.push({ name, rows: parseSheet(files[path].toString('utf8'), shared, dateStyles) });
  }
  return out;
}

// ---- CSV ----
// 支援引號跳脫與欄位內換行；BOM 一併去除（Excel 另存 CSV 會加）
function readCsv(buf) {
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows = [];
  let cell = '', row = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }

  const withNo = rows.map((cells, i) => ({ row_no: i + 1, cells: cells.map(c => c.trim()) }));
  const firstNonEmpty = withNo.findIndex(r => r.cells.some(c => c !== ''));
  if (firstNonEmpty < 0) return { header: [], rows: [] };
  return {
    header: withNo[firstNonEmpty].cells,
    rows: withNo.slice(firstNonEmpty + 1).filter(r => r.cells.some(c => c !== ''))
  };
}

// 依副檔名或內容判斷格式；xlsx 一定以 PK 開頭
function readTable(buf, filename = '') {
  const isZip = buf.length > 2 && buf[0] === 0x50 && buf[1] === 0x4b;
  if (isZip || /\.xlsx$/i.test(filename)) return readXlsx(buf);
  if (/\.xls$/i.test(filename)) {
    throw new Error('舊版 .xls 格式不支援，請於 Excel 另存為 .xlsx 或 CSV 後再匯入');
  }
  return readCsv(buf);
}

module.exports = { readTable, readXlsx, readSheets, readCsv, serialToDate };
