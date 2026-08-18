// PWA：註冊 Service Worker、提供「安裝到主畫面」按鈕、新版上線時提示重新載入。
// 員工端與個案端共用這支，差別只在 manifest 與圖示。
(function () {
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      // 部署新版後（sw.js 內容改變）提示使用者重新載入，避免一直停在舊版前端
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) showUpdateBar(sw);
        });
      });
    }).catch(() => { /* 不支援或被瀏覽器阻擋時忽略，網頁功能不受影響 */ });
  });

  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    location.reload();
  });

  function bar(html) {
    const el = document.createElement('div');
    el.style.cssText = `position:fixed;left:12px;right:12px;bottom:12px;z-index:9999;
      background:#0e7c7b;color:#fff;border-radius:10px;padding:12px 14px;font-size:14px;
      display:flex;gap:10px;align-items:center;box-shadow:0 6px 20px rgba(0,0,0,.25);max-width:520px;margin:0 auto`;
    el.innerHTML = html;
    document.body.appendChild(el);
    return el;
  }

  function showUpdateBar(sw) {
    const el = bar(`<span style="flex:1">已有新版本</span>
      <button type="button" style="background:#fff;color:#0e7c7b;border:0;border-radius:6px;padding:5px 12px;font-weight:700">更新</button>
      <button type="button" data-x style="background:transparent;color:#fff;border:0;font-size:18px;line-height:1">×</button>`);
    el.querySelector('button').onclick = () => sw.postMessage('skip-waiting');
    el.querySelector('[data-x]').onclick = () => el.remove();
  }

  // Android／桌面 Chrome：攔下安裝提示，改由我們的按鈕觸發
  let deferred = null;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferred = e;
    if (localStorage.getItem('mc-install-dismissed')) return;
    const el = bar(`<span style="flex:1">把系統加到主畫面，像 App 一樣開啟</span>
      <button type="button" style="background:#fff;color:#0e7c7b;border:0;border-radius:6px;padding:5px 12px;font-weight:700">安裝</button>
      <button type="button" data-x style="background:transparent;color:#fff;border:0;font-size:18px;line-height:1">×</button>`);
    el.querySelector('button').onclick = async () => {
      el.remove();
      deferred.prompt();
      await deferred.userChoice;
      deferred = null;
    };
    el.querySelector('[data-x]').onclick = () => {
      localStorage.setItem('mc-install-dismissed', '1');
      el.remove();
    };
  });

  // iPhone／iPad 沒有安裝事件，只能教使用者用「分享 → 加入主畫面」
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (isIOS && !standalone && !localStorage.getItem('mc-ios-hint')) {
    window.addEventListener('load', () => setTimeout(() => {
      const el = bar(`<span style="flex:1">在 Safari 按下方「分享」→「加入主畫面」，就能像 App 一樣開啟</span>
        <button type="button" data-x style="background:transparent;color:#fff;border:0;font-size:18px;line-height:1">×</button>`);
      el.querySelector('[data-x]').onclick = () => {
        localStorage.setItem('mc-ios-hint', '1');
        el.remove();
      };
    }, 2500));
  }

  // 提供給頁面呼叫的安裝入口（設定頁的「安裝 App」按鈕用）
  window.MCInstall = {
    available: () => !!deferred,
    prompt: async () => {
      if (!deferred) return false;
      deferred.prompt();
      await deferred.userChoice;
      deferred = null;
      return true;
    }
  };
})();
