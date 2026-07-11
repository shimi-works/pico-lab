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

test("circularMeanFraction: 一定のチューニングずれを推定", () => {
  approx(P.circularMeanFraction([5.2, 7.2, 9.2]), 0.2, 1e-6, "+0.2");
  approx(P.circularMeanFraction([60.9, 64.9]), -0.1, 1e-6, "-0.1");
  approx(P.circularMeanFraction([60, 62, 64]), 0, 1e-6, "ずれなし");
});

test("framesToNotes: ビブラートのかかった1音が割れない", () => {
  // 69±0.45半音で揺れる60フレーム（実録音の歌声を模擬）
  const frames = [];
  for (let i = 0; i < 60; i++) {
    const m = 69 + 0.45 * Math.sin(i * 0.7);
    frames.push({ freq: P.midiToFreq(m), clarity: 0.85, rms: 0.1 });
  }
  const notes = P.framesToNotes(frames, 0.01, {});
  assert.equal(notes.length, 1, `ノート数: ${JSON.stringify(notes)}`);
  assert.equal(notes[0].midi, 69);
});

test("framesToNotes: 全体のデチューンがあっても音程間隔が保たれる", () => {
  // 半音の中間（x.47〜x.53）で歌われたメロディ。補正なしだと丸めがばたつく
  const frames = [];
  const push = (midiFloat, n) => {
    for (let i = 0; i < n; i++) frames.push({ freq: P.midiToFreq(midiFloat), clarity: 0.9, rms: 0.1 });
  };
  push(69.47, 20);
  for (let i = 0; i < 6; i++) frames.push(null);
  push(71.53, 20);
  for (let i = 0; i < 6; i++) frames.push(null);
  push(74.5, 20);
  const notes = P.framesToNotes(frames, 0.01, {});
  assert.equal(notes.length, 3, `ノート数: ${JSON.stringify(notes)}`);
  assert.equal(notes[1].midi - notes[0].midi, 2, "第1音程（全音）");
  assert.equal(notes[2].midi - notes[1].midi, 3, "第2音程（短3度）");
});

test("framesToNotes: 短い途切れの同音ノートは結合される", () => {
  const frames = [];
  for (let i = 0; i < 15; i++) frames.push({ freq: 440, clarity: 0.9, rms: 0.1 });
  for (let i = 0; i < 5; i++) frames.push(null); // 50msの息継ぎ
  for (let i = 0; i < 10; i++) frames.push({ freq: 440, clarity: 0.9, rms: 0.1 });
  const notes = P.framesToNotes(frames, 0.01, {});
  assert.equal(notes.length, 1, `ノート数: ${JSON.stringify(notes)}`);
  approx(notes[0].dur, 0.3, 1e-9, "結合後の長さ");
});

test("framesToNotes: 同音連打は音量の再アタックで分割される", () => {
  const frames = [];
  const rmsSeq = [];
  for (let i = 0; i < 12; i++) rmsSeq.push(0.1);
  rmsSeq.push(0.03, 0.02); // 音量が落ち込み…
  for (let i = 0; i < 16; i++) rmsSeq.push(0.1); // …急回復（タンギング）
  for (const r of rmsSeq) frames.push({ freq: 440, clarity: 0.9, rms: r });
  const notes = P.framesToNotes(frames, 0.01, {});
  assert.equal(notes.length, 2, `ノート数: ${JSON.stringify(notes)}`);
  assert.equal(notes[0].midi, 69);
  assert.equal(notes[1].midi, 69);
});

// ---- 多声解析（FFT・サリエンス・Viterbi・ドラム） ----

test("fftMagnitude: サイン波のピークが正しいビンに立つ", () => {
  const n = 128;
  const sig = Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 8 * i) / n));
  const mag = P.fftMagnitude(sig, n, null);
  let argmax = 0;
  for (let i = 1; i < mag.length; i++) if (mag[i] > mag[argmax]) argmax = i;
  assert.equal(argmax, 8);
});

test("harmonicSalience: 倍音を持つ音の基本周波数が最大サリエンスになる", () => {
  const rate = 22050, fftSize = 2048;
  const sig = new Float32Array(fftSize);
  for (let i = 0; i < fftSize; i++) {
    const t = i / rate;
    for (let h = 1; h <= 5; h++) sig[i] += Math.pow(0.7, h - 1) * Math.sin(2 * Math.PI * 440 * h * t);
  }
  const mag = P.fftMagnitude(sig, fftSize, P.hannWindow(fftSize));
  const grid = P.midiGridRange(57, 81, 0.5); // A3〜A5
  const row = P.buildSalienceRow(mag, fftSize, rate, grid, 8, 0.8);
  let argmax = 0;
  for (let s = 1; s < row.length; s++) if (row[s] > row[argmax]) argmax = s;
  approx(grid[argmax], 69, 0.5, "A4=440Hzが最大");
});

