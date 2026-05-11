#!/usr/bin/env node
//
// Budgety MCP Bridge
//
// Exposes Budgety's data to Claude via MCP. Internally calls macOS `shortcuts`
// CLI which runs the `Budgety で支出を取得` AppShortcut → returns JSON to Claude.
//
// Setup:
//   1. Install Budgety on iPhone, sign in to iCloud
//   2. On Mac, ensure Shortcuts.app has "Budgety で支出を取得" available
//      (auto-synced via iCloud once Budgety iOS App Intent is registered)
//   3. claude mcp add budgety -s user -- node /Users/ishinotento/budgety-mcp/index.js
//   4. Restart Claude Code: claude -c
//

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);

// 統合 Shortcut: add/get の両方を 1 つの Shortcut で扱う。
// JSON ペイロードに `op: "add"` / `op: "get"` を含めて分岐させる。
const SHORTCUT_NAME = "クイック家計簿";

const server = new Server(
    {
        name: "budgety-mcp",
        version: "0.1.0",
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

// MARK: Tools

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "get_expenses",
            description:
                "Get expense / income records from Budgety for a specified period. Returns structured JSON with date, amount, category, sheet, etc. Useful for analyzing spending patterns.",
            inputSchema: {
                type: "object",
                properties: {
                    period: {
                        type: "string",
                        enum: [
                            "today",
                            "yesterday",
                            "thisWeek",
                            "thisMonth",
                            "lastMonth",
                            "thisYear",
                            "last30Days",
                            "allTime",
                        ],
                        default: "thisMonth",
                        description: [
                            "Time window for the expense query:",
                            "  today      — calendar today (local)",
                            "  yesterday  — calendar yesterday",
                            "  thisWeek   — current week, Monday-start",
                            "  thisMonth  — calendar month-to-date",
                            "  lastMonth  — previous calendar month",
                            "  thisYear   — current year, Jan 1 to now",
                            "  last30Days — rolling 30 days",
                            "  allTime    — every recorded expense (use for cross-period analysis)",
                        ].join("\n"),
                    },
                    sheet: {
                        type: "string",
                        description: "Filter by sheet name (e.g. '家計簿', 'テスト'). Optional.",
                    },
                    kind: {
                        type: "string",
                        enum: ["expense", "income"],
                        description: "Filter by transaction kind. Optional (default = both).",
                    },
                    from: {
                        type: "string",
                        description:
                            "Custom range start (ISO8601). Overrides `period` if used with `to`. Example: '2026-04-01T00:00:00+09:00'.",
                    },
                    to: {
                        type: "string",
                        description: "Custom range end (ISO8601). Use with `from` for explicit ranges.",
                    },
                },
            },
        },
        {
            name: "add_expense",
            description: [
                "Record an expense OR income entry in Budgety (the user's family expense tracking app).",
                "Use this whenever the user mentions a purchase, payment, expense, or income in conversation",
                "(e.g. 'コーヒー 350 円', 'lunch was 1200 yen', '今日の給料 25万', 'add yesterday's groceries').",
                "",
                "Behavior:",
                "- Defaults to the user's oldest sheet (typically 家計簿) unless `sheet` is specified.",
                "- Currency = sheet's default (JPY for Japan).",
                "- Category is auto-classified by AI from the title — DO NOT pass a category.",
                "- `kind` defaults to 'expense'. Pass 'income' for salary, refunds, gifts received, etc.",
                "",
                "Sheet selection:",
                "- Pass `sheet` to target a non-default sheet (e.g. '仕事', '旅行').",
                "- If `sheet` doesn't match any existing sheet, falls back to oldest sheet silently.",
                "  → Recommend calling get_expenses first to discover valid sheet names.",
                "- If multiple sheets share the same name (CloudKit merge / duplicate), the OLDEST",
                "  one (by createdAt) is used. The response will include a `warning` field.",
                "",
                "Date handling (IMPORTANT):",
                "- Resolve relative dates ('yesterday', '昨日', '先週月曜', etc.) to an absolute",
                "  ISO8601 string BEFORE calling. The shortcut does not understand relative dates.",
                "- Format: 'YYYY-MM-DDTHH:MM:SSZ' (UTC) or 'YYYY-MM-DDTHH:MM:SS+09:00' (JST).",
                "- Omit `date` to record at the current moment.",
                "- If the user mentions a date but not a time, use 12:00 local time as a sensible default.",
                "- **Future dates are REJECTED** (the app records what already happened).",
                "  Trying to record salary 'next month' returns {ok:false, error:'future date not allowed'}.",
                "  If the user mentions a future date, tell them to wait until then or use a past date.",
                "",
                "Response format:",
                "- Returns JSON with: ok (bool), amount, title, sheet, category, optional warning.",
                "- Example success: {\"ok\":true,\"amount\":500,\"sheet\":\"テスト\",\"category\":\"食費\",\"title\":\"ランチ\"}",
                "- If a warning is present, surface it to the user (e.g. duplicate sheet names).",
            ].join("\n"),
            inputSchema: {
                type: "object",
                properties: {
                    amount: {
                        type: "number",
                        description:
                            "Amount as a plain number. Strip currency symbols (¥, $, 円) before passing.",
                    },
                    title: {
                        type: "string",
                        description:
                            "Short label for the expense (店名・品目). Keep it concise — no need for full sentences.",
                    },
                    date: {
                        type: "string",
                        description: [
                            "ISO8601 date-time string. Optional — defaults to now.",
                            "Examples:",
                            "  '2026-05-03T19:30:00Z'      (UTC)",
                            "  '2026-05-03T19:30:00+09:00' (JST)",
                            "Resolve relative dates ('yesterday', '昨日') to absolute before passing.",
                        ].join("\n"),
                    },
                    sheet: {
                        type: "string",
                        description:
                            "Sheet name (e.g. '家計簿', '仕事'). Optional — defaults to primary sheet. Must match an existing sheet name exactly.",
                    },
                    kind: {
                        type: "string",
                        enum: ["expense", "income"],
                        description:
                            "Transaction kind. 'expense' (default) for payments, 'income' for salary, refunds, gifts received, etc.",
                    },
                },
                required: ["amount", "title"],
            },
        },
    ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = req.params.arguments ?? {};
    try {
        if (name === "get_expenses") {
            const payload = JSON.stringify({
                op: "get",
                period: args.period ?? "thisMonth",
                ...(args.sheet ? { sheet: args.sheet } : {}),
                ...(args.kind  ? { kind:  args.kind  } : {}),
                ...(args.from  ? { from:  args.from  } : {}),
                ...(args.to    ? { to:    args.to    } : {}),
            });
            const json = await runShortcutWithInput(SHORTCUT_NAME, payload);
            return {
                content: [{ type: "text", text: json }],
            };
        }
        if (name === "add_expense") {
            const dateISO = args.date && typeof args.date === "string"
                ? args.date
                : new Date().toISOString();
            const payload = JSON.stringify({
                op: "add",
                amount: args.amount,
                title: args.title ?? "",
                date: dateISO,
                ...(args.sheet ? { sheet: args.sheet } : {}),
                ...(args.kind  ? { kind:  args.kind  } : {}),
            });
            const result = await runShortcutWithInput(SHORTCUT_NAME, payload);
            return {
                content: [{ type: "text", text: result || "OK" }],
            };
        }
        throw new Error(`Unknown tool: ${name}`);
    } catch (err) {
        return {
            isError: true,
            content: [
                {
                    type: "text",
                    text: `${err.message ?? err}\n\nHint: ensure the shortcut is set up in Shortcuts.app on this Mac (signed into the same iCloud as Budgety).`,
                },
            ],
        };
    }
});

