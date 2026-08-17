// API 呼叫共用：自動處理 JSON、錯誤訊息、401 導回登入
async function api(path, options = {}) {
  const opts = { headers: {}, credentials: 'same-origin', ...options };
  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch('/api' + path, opts);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401 && window.App && App.onUnauthorized) App.onUnauthorized();
    throw new Error((data && data.error) || '操作失敗，請稍後再試');
  }
  return data;
}
const GET = p => api(p);
const POST = (p, body) => api(p, { method: 'POST', body });
const PUT = (p, body) => api(p, { method: 'PUT', body });
const DEL = p => api(p, { method: 'DELETE' });