test("viterbiPitchTrack: 遠い単発ノイズに引きずられず、本当の遷移には追従する", () => {
  const S = 30;
  const mkRow = (strong) => {
    const r = new Float32Array(S).fill(0.1);
    r[strong] = 1;
    return r;
  };
  // フレーム5だけ遠い偽ピーク（state29）。往復jumpCap×2 > 発話利得なので無視される
  const rows = [];
  for (let t = 0; t < 5; t++) rows.push(mkRow(0));
  rows.push(mkRow(S - 1));
  for (let t = 6; t < 10; t++) rows.push(mkRow(0));
  const path1 = P.viterbiPitchTrack(rows, 0.5, 0.25, 1.2);
  assert.equal(path1[5], 0, "単発の遠いノイズを無視");
  // 本当の遷移（持続する）には追従する
  const rows2 = [];
  for (let t = 0; t < 5; t++) rows2.push(mkRow(0));
  for (let t = 5; t < 10; t++) rows2.push(mkRow(S - 1));
  const path2 = P.viterbiPitchTrack(rows2, 0.5, 0.25, 1.2);
  assert.equal(path2[2], 0, "前半は0");
  assert.equal(path2[8], S - 1, "後半は遷移に追従");
});

test("detectOnsets: 打撃を検出し種類を分類する", () => {
  const features = [];
  for (let i = 0; i < 120; i++) features.push({ flux: 0.1, lowFlux: 0.01, centroid: 2000 });
  features[20] = { flux: 2.0, lowFlux: 1.0, centroid: 800 };   // 低域優勢 → キック
  features[50] = { flux: 2.0, lowFlux: 0.05, centroid: 7500 }; // 高重心 → ハイハット
  features[80] = { flux: 2.0, lowFlux: 0.1, centroid: 3000 };  // それ以外 → スネア
  const hits = P.detectOnsets(features, 0.01, {});
  assert.equal(hits.length, 3, JSON.stringify(hits));
  assert.equal(hits[0].type, "kick");
  assert.equal(hits[1].type, "hat");
  assert.equal(hits[2].type, "snare");
  approx(hits[0].t, 0.2, 1e-9, "キック位置");
});

test("renderDrums: ノイズ打撃が生成され、最後の打撃後は無音", () => {
  const sr = 22050;
  const out = P.renderDrums([
    { t: 0.0, type: "kick", strength: 1 },
    { t: 0.2, type: "snare", strength: 0.8 },
    { t: 0.4, type: "hat", strength: 0.5 },
  ], sr);
  let peak = 0, tail = 0;
  for (let i = 0; i < out.length; i++) {
    assert.ok(Number.isFinite(out[i]));
    const a = Math.abs(out[i]);
    if (a > peak) peak = a;
    if (i > 0.52 * sr && a > tail) tail = a;
  }
  assert.ok(peak > 0.1 && peak <= 0.951, `peak=${peak}`);
  assert.ok(tail < 0.01, `tail=${tail}`);
});

test("mixFloat32: ゲイン付きミックスとクリップ防止", () => {
  const out = P.mixFloat32([Float32Array.from([1, 0]), Float32Array.from([0, 1])], [0.5, 0.5]);
  approx(out[0], 0.5, 1e-7, "mix");
  const clipped = P.mixFloat32([Float32Array.from([1]), Float32Array.from([1])], [1, 1]);
  approx(clipped[0], 0.95, 1e-6, "正規化");
});

test("統合: 多声解析でメロディとベースを同時に抽出できる", () => {
  const rate = 22050;
  const melodyNotes = [
    { start: 0.0, dur: 0.35, midi: 76, vel: 1 },
    { start: 0.4, dur: 0.35, midi: 79, vel: 1 },
    { start: 0.8, dur: 0.35, midi: 83, vel: 1 },
  ];
  const bassNotes = [{ start: 0.0, dur: 1.15, midi: 45, vel: 1 }];
  const audio = P.renderChipTracks([
    { notes: melodyNotes, settings: { wave: "square50", vibrato: 0, decay: 0 }, gain: 0.7 },
    { notes: bassNotes, settings: { wave: "triangle", vibrato: 0, decay: 0 }, gain: 0.6 },
  ], rate);

  const it = P.analyzePolyphonicSteps(audio, rate, {});
  let step = it.next();
  while (!step.done) step = it.next();
  const result = step.value;

  const melMidis = result.melody.map((n) => n.midi);
  for (const m of [76, 79, 83]) {
    assert.ok(melMidis.includes(m), `メロディ ${m}（実際: ${melMidis.join(",")}）`);
  }
  const bassMidis = result.bass.map((n) => n.midi);
  assert.ok(bassMidis.includes(45), `ベース 45（実際: ${bassMidis.join(",")}）`);
});

