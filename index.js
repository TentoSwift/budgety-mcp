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

const SHORTCUT_NAME_GET_EXPENSES = "支出を取得";
const SHORTCUT_NAME_ADD_EXPENSE = "クイック支出追加";

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
                        ],
                        default: "thisMonth",
                        description: "Period to fetch expenses for",
                    },
                },
            },
        },
        {
            name: "add_expense",
            description: [
                "Record an expense in Budgety (the user's family expense tracking app).",
                "Use this whenever the user mentions a purchase, payment, or expense in conversation",
                "(e.g. 'コーヒー 350 円', 'lunch was 1200 yen', 'add yesterday's groceries').",
                "",
                "Behavior:",
                "- Saves to the user's primary sheet (家計簿).",
                "- Currency = sheet's default (JPY for Japan).",
                "- Category is auto-classified by AI from the title — DO NOT pass a category.",
                "",
                "Date handling (IMPORTANT):",
                "- Resolve relative dates ('yesterday', '昨日', '先週月曜', etc.) to an absolute",
                "  ISO8601 string BEFORE calling. The shortcut does not understand relative dates.",
                "- Format: 'YYYY-MM-DDTHH:MM:SSZ' (UTC) or 'YYYY-MM-DDTHH:MM:SS+09:00' (JST).",
                "- Omit `date` to record at the current moment.",
                "- If the user mentions a date but not a time, use 12:00 local time as a sensible default.",
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
            const period = args.period ?? "thisMonth";
            const json = await runShortcutWithInput(
                SHORTCUT_NAME_GET_EXPENSES,
                period
            );
            return {
                content: [{ type: "text", text: json }],
            };
        }
        if (name === "add_expense") {
            // date は常に送る (= 未指定なら現在時刻の ISO8601)。Shortcut 側は
            // 「日付を取得」アクションで text → Date に変換する前提。
            const dateISO = args.date && typeof args.date === "string"
                ? args.date
                : new Date().toISOString();
            const payload = JSON.stringify({
                amount: args.amount,
                title: args.title ?? "",
                date: dateISO,
            });
            const result = await runShortcutWithInput(
                SHORTCUT_NAME_ADD_EXPENSE,
                payload
            );
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
