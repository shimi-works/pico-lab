// ピコラボ 純関数ユニットテスト
// index.html の /* @pure-begin */ 〜 /* @pure-end */ を抽出してNodeで実行する。
// 実行: node tests/test.mjs
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const match = html.match(/\/\* @pure-begin \*\/([\s\S]*?)\/\* @pure-end \*\//);
assert.ok(match, "index.html に @pure-begin / @pure-end マーカーがあること");

const ctx = { module: { exports: {} }, console };
vm.createContext(ctx);
vm.runInContext(match[1], ctx);
const P = ctx.module.exports;

let pass = 0, fail = 0;
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok: ${name}`);
  } catch (e) {
    fail++;
    console.error(`FAIL: ${name}`);
    console.error(`      ${e.message}`);
  }
}
const approx = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} ≒ ${b} (±${eps})`);

// ---- crushQuantize ----

test("crushQuantize: bits=1 は -1/0/1 の3値に落ちる", () => {
  const vals = new Set();
  for (let x = -1; x <= 1; x += 0.05) vals.add(P.crushQuantize(x, 1));
  for (const v of vals) assert.ok([-1, 0, 1].includes(v), `値 ${v}`);
});

test("crushQuantize: bits=8 は誤差 1/256 以内", () => {
  for (const x of [-0.99, -0.5, 0, 0.123, 0.777, 0.99]) {
    approx(P.crushQuantize(x, 8), x, 1 / 256 + 1e-9, `x=${x}`);
  }
});

test("crushQuantize: 範囲外入力もクランプされる", () => {
  assert.ok(P.crushQuantize(1.5, 4) <= 1);
  assert.ok(P.crushQuantize(-1.5, 4) >= -1);
});

// ---- processCrush ----

test("processCrush: mix=0 で原音そのまま", () => {
  const input = Float32Array.from({ length: 256 }, (_, i) => Math.sin(i / 5));
  const out = new Float32Array(256);
  P.processCrush([input], [out], P.createCrushState(1), { bits: 2, sampleRate: 3000, mix: 0 }, 44100);
  for (let i = 0; i < 256; i++) approx(out[i], input[i], 1e-7, `i=${i}`);
});

test("processCrush: mix=1・フルレートで量子化のみ", () => {
  const input = Float32Array.from({ length: 128 }, (_, i) => Math.sin(i / 3));
  const out = new Float32Array(128);
  P.processCrush([input], [out], P.createCrushState(1), { bits: 4, sampleRate: 44100, mix: 1 }, 44100);
  for (let i = 0; i < 128; i++) approx(out[i], P.crushQuantize(input[i], 4), 1e-7, `i=${i}`);
});

test("processCrush: サンプルホールドで値が階段状に保持される", () => {
  const input = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 50));
  const out = new Float32Array(1000);
  // 44100 → 4410 Hz: 約10サンプルごとにしか値が変わらない
  P.processCrush([input], [out], P.createCrushState(1), { bits: 8, sampleRate: 4410, mix: 1 }, 44100);
  let changes = 0;
  for (let i = 1; i < 1000; i++) if (out[i] !== out[i - 1]) changes++;
  assert.ok(changes <= 110, `変化回数 ${changes} は約100であるべき`);
  assert.ok(changes >= 80, `変化回数 ${changes} は約100であるべき`);
});

test("processCrush: ブロック分割しても連続処理と同じ結果（Worklet互換性）", () => {
  const input = Float32Array.from({ length: 512 }, (_, i) => Math.sin(i / 7));
  const params = { bits: 5, sampleRate: 8000, mix: 0.8 };
  const whole = new Float32Array(512);
  P.processCrush([input], [whole], P.createCrushState(1), params, 44100);
  const chunked = new Float32Array(512);
  const state = P.createCrushState(1);
  for (let base = 0; base < 512; base += 128) {
    P.processCrush([input.subarray(base, base + 128)], [chunked.subarray(base, base + 128)], state, params, 44100);
  }
  for (let i = 0; i < 512; i++) approx(chunked[i], whole[i], 1e-7, `i=${i}`);
});