test("統合: 本物のハモリは検出され、メロディだけの音源ではハモリが出ない", () => {
  const rate = 22050;
  const melodyNotes = [
    { start: 0.0, dur: 0.35, midi: 76, vel: 1 },
    { start: 0.4, dur: 0.35, midi: 79, vel: 1 },
    { start: 0.8, dur: 0.35, midi: 83, vel: 1 },
  ];
  const drain = (audio) => {
    const it = P.analyzePolyphonicSteps(audio, rate, {});
    let step = it.next();
    while (!step.done) step = it.next();
    return step.value;
  };
  // メロディのみ → ハモリ（倍音ゴースト）はゼロであること
  const solo = P.renderChipTracks([
    { notes: melodyNotes, settings: { wave: "square50", vibrato: 0, decay: 0 }, gain: 0.7 },
  ], rate);
  const soloResult = drain(solo);
  assert.equal(soloResult.harmony.length, 0,
    `ゴーストハモリ: ${JSON.stringify(soloResult.harmony)}`);
  // メロディ＋3度下のハモリ → ハモリトラックに検出されること
  const harmonyNotes = [
    { start: 0.0, dur: 0.35, midi: 72, vel: 1 },
    { start: 0.4, dur: 0.35, midi: 75, vel: 1 },
    { start: 0.8, dur: 0.35, midi: 80, vel: 1 },
  ];
  const duet = P.renderChipTracks([
    { notes: melodyNotes, settings: { wave: "square50", vibrato: 0, decay: 0 }, gain: 0.7 },
    { notes: harmonyNotes, settings: { wave: "square50", vibrato: 0, decay: 0 }, gain: 0.5 },
  ], rate);
  const duetResult = drain(duet);
  const harmMidis = duetResult.harmony.map((n) => n.midi);
  const found = [72, 75, 80].filter((m) => harmMidis.includes(m));
  assert.ok(found.length >= 2,
    `ハモリ検出 2/3 以上（実際: ${harmMidis.join(",")}）`);
});

// ---- リズム後処理 ----

test("estimateTempo: 周期的なフラックスからビートを推定", () => {
  // 0.5秒（120BPM）ごとにスパイクのある10秒分のフラックス列
  const hop = 0.01;
  const flux = new Array(1000).fill(0.05);
  for (let i = 0; i < 1000; i += 50) flux[i] = 2.0;
  const tempo = P.estimateTempo(flux, hop, {});
  assert.ok(tempo, "推定できること");
  approx(tempo.beat, 0.5, 0.03, "ビート周期");
  approx(tempo.grid, 0.125, 0.01, "16分グリッド");
  assert.ok(Math.abs(tempo.phase % 0.5) < 0.03 || Math.abs((tempo.phase % 0.5) - 0.5) < 0.03,
    `位相がスパイクに合う (phase=${tempo.phase})`);
});

test("estimateTempo: 短すぎる/無音の素材では null", () => {
  assert.equal(P.estimateTempo(new Array(100).fill(0.1), 0.01, {}), null, "3秒未満");
});

test("quantizeNotes: グリッドに吸着し、重なりは前を詰める", () => {
  const notes = [
    { start: 0.48, dur: 0.4, midi: 60, vel: 1 },
    { start: 1.02, dur: 0.25, midi: 62, vel: 1 },
  ];
  const q = P.quantizeNotes(notes, 0.125, 0);
  approx(q[0].start, 0.5, 1e-9, "開始が吸着");
  approx(q[0].dur, 0.375, 1e-9, "終了 0.88→0.875 に吸着");
  approx(q[1].start, 1.0, 1e-9, "2音目の開始");
});

test("legatoNotes: 小さなすき間を埋める（大きなすき間は残す）", () => {
  const notes = [
    { start: 0, dur: 0.4, midi: 60, vel: 1 },
    { start: 0.48, dur: 0.3, midi: 62, vel: 1 },  // 80msのすき間 → 埋まる
    { start: 1.5, dur: 0.3, midi: 64, vel: 1 },   // 720msのすき間 → 残る
  ];
  const out = P.legatoNotes(notes, 0.12);
  approx(out[0].dur, 0.48, 1e-9, "すき間が埋まる");
  approx(out[1].dur, 0.3, 1e-9, "大きなすき間は伸ばさない");
});

