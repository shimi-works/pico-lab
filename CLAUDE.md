# CLAUDE.md — ピコラボ

## このプロジェクト

- 手持ちのmp3をブラウザ内だけで8bit風サウンド（チップチューン）に変換して遊べるWebアプリ
- 構成: 単一HTMLファイル（`index.html` にHTML/CSS/JSをすべて内包）
- 管理情報: `C:\Users\smzyt\apps\dev-os\projects\pico-lab\`（要件・設計・タスク・バグはそちらを参照）

## 開発標準

`C:\Users\smzyt\apps\dev-os\DEVELOPMENT_OS.md`（AI非依存の正典）の「全プロジェクト共通 開発標準」に従う。
（コーディング規約・命名・コメント・UIルール・Git/コミット規則・レビュー・バグ修正・テスト方針）

## このプロジェクト固有のルール

- ファイル分割しない。単一HTML内でセクションコメント（`/* ===== 状態管理 ===== */` 等）で区画を保つ
- 外部依存はなし（CDN禁止。Web Audio API標準のみ）
- データ永続化: localStorage（キー `picolab.settings`）。音声データは保存しない
- **著作権方針（design.md参照）**: URL入力・外部取得機能は実装しない。入力はローカルファイルのみ。アップロード一切なし
- 純関数（DSP・採譜・チップシンセ・WAVエンコード）は `/* @pure-begin */ 〜 /* @pure-end */` マーカー内に置き、`tests/test.mjs` がここを抽出してNodeでテストする。マーカー内にDOM/Web Audio依存コードを入れない
- 対応ブラウザ: 最新Chrome/Edge優先、スマホ幅(375px)対応必須

## 動作確認

- `index.html` をブラウザで直接開いて確認
- ロジック: `node tests/test.mjs`（全pass必須）
- リリース前: `dev-os/templates/checklists/release.md` を実施