// ---- encodeWavPcm16 ----

test("encodeWavPcm16: ヘッダとサイズが正しい（ステレオ）", () => {
  const l = new Float32Array(100), r = new Float32Array(100);
  const buf = P.encodeWavPcm16([l, r], 22050);
  const v = new DataView(buf);
  const str = (off, n) => String.fromCharCode(...new Uint8Array(buf, off, n));
  assert.equal(buf.byteLength, 44 + 100 * 4);
  assert.equal(str(0, 4), "RIFF");
  assert.equal(str(8, 4), "WAVE");
  assert.equal(str(12, 4), "fmt ");
  assert.equal(str(36, 4), "data");
  assert.equal(v.getUint32(4, true), 36 + 400);
  assert.equal(v.getUint16(22, true), 2, "チャンネル数");
  assert.equal(v.getUint32(24, true), 22050, "サンプルレート");
  assert.equal(v.getUint32(28, true), 22050 * 4, "バイトレート");
  assert.equal(v.getUint16(34, true), 16, "ビット深度");
  assert.equal(v.getUint32(40, true), 400, "dataサイズ");
});

test("encodeWavPcm16: サンプル値の変換とクリップ", () => {
  const data = Float32Array.from([0, 0.5, -0.5, 1, -1, 2, -2]);
  const buf = P.encodeWavPcm16([data], 44100);
  const v = new DataView(buf);
  const s = (i) => v.getInt16(44 + i * 2, true);
  assert.equal(s(0), 0);
  approx(s(1), 16384, 2, "0.5");
  approx(s(2), -16384, 2, "-0.5");
  assert.equal(s(3), 32767);
  assert.equal(s(4), -32768);
  assert.equal(s(5), 32767, "クリップ +");
  assert.equal(s(6), -32768, "クリップ -");
});

// ---- 前処理 ----

test("mixToMono: 2chの平均になる", () => {
  const out = P.mixToMono([Float32Array.from([1, 0.5]), Float32Array.from([0, 0.5])]);
  approx(out[0], 0.5, 1e-7, "L1/R0");
  approx(out[1], 0.5, 1e-7, "0.5/0.5");
});

test("downsampleTo: 44100→約11025でbox平均", () => {
  const data = Float32Array.from([1, 1, 3, 3, 2, 2, 4, 4]);
  const { data: out, rate } = P.downsampleTo(data, 44100, 11025);
  assert.equal(rate, 11025);
  assert.equal(out.length, 2);
  approx(out[0], 2, 1e-7, "avg(1,1,3,3)");
  approx(out[1], 3, 1e-7, "avg(2,2,4,4)");
});

// ---- YIN ----

function sine(freq, sr, n) {
  return Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * freq * i) / sr));
}

test("yinPitch: 440Hzサイン波を±1%で検出", () => {
  const r = P.yinPitch(sine(440, 11025, 1024), 11025, 70, 1200);
  assert.ok(r, "検出できること");
  approx(r.freq, 440, 4.4, "周波数");
  assert.ok(r.clarity > 0.8, `clarity=${r.clarity}`);
});

test("yinPitch: 220Hz / 880Hz も検出", () => {
  approx(P.yinPitch(sine(220, 11025, 1024), 11025, 70, 1200).freq, 220, 2.2, "220Hz");
  approx(P.yinPitch(sine(880, 11025, 1024), 11025, 70, 1200).freq, 880, 8.8, "880Hz");
});

test("yinPitch: 無音では null", () => {
  assert.equal(P.yinPitch(new Float32Array(1024), 11025, 70, 1200), null);
});

test("yinPitch: ホワイトノイズでは（ほぼ）検出しない", () => {
  // 擬似乱数（再現性のためLCG）
  let seed = 12345;
  const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const noise = Float32Array.from({ length: 1024 }, () => rand() * 2 - 1);
  const r = P.yinPitch(noise, 11025, 70, 1200);
  assert.ok(r === null || r.clarity < 0.6, "ノイズで高confidenceを出さない");
});

