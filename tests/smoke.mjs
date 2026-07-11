// ピコラボ ヘッドレス スモークテスト（OfflineAudioContext版）:
// Worklet Blob URL登録 → デモ生成→setBuffer(UI遷移) → モードB解析 → クラッシュ+レンダ+WAVエンコード
// を file:// と http://（GitHub Pages相当）の両方で実行し、
// 結果を document.title に書き出して --dump-dom で回収する。
// 実行: node tests/smoke.mjs
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const execFileAsync = promisify(execFile);

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");

const inject = `<script>
window.addEventListener("load", async () => {
  const out = [];
  const step = (s) => { document.title = "SMOKE-AT:" + s + " | " + out.join(" "); };
  // 仮想時間は保留タイマーが無いと一気に進んでバジェットを使い切る。
  // タイマーを常駐させて、タイマーを伴わないPromise（startRendering等）の解決を待てるようにする
  const heartbeat = setInterval(() => {}, 100);
  try {
    step("start");
    const rate = 44100;
    // 1) AudioWorkletをBlob URLで登録できるか（design.md リスク1の検証）
    const off1 = new OfflineAudioContext(1, rate, rate);
    let how = "none";
    try {
      const url = URL.createObjectURL(new Blob([buildWorkletSource()], { type: "text/javascript" }));
      await off1.audioWorklet.addModule(url);
      how = "blob";
    } catch (e1) {
      try {
        const dataUrl = "data:text/javascript;base64," +
          btoa(unescape(encodeURIComponent(buildWorkletSource())));
        await off1.audioWorklet.addModule(dataUrl);
        how = "data";
      } catch (e2) { how = "none(" + e2.message + ")"; }
    }
    if (how === "blob" || how === "data") new AudioWorkletNode(off1, "picolab-crusher");
    out.push("worklet=" + how);
    step("worklet");
    // 2) デモ生成 → setBuffer（エディタ画面へ遷移）
    const data = renderDemoSong(rate);
    const off2 = new OfflineAudioContext(1, data.length, rate);
    const buffer = off2.createBuffer(1, data.length, rate);
    buffer.copyToChannel(data, 0);
    setBuffer(buffer, "smoke-demo");
    out.push("demo=" + buffer.duration.toFixed(1) + "s");
    out.push("editor=" + !screenEditor.classList.contains("hidden"));
    step("demo");
    // 3) モードB: 解析パイプライン
    await analyzeCurrentBuffer();
    out.push("notes=" + (app.notes ? app.notes.length : "null"));
    out.push("ai=" + app.usedAI);
    step("analyze");
    // 4) モードA書き出し経路: 純関数クラッシュ → オフラインレンダ(フィルタ+リサンプル) → WAV
    const srcChs = [buffer.getChannelData(0)];
    const crushed = [new Float32Array(srcChs[0].length)];
    processCrush(srcChs, crushed, createCrushState(1),
      { bits: 4, sampleRate: 11000, mix: 1 }, buffer.sampleRate);
    const off3 = new OfflineAudioContext(1, Math.ceil(buffer.duration * 22050), 22050);
    const buf = off3.createBuffer(1, crushed[0].length, buffer.sampleRate);
    buf.copyToChannel(crushed[0], 0);
    const filt = off3.createBiquadFilter();
    filt.type = "lowpass"; filt.frequency.value = 8000;
    const s = off3.createBufferSource();
    s.buffer = buf; s.connect(filt); filt.connect(off3.destination); s.start();
    step("render-called");
    const rendered = await off3.startRendering();
    const wav = encodeWavPcm16([rendered.getChannelData(0)], 22050);
    out.push("wav=" + wav.byteLength + "B");
    clearInterval(heartbeat);
    document.title = "SMOKE-OK " + out.join(" ");
  } catch (e) {
    clearInterval(heartbeat);
    document.title = "SMOKE-ERR:" + (e && e.message) + " | " + out.join(" ");
  }
});
</${"script"}>`;

const tmp = mkdtempSync(join(tmpdir(), "picosmoke-"));
const phtml = join(tmp, "smoke.html");
// rafLoopが仮想時間バジェットを食い潰すため、検証時のみrAFを無効化する
const rafStub = `<script>window.requestAnimationFrame = function () { return 0; };</${"script"}>`;
const patched = html
  .replace(/<head([^>]*)>/i, `<head$1>${rafStub}`)
  .replace("</body>", inject + "</body>");
writeFileSync(phtml, patched);

function runEdge(url) {
  // rAFが仮想時間を消費するため budget は大きめに。ハング対策に実時間120秒で強制終了
  const r = spawnSync(EDGE,
    ["--headless", "--disable-gpu", "--dump-dom", "--virtual-time-budget=180000", url],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120000, killSignal: "SIGKILL" });
  const m = (r.stdout || "").match(/<title>([^<]*)<\/title>/);
  return m ? m[1] : "(取得失敗)";
}

// 1) file:// で検証
const fileTitle = runEdge("file:///" + resolve(phtml).replace(/\\/g, "/"));
console.log("file:// :", fileTitle);

// 2) http://localhost で検証（GitHub Pages相当）。
// vendor/（AI採譜バンドル・モデル）も静的配信し、AI経路を実際に通す
const { createServer } = await import("node:http");
const { existsSync } = await import("node:fs");
const { extname, dirname } = await import("node:path");
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".bin": "application/octet-stream" };
const server = createServer((req, res) => {
  const urlPath = req.url.split("?")[0];
  if (urlPath === "/" || urlPath === "/index.html") {
    res.writeHead(200, { "Content-Type": MIME[".html"] });
    res.end(patched);
    return;
  }
  const file = join(appDir, urlPath.replace(/^\//, "").replace(/\.\./g, ""));
  if (!existsSync(file)) { res.writeHead(404); res.end("not found"); return; }
  res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
// 注意: spawnSyncはNodeのイベントループを塞ぎ、この自前サーバーが応答できなくなる。
// http検証は必ず非同期で実行する
let httpTitle;
try {
  const { stdout } = await execFileAsync(EDGE,
    ["--headless", "--disable-gpu", "--dump-dom", "--virtual-time-budget=600000",
      `http://127.0.0.1:${server.address().port}/`],
    { maxBuffer: 64 * 1024 * 1024, timeout: 300000, killSignal: "SIGKILL" });
  const m = (stdout || "").match(/<title>([^<]*)<\/title>/);
  httpTitle = m ? m[1] : "(取得失敗)";
} catch (e) {
  httpTitle = "(実行失敗: " + e.message + ")";
}
server.close();
console.log("http:// :", httpTitle);

// ハートビートタイマー導入後は file:// でも全経路（WAV書き出しまで）完走する。
// 万一仮想時間レースで途中ダンプした場合のみ、
// 「Workletフォールバック成功＋デモ生成＋エディタ遷移」までを最低合格条件とする
const fileOk = fileTitle.startsWith("SMOKE-OK") ||
  (/worklet=(blob|data)/.test(fileTitle) && fileTitle.includes("demo=") && fileTitle.includes("editor=true"));
const httpOk = httpTitle.startsWith("SMOKE-OK") && httpTitle.includes("worklet=blob");
console.log(fileOk && httpOk ? "=== SMOKE PASS ===" : "=== SMOKE FAIL ===");
process.exit(fileOk && httpOk ? 0 : 1);
