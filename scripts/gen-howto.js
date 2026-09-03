// 產生 docs/features.html 的「各模組操作說明」章節。
// 說明文字的唯一來源是各頁 App.page 的 help 陣列（畫面上的「這頁怎麼用」），
// 改了頁面說明後執行：node scripts/gen-howto.js > /tmp/howto.html，再貼回文件對應區塊。
const fs = require('fs'), vm = require('vm');
const sandbox = {};
sandbox.window = sandbox; sandbox.document = { getElementById: () => null, querySelectorAll: () => [], addEventListener() {} };
// 讓未定義的全域（UI、GET…）在載入期怎麼碰都不炸，包含被字串化的情況
const noop = new Proxy(function () {}, {
  get: (t, k) => (k === Symbol.toPrimitive || k === 'toString' || k === Symbol.toStringTag ? () => '' : noop),
  apply: () => noop, construct: () => noop
});
const ctx = vm.createContext(new Proxy(sandbox, {
  has: () => true,
  get: (t, k) => (k in t ? t[k] : noop),
  set: (t, k, v) => { t[k] = v; return true; }
}));
// app.js 要先載入（其他檔案都往 App.page 註冊）
const files = fs.readdirSync('public/js').filter(f => f.endsWith('.js'));
files.sort((a, b) => (a === 'app.js' ? -1 : b === 'app.js' ? 1 : a.localeCompare(b)));
for (const f of files) {
  try { vm.runInContext(fs.readFileSync('public/js/' + f, 'utf8'), ctx, { filename: f }); }
  catch (e) { console.error('（略過 ' + f + '：' + e.message + '）'); }
}
const App = vm.runInContext('App', ctx);
const pages = App.pages, groups = App.navGroups;
const esc = s => String(s).replace(/&(?!\w+;|#)/g, '&amp;');
// 不在左側選單、但從清單點進去會用到的頁面（個案／團體明細等）也要有說明
const listed = new Set(groups.flatMap(g => g.keys));
const extras = Object.keys(pages).filter(k => !listed.has(k) && (pages[k].help || []).length);
const all = groups.concat(extras.length ? [{ label: '從清單點進去的頁面', keys: extras }] : []);
let out = '';
for (const g of all) {
  const items = g.keys.filter(k => pages[k] && (pages[k].help || []).length);
  if (!items.length) continue;
  out += `  <h3>${g.label}</h3>\n`;
  for (const k of items) {
    const p = pages[k];
    out += `  <div class="howto"><h4>${esc(p.title)}${p.sub ? `<span>${esc(p.sub)}</span>` : ''}</h4>\n    <ul>\n`
      + p.help.map(h => `      <li>${esc(h)}</li>`).join('\n') + '\n    </ul></div>\n';
  }
}
process.stdout.write(out);
console.error('頁面數：' + Object.keys(pages).length + '，群組：' + groups.length);
