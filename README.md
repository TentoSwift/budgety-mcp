# Budgety MCP

Budgety (家計簿アプリ) を Claude から操作するための MCP ブリッジ。

Claude → MCP server (Node.js) → macOS `shortcuts` CLI → Shortcuts.app レシピ → Budgety AppIntent → Core Data → CloudKit、という経路で支出の取得・追加を行う。

## できること

| ツール名 | 用途 |
|---|---|
| `mcp__budgety__get_expenses` | 期間指定で支出/収入一覧を JSON で取得 |
| `mcp__budgety__add_expense` | 支出を 1 件追加 (日付・カテゴリ AI 自動分類対応) |

## 前提

- macOS (Mac Catalyst で Budgety が動く環境)
- Budgety アプリがインストール済み・起動済み (= AppIntent が macOS に登録されている)
- iCloud に Budgety と同じ Apple ID でサインイン
- Node.js (v18 以上推奨)
- Claude Code CLI

## セットアップ

### 1. Budgety を起動

一度起動して AppIntent を macOS に登録させる。終了せず動かしっぱなしで OK。

### 2. Shortcuts.app でレシピを 2 つ作成

#### A. 「支出を取得」

```
[1] Budgety > 支出を取得
       期間: ショートカットの入力
[2] 結果として返す: [1] の出力
```

#### B. 「クイック支出追加」

```
[1] ショートカットの入力 から辞書を取得 (= JSON parse)
[2] 辞書 内の amount の 値を取得
[3] 辞書 内の title  の 値を取得
[4] 辞書 内の date   の 値を取得
[5] Budgety > 支出を追加
       シート:        家計簿 (固定選択)
       タイトル:       [3] の出力
       金額:          [2] の出力
       カテゴリ:       AI 提案 (= ドロップダウンで選択)
       日付:          現在の日付 (= 変数バインド)
       日付テキスト:   [4] の出力 (= ISO8601 文字列を内部で parse)
       メモ:          (空)
```

> ⚠ Shortcuts.app で `[4]` の値を「日付」フィールドに直接バインドするとエラーになる。必ず「**日付テキスト (任意)**」フィールドに渡すこと (= AppIntent 内部で文字列 → Date 変換される)。「日付」自体は `現在の日付` 変数固定でフォールバック用。

### 3. MCP server をインストール

```bash
cd /path/to/budgety-mcp
npm install
```

### 4. Claude Code に登録

```bash
claude mcp add budgety -s user -- node $(pwd)/index.js
```

### 5. 起動確認

```bash
claude
```

Claude セッション内で `mcp__budgety__get_expenses` が使えれば成功。

## 使い方 (Claude への依頼例)

```
「今月の支出を見せて」              → get_expenses(period: "thisMonth")
「コーヒー 350 円を追加」           → add_expense(amount: 350, title: "コーヒー")
「昨日のラーメン 1200 円」          → add_expense(amount: 1200, title: "ラーメン",
                                                date: "2026-05-09T...")
「5/3 の焼肉 4200 円」             → add_expense(amount: 4200, title: "焼肉",
                                                date: "2026-05-03T19:00:00+09:00")
```

カテゴリは指定しない。AI が title から自動分類する。

## 仕様詳細

### `add_expense`

| パラメータ | 型 | 必須 | 説明 |
|---|---|---|---|
| `amount` | number | ✓ | 数字のみ (¥, 円 などは剥がす) |
| `title` | string | ✓ | 用途・店名・品目 (短く) |
| `date` | string | × | ISO8601。未指定 = 現在時刻 |

**date の例:**
- `"2026-05-08T15:00:00Z"` (UTC)
- `"2026-05-08T19:00:00+09:00"` (JST)

相対日付 (「昨日」「先週月曜」) は **Claude 側で絶対日付に変換してから渡す**。Shortcut は相対表現を理解しない。

### `get_expenses`

| パラメータ | 値 |
|---|---|
| `period` | `today` / `yesterday` / `thisWeek` / `thisMonth` / `lastMonth` / `thisYear` / `last30Days` |

## トラブルシューティング

| 症状 | 原因 | 対処 |
|---|---|---|
| `shortcut timed out (>8s)` | Shortcut が対話プロンプトでハング | Shortcuts.app で対象 Shortcut の各パラメータを「毎回尋ねる」から固定値/変数に変更 |
| `shortcut exited code=1` | パラメータの型不整合 (例: 文字列を Date 欄に渡した) | Shortcut の各フィールドのバインド先を確認 |
| 追加したのに反映されない | iCloud 同期遅延 | 数秒待つ |
| 日付指定したのに今日になる | 日付テキストが間違ったキーにバインド | Shortcut で `date` キーから値を取り出しているか確認 |
| 「支出を追加」が `shortcuts list` に出ない | Budgety を起動していない | アプリを起動 |

## アーキテクチャ

```
Claude
   ↓ JSON-RPC (stdio)
budgety-mcp (Node.js)
   ↓ execFile("shortcuts", ["run", ...])
macOS Shortcuts CLI
   ↓ 実行
Shortcuts.app レシピ (= 「クイック支出追加」)
   ↓ AppIntent
Budgety.app (Mac Catalyst)
   ↓ Core Data
CloudKit → iPhone / Watch / 他 Mac
```

## ファイル構成

```
budgety-mcp/
├── index.js       # MCP server (Node.js)
├── package.json
└── README.md      # このファイル
```

AppIntent 側のコード (= Budgety リポジトリ内):
- `Budgety/Intents/AddExpenseIntent.swift`
- `Budgety/Intents/QuickAddExpenseIntent.swift`
- `Budgety/Intents/GetExpensesIntent.swift`
- `Budgety/Intents/ExpensoShortcuts.swift`
- `Budgety/Intents/ExpenseCategoryEntity.swift`
- `Budgety/Intents/ExpenseSheetEntity.swift`
