// pm2 啟動設定：正式站以此檔為準，避免忘了帶時區等環境變數。
//   pm2 start ecosystem.config.js        首次啟動
//   pm2 restart goodmoodpsy --update-env 套用此檔的環境變數
module.exports = {
  apps: [{
    name: 'goodmoodpsy',
    script: 'src/server.js',
    cwd: __dirname,
    env: {
      NODE_ENV: 'production',
      PORT: 3340,
      // 主機時區是 UTC；不設這個，資料庫寫入的時間會少 8 小時
      TZ: 'Asia/Taipei'
    },
    max_restarts: 10,
    time: true
  }]
};
