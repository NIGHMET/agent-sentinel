# 演示图的源文件

`../*.png` 都是这里面的 HTML 用**无头 Chrome** 渲染出来的：

- 不用画图软件、不用 AI 生图，改文案就改这里的 HTML；
- 图里的终端输出是**真跑出来的**（`node test/smoke.mjs`、`node scripts/patrol.mjs`、`node scripts/watch.mjs`），
  只把绝对路径换成了 `./handoff`、`/abs/path/...` 这类占位。

## 重新渲染

```bash
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"   # Windows 默认路径
# macOS: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

render() {   # $1=html 文件名  $2=宽  $3=高  $4=输出文件名
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --no-first-run --no-default-browser-check \
    --user-data-dir=./.chrome-profile \
    --force-device-scale-factor=2 \
    --window-size="$2,$3" "--screenshot=../$4" "file://$PWD/$1"
}

render banner.html       1280 380  banner.png
render architecture.html 1280 560  architecture.png
render terminal.html     1280 1005 terminal-demo.png
render latency.html      1280 540  latency.png
```

`--force-device-scale-factor=2` 出的是 2 倍图，在 GitHub 上缩放后更锐利。
宽高要和 HTML 里 `html,body` 的设定一致，否则会被截断或多出留白。