// ---- ノート化 ----

test("freqToMidi / midiToFreq: A4=440↔69", () => {
  approx(P.freqToMidi(440), 69, 1e-9, "440→69");
  approx(P.midiToFreq(69), 440, 1e-9, "69→440");
  approx(P.freqToMidi(261.6256), 60, 0.01, "C4→60");
});

test("medianFilterNullable: 単発のスパイクを除去", () => {
  const out = P.medianFilterNullable([60, 60, 72, 60, 60], 5);
  // vm別レルムの配列なので deepEqual ではなく要素比較
  assert.equal(out.length, 5);
  for (let i = 0; i < 5; i++) assert.equal(out[i], 60, `i=${i}`);
});

test("medianFilterNullable: null過半数の窓は null", () => {
  const out = P.medianFilterNullable([null, null, 60, null, null], 5);
  assert.equal(out[2], null);
});

test("framesToNotes: 連続フレームが1ノートに統合される", () => {
  const frames = [];
  for (let i = 0; i < 20; i++) frames.push({ freq: 440, clarity: 0.9, rms: 0.1 });
  for (let i = 0; i < 5; i++) frames.push(null);
  for (let i = 0; i < 30; i++) frames.push({ freq: 493.88, clarity: 0.9, rms: 0.05 });
  const notes = P.framesToNotes(frames, 0.01, {});
  assert.equal(notes.length, 2, `ノート数: ${JSON.stringify(notes)}`);
  assert.equal(notes[0].midi, 69);
  approx(notes[0].start, 0, 1e-9, "開始");
  approx(notes[0].dur, 0.2, 1e-9, "長さ");
  assert.equal(notes[1].midi, 71);
  approx(notes[1].vel, 0.3 + 0.7 * 0.5, 0.05, "小さい音のvel");
  approx(notes[0].vel, 1.0, 1e-6, "大きい音のvel");
});

test("framesToNotes: 60ms未満のノートは破棄", () => {
  const frames = [null, null];
  for (let i = 0; i < 3; i++) frames.push({ freq: 440, clarity: 0.9, rms: 0.1 });
  frames.push(null, null);
  const notes = P.framesToNotes(frames, 0.01, {});
  assert.equal(notes.length, 0, "0.03秒のノートは捨てる");
});

test("framesToNotes: clarity低・音量ゲート未満は無視", () => {
  const frames = [];
  for (let i = 0; i < 20; i++) frames.push({ freq: 440, clarity: 0.2, rms: 0.1 });   // 低clarity
  for (let i = 0; i < 20; i++) frames.push({ freq: 440, clarity: 0.9, rms: 0.0001 }); // ほぼ無音
  const notes = P.framesToNotes(frames, 0.01, {});
  assert.equal(notes.length, 0);
});

// ---- チップシンセ ----

test("renderChip: 長さ・振幅・無音区間が正しい", () => {
  const sr = 11025;
  const out = P.renderChip([{ start: 0, dur: 0.5, midi: 69, vel: 1 }], { wave: "square50", vibrato: 0, decay: 0.3 }, sr);
  assert.ok(out.length >= Math.floor(0.8 * sr), "末尾余白込みの長さ");
  let peak = 0, tailPeak = 0;
  for (let i = 0; i < out.length; i++) {
    const a = Math.abs(out[i]);
    assert.ok(Number.isFinite(out[i]), `NaN/Inf at ${i}`);
    if (a > peak) peak = a;
    if (i > 0.6 * sr && a > tailPeak) tailPeak = a;
  }
  assert.ok(peak > 0.05, `音が出ている (peak=${peak})`);
  assert.ok(peak <= 0.951, `クリップしない (peak=${peak})`);
  assert.ok(tailPeak < 0.01, `ノート終了後は無音 (tail=${tailPeak})`);
});

