#!/bin/bash
# 重啟 MindCare 服務。
# 逐一比對 /proc/<pid>/cmdline 而不用 pkill -f：pkill -f 會連帶殺掉
# 指令列剛好含有相同字串的呼叫端 shell，造成腳本自己被中斷。
cd /root/mindcare || exit 1
self=$$
for pid in $(ls /proc | grep -E '^[0-9]+$'); do
  [ "$pid" = "$self" ] && continue
  cmd=$( { tr "\0" " " < "/proc/$pid/cmdline"; } 2>/dev/null ) || continue
  [ -n "$cmd" ] || continue
  case "$cmd" in
    "node /root/mindcare/src/server.js "*|"node src/server.js "*)
      [ "$(readlink -f "/proc/$pid/cwd" 2>/dev/null)" = "/root/mindcare" ] && kill "$pid" ;;
  esac
done

# 等埠號真的釋放再啟動，最多等 10 秒
for _ in $(seq 20); do
  ss -ltn 2>/dev/null | grep -q ':3270 ' || break
  sleep 0.5
done

setsid nohup node src/server.js > data/server.log 2>&1 < /dev/null &
sleep 3
if curl -sf -o /dev/null http://127.0.0.1:3270/; then
  echo "MindCare 已啟動（pid $(ss -ltnp 2>/dev/null | grep ':3270 ' | grep -o 'pid=[0-9]*' | head -1)）"
else
  echo "啟動失敗："; tail -20 data/server.log; exit 1
fi