async function runShortcutWithInput(name, input) {
    const inputPath = join(tmpdir(), `budgety-mcp-in-${Date.now()}.txt`);
    const outputPath = join(tmpdir(), `budgety-mcp-out-${Date.now()}.txt`);
    await writeFile(inputPath, input ?? "", "utf-8");
    try {
        // 8 秒以上かかったら shortcut が対話プロンプトでハングしている可能性大なので abort
        const child = execFile("shortcuts", [
            "run",
            name,
            "--input-path", inputPath,
            "--output-path", outputPath,
        ]);
        const promise = new Promise((resolve, reject) => {
            child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`shortcut exited code=${code}`)));
            child.on("error", reject);
        });
        const timeout = new Promise((_, reject) =>
            setTimeout(() => {
                try { child.kill("SIGKILL"); } catch {}
                reject(new Error("shortcut timed out (>8s) - probably waiting for user input. Configure the shortcut in Shortcuts.app to skip prompts."));
            }, 8000)
        );
        await Promise.race([promise, timeout]);
    } finally {
        try { await unlink(inputPath); } catch {}
    }
    let result = "";
    try {
        result = await readFile(outputPath, "utf-8");
    } catch {
        result = "";
    }
    try { await unlink(outputPath); } catch {}
    // 空 output は許容 (= shortcut 末尾に出力アクションがない場合の正常終了)。
    // 本物の失敗は execFile の exit code 非 0 / timeout で既に throw されている。
    return result;
}

// MARK: Run

const transport = new StdioServerTransport();
await server.connect(transport);