test("renderChip: 矩形波のピッチが指定どおり（ゼロクロス計測）", () => {
  const sr = 44100;
  const out = P.renderChip([{ start: 0, dur: 1.0, midi: 69, vel: 1 }], { wave: "square50", vibrato: 0, decay: 0 }, sr);
  // 減衰の影響が少ない 0.1〜0.6秒 区間で数える
  let crossings = 0;
  for (let i = Math.floor(0.1 * sr) + 1; i < Math.floor(0.6 * sr); i++) {
    if ((out[i] >= 0) !== (out[i - 1] >= 0)) crossings++;
  }
  approx(crossings / 2 / 0.5, 440, 5, "推定周波数");
});

test("renderChip: square25 はDCオフセットが除去されている", () => {
  const sr = 11025;
  const out = P.renderChip([{ start: 0, dur: 0.3, midi: 69, vel: 1 }], { wave: "square25", vibrato: 0, decay: 0 }, sr);
  let sum = 0;
  const n = Math.floor(0.25 * sr);
  for (let i = 0; i < n; i++) sum += out[i];
  assert.ok(Math.abs(sum / n) < 0.05, `平均 ${sum / n} がほぼ0`);
});

test("renderChip: 三角波も生成できる", () => {
  const out = P.renderChip([{ start: 0, dur: 0.2, midi: 60, vel: 0.8 }], { wave: "triangle", vibrato: 0.5, decay: 0.5 }, 11025);
  let peak = 0;
  for (const v of out) { assert.ok(Number.isFinite(v)); if (Math.abs(v) > peak) peak = Math.abs(v); }
  assert.ok(peak > 0.05 && peak <= 0.951);
});

// ---- デモ音源・プリセット ----

test("renderDemoSong: 妥当な長さ・振幅で生成される", () => {
  const out = P.renderDemoSong(11025);
  assert.ok(out.length > 6 * 11025, "6秒以上");
  let peak = 0;
  for (const v of out) { assert.ok(Number.isFinite(v)); if (Math.abs(v) > peak) peak = Math.abs(v); }
  assert.ok(peak > 0.1 && peak <= 1.0, `peak=${peak}`);
});

test("BUILTIN_PRESETS: 5個・全パラメータがスライダー範囲内", () => {
  assert.equal(P.BUILTIN_PRESETS.length, 5);
  for (const p of P.BUILTIN_PRESETS) {
    assert.ok(p.name.length > 0);
    assert.ok(p.params.bits >= 1 && p.params.bits <= 8, `${p.name} bits`);
    assert.ok(p.params.sampleRate >= 2000 && p.params.sampleRate <= 16000, `${p.name} rate`);
    assert.ok(p.params.mix >= 0 && p.params.mix <= 1, `${p.name} mix`);
    assert.ok(p.params.filterFreq >= 500 && p.params.filterFreq <= 12000, `${p.name} freq`);
    assert.ok(typeof p.params.filterOn === "boolean", `${p.name} filterOn`);
  }
});

// ---- 統合: 採譜パイプライン（合成音 → YIN → ノート） ----

test("統合: チップ音を採譜すると元のノートに戻る", () => {
  const sr = 11025;
  const srcNotes = [
    { start: 0.0, dur: 0.4, midi: 69, vel: 1 },
    { start: 0.5, dur: 0.4, midi: 72, vel: 1 },
    { start: 1.0, dur: 0.4, midi: 76, vel: 1 },
  ];
  const audio = P.renderChip(srcNotes, { wave: "square50", vibrato: 0, decay: 0 }, sr);
  const hop = Math.round(sr * 0.01);
  const frames = [];
  for (let i = 0; i + 1024 <= audio.length; i += hop) {
    const frame = audio.subarray(i, i + 1024);
    const p = P.yinPitch(frame, sr, 70, 1200);
    frames.push(p ? { freq: p.freq, clarity: p.clarity, rms: P.frameRms(frame) } : null);
  }
  const notes = P.framesToNotes(frames, hop / sr, {});
  const midis = notes.map((n) => n.midi);
  for (const m of [69, 72, 76]) {
    assert.ok(midis.includes(m), `midi ${m} が検出される（実際: ${midis.join(",")}）`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
