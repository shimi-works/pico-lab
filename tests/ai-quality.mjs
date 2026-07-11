// AI採譜（basic-pitch）の品質実証テスト:
// アプリディレクトリをhttp配信し、デモ曲（正解ノート既知）をモデルに採譜させて
// メロディ・ベースの復元率を document.title 経由で回収する。
// 実行: node tests/ai-quality.mjs
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname, extname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import http from "node:http";

const execFileAsync = promisify(execFile);
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(appDir, "index.html"), "utf8");

const inject = `<script>
window.addEventListener("load", async () => {
  const out = [];
  const step = (s) => { document.title = "AIQ-AT:" + s + " | " + out.join(" "); };
  const heartbeat = setInterval(() => {}, 100);
  try {
    step("load-lib");
    await new Promise((ok, ng) => {
      const s = document.createElement("script");
      s.src = "vendor/basic-pitch.js";
      s.onload = ok; s.onerror = () => ng(new Error("bundle load failed"));
      document.head.appendChild(s);
    });
    step("load-model");
    const bp = new BasicPitchLib.BasicPitch("vendor/model/model.json");
    // 正解が既知のデモ曲（メロディ=矩形波・ベース=三角波）を22050Hzで生成
    const rate = 22050;
    const audio = renderDemoSong(rate);
    step("infer");
    const frames = [], onsets = [], contours = [];
    await bp.evaluateModel(audio, (f, o, c) => {
      frames.push(...f); onsets.push(...o); contours.push(...c);
    }, () => {});
    step("decode");
    const events = BasicPitchLib.noteFramesToTime(
      BasicPitchLib.addPitchBendsToNoteEvents(contours,
        BasicPitchLib.outputToNotesPoly(frames, onsets, 0.5, 0.3, 5)));
    const got = events.map((e) => ({ start: e.startTimeSeconds, midi: e.pitchMidi }));
    // 正解: buildDemoNotes のメロディ＋ベース
    const truth = buildDemoNotes();
    const match = (list) => {
      let hit = 0;
      for (const t of list) {
        if (got.some((g) => g.midi === t.midi && Math.abs(g.start - t.start) < 0.12)) hit++;
      }
      return hit + "/" + list.length;
    };
    out.push("notes=" + got.length);
    out.push("melody=" + match(truth.melody));
    out.push("bass=" + match(truth.bass));
    clearInterval(heartbeat);
    document.title = "AIQ-OK " + out.join(" ");
  } catch (e) {
    clearInterval(heartbeat);
    document.title = "AIQ-ERR:" + (e && e.message) + " | " + out.join(" ");
  }
});
</${"script"}>`;

const patched = html.replace("</body>", inject + "</body>");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".bin": "application/octet-stream" };
const server = http.createServer((req, res) => {
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

let title;
try {
  const { stdout } = await execFileAsync(EDGE,
    ["--headless", "--disable-gpu", "--dump-dom", "--virtual-time-budget=600000",
      `http://127.0.0.1:${server.address().port}/`],
    { maxBuffer: 64 * 1024 * 1024, timeout: 300000, killSignal: "SIGKILL" });
  const m = (stdout || "").match(/<title>([^<]*)<\/title>/);
  title = m ? m[1] : "(title取得失敗)";
} catch (e) {
  title = "(実行失敗: " + e.message + ")";
}
server.close();
console.log(title);
process.exit(title.startsWith("AIQ-OK") ? 0 : 1);