test("fixOctaveOutliers: 短いオクターブ外れを隣に合わせる", () => {
  const notes = [
    { start: 0, dur: 0.3, midi: 67, vel: 1 },
    { start: 0.3, dur: 0.1, midi: 81, vel: 1 },  // 69の+12（短い）→ 69へ折り返し
    { start: 0.4, dur: 0.3, midi: 69, vel: 1 },
  ];
  const out = P.fixOctaveOutliers(notes, {});
  assert.equal(out[1].midi, 69);
  // 長いノートは補正しない
  const keep = P.fixOctaveOutliers([
    { start: 0, dur: 0.3, midi: 67, vel: 1 },
    { start: 0.3, dur: 0.5, midi: 81, vel: 1 },
    { start: 0.8, dur: 0.3, midi: 69, vel: 1 },
  ], {});
  assert.equal(keep[1].midi, 81);
});

test("quantizeDrums: 吸着と同一スロット重複の除去", () => {
  const hits = [
    { t: 0.49, type: "kick", strength: 0.9 },
    { t: 0.51, type: "kick", strength: 0.5 }, // 同じスロットに吸着 → 強い方だけ残る
    { t: 0.74, type: "hat", strength: 0.6 },
  ];
  const q = P.quantizeDrums(hits, 0.25, 0);
  assert.equal(q.length, 2, JSON.stringify(q));
  approx(q[0].t, 0.5, 1e-9, "キック位置");
  approx(q[0].strength, 0.9, 1e-9, "強い方が残る");
  approx(q[1].t, 0.75, 1e-9, "ハット位置");
});

test("detectOnsets: 帯域拡散が低い立ち上がり（音程楽器のアタック）は除外", () => {
  const features = [];
  for (let i = 0; i < 120; i++) features.push({ flux: 0.1, lowFlux: 0.01, centroid: 2000, spread: 0.1 });
  features[30] = { flux: 0.5, lowFlux: 0.05, centroid: 3000, spread: 0.05 }; // 集中型 → 除外
  features[60] = { flux: 0.5, lowFlux: 0.05, centroid: 3000, spread: 0.6 };  // 拡散型 → 検出
  const hits = P.detectOnsets(features, 0.01, {});
  assert.equal(hits.length, 1, JSON.stringify(hits));
  approx(hits[0].t, 0.6, 1e-9, "拡散型のみ検出");
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

test("統合: 声を模した音（倍音+ビブラート+デチューン+ノイズ）から元メロディを復元", () => {
  const sr = 11025;
  const melody = [67, 69, 71, 69, 67];
  const NOTE_DUR = 0.35, GAP = 0.06, DETUNE = 0.3;
  let seed = 424242;
  const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;

  const total = melody.length * (NOTE_DUR + GAP);
  const audio = new Float32Array(Math.ceil(total * sr));
  melody.forEach((midi, k) => {
    const startIdx = Math.floor(k * (NOTE_DUR + GAP) * sr);
    const n = Math.floor(NOTE_DUR * sr);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const vib = 0.3 * Math.min(1, t / 0.15) * Math.sin(2 * Math.PI * 5.5 * t);
      const freq = P.midiToFreq(midi + DETUNE + vib);
      phase += freq / sr;
      const p = 2 * Math.PI * phase;
      // 倍音を持つ声っぽい波形
      let s = Math.sin(p) + 0.5 * Math.sin(2 * p) + 0.25 * Math.sin(3 * p);
      let env = 1;
      if (t < 0.02) env = t / 0.02;
      if (NOTE_DUR - t < 0.03) env = (NOTE_DUR - t) / 0.03;
      audio[startIdx + i] = s * 0.25 * env + (rand() * 2 - 1) * 0.015;
    }
  });

  const hop = Math.round(sr * 0.01);
  const frames = [];
  for (let i = 0; i + 1024 <= audio.length; i += hop) {
    const frame = audio.subarray(i, i + 1024);
    const p = P.yinPitch(frame, sr, 70, 1200);
    frames.push(p ? { freq: p.freq, clarity: p.clarity, rms: P.frameRms(frame) } : null);
  }
  const notes = P.framesToNotes(frames, hop / sr, {});
  const midis = notes.map((n) => n.midi);
  assert.equal(midis.length, melody.length, `検出ノート: ${JSON.stringify(notes)}`);
  // デチューン補正は半音グリッドの取り方に±1の自由度があるため、音程の並びで検証する
  for (let i = 1; i < melody.length; i++) {
    assert.equal(midis[i] - midis[0], melody[i] - melody[0], `音程 ${i}`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
