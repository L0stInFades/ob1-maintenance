import * as fs from "node:fs";
import * as path from "node:path";
import { getOb1TmpDir, } from "./utils.js";
// =============================================================================
// Arg parsing helpers
// =============================================================================
const argv = process.argv.slice(2);
function getArg(name, defaultVal) {
    const idx = argv.indexOf(`--${name}`);
    if (idx === -1 || idx + 1 >= argv.length)
        return defaultVal;
    return argv[idx + 1];
}
function hasFlag(name) {
    return argv.includes(`--${name}`);
}
// =============================================================================
// Frustration Detection
// =============================================================================
const FRUSTRATION_PATTERNS = [
    [/\bno[,!]/, "explicit_rejection"],
    [/\bwrong\b/, "wrong"],
    [/\bactually\b/, "correction"],
    [/\bi meant\b/, "clarification"],
    [/\bdon't\b|\bdont\b/, "prohibition"],
    [/\bstop\b/, "stop_request"],
    [/\bwhy\b.{0,20}\bnot\b/, "confusion"],
    [/\bthat's not\b|\bthats not\b/, "negation"],
    [/\bi already\b/, "repetition_frustration"],
    [/\bagain\b/, "repetition"],
    [/\bstill\b.{0,15}\bnot\b/, "persistence_issue"],
];
function detectFrustration(text) {
    if (!text)
        return [];
    const textLower = text.toLowerCase();
    const indicators = [];
    for (const [pattern, indicatorType] of FRUSTRATION_PATTERNS) {
        if (pattern.test(textLower)) {
            indicators.push(indicatorType);
        }
    }
    return indicators;
}
// =============================================================================
// Session Analysis
// =============================================================================
function findSessionById(tmpDir, sessionId) {
    if (!fs.existsSync(tmpDir))
        return null;
    for (const entry of fs.readdirSync(tmpDir)) {
        const entryPath = path.join(tmpDir, entry);
        try {
            if (!fs.statSync(entryPath).isDirectory())
                continue;
        }
        catch {
            continue;
        }
        const chatsDir = path.join(entryPath, "chats");
        if (!fs.existsSync(chatsDir))
            continue;
        // Check for session file by name
        const sessionFile = path.join(chatsDir, `session-${sessionId}.json`);
        if (fs.existsSync(sessionFile))
            return sessionFile;
        // Also check content for matching sessionId
        for (const sf of fs.readdirSync(chatsDir)) {
            if (!sf.startsWith("session-") || !sf.endsWith(".json"))
                continue;
            const sfPath = path.join(chatsDir, sf);
            try {
                const content = fs.readFileSync(sfPath, "utf-8");
                const data = JSON.parse(content);
                if (data["sessionId"] === sessionId)
                    return sfPath;
            }
            catch {
                continue;
            }
        }
    }
    return null;
}
function analyzeSession(sessionPath) {
    let data;
    try {
        const content = fs.readFileSync(sessionPath, "utf-8");
        data = JSON.parse(content);
    }
    catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { error: `Failed to load session: ${message}` };
    }
    const sessionId = data["sessionId"] ?? "unknown";
    const projectHash = data["projectHash"] ??
        path.basename(path.dirname(path.dirname(sessionPath)));
    const messages = data["messages"] ?? [];
    const startTime = data["startTime"] ?? "";
    const lastUpdated = data["lastUpdated"] ?? "";
    if (messages.length === 0) {
        return { error: "No messages in session" };
    }
    // Build turn-by-turn analysis
    const turns = [];
    let currentTurn = null;
    let turnNumber = 0;
    // Aggregate stats
    let totalToolCalls = 0;
    let toolSuccesses = 0;
    let toolCancellations = 0;
    let toolFailures = 0;
    const toolsUsed = {};
    const frustrationTimeline = [];
    for (const msg of messages) {
        const msgType = msg["type"];
        const timestamp = msg["timestamp"] ?? "";
        const content = msg["content"] ?? "";
        if (msgType === "user") {
            // Start a new turn
            if (currentTurn) {
                turns.push(currentTurn);
            }
            turnNumber++;
            const frustration = detectFrustration(content);
            currentTurn = {
                turn: turnNumber,
                timestamp,
                user_message: content.slice(0, 500),
                user_message_full_length: content.length,
                frustration_indicators: frustration,
                agent_responses: [],
                tool_calls: [],
            };
            if (frustration.length > 0) {
                frustrationTimeline.push({
                    turn: turnNumber,
                    timestamp,
                    indicators: frustration,
                    message_preview: content.slice(0, 200),
                });
            }
        }
        else if (msgType === "gemini" && currentTurn) {
            // Add agent response to current turn
            currentTurn.agent_responses.push({
                timestamp,
                content_preview: content.slice(0, 300),
                content_length: content.length,
            });
            // Process tool calls
            const toolCalls = msg["toolCalls"] ?? [];
            for (const tc of toolCalls) {
                const toolName = tc["name"] ?? "unknown";
                const status = tc["status"] ?? "unknown";
                totalToolCalls++;
                toolsUsed[toolName] = (toolsUsed[toolName] ?? 0) + 1;
                if (status === "success" || status === "completed") {
                    toolSuccesses++;
                }
                else if (status === "cancelled") {
                    toolCancellations++;
                }
                else {
                    toolFailures++;
                }
                // Extract error/result info
                let resultPreview = "";
                const result = tc["result"];
                if (result && Array.isArray(result)) {
                    for (const r of result) {
                        const funcResp = r["functionResponse"];
                        const resp = funcResp?.["response"];
                        if (resp) {
                            if (resp["error"]) {
                                resultPreview = `ERROR: ${String(resp["error"]).slice(0, 200)}`;
                            }
                            else if (resp["output"]) {
                                resultPreview = String(resp["output"]).slice(0, 200);
                            }
                        }
                    }
                }
                currentTurn.tool_calls.push({
                    name: toolName,
                    status,
                    timestamp: tc["timestamp"] ?? timestamp,
                    args_preview: JSON.stringify(tc["args"] ?? {}).slice(0, 150),
                    result_preview: resultPreview,
                });
            }
        }
    }
    // Don't forget the last turn
    if (currentTurn) {
        turns.push(currentTurn);
    }
    // Calculate duration
    let durationMinutes = 0;
    if (startTime && lastUpdated) {
        try {
            const start = new Date(startTime).getTime();
            const end = new Date(lastUpdated).getTime();
            durationMinutes =
                Math.round(((end - start) / 60_000) * 10) / 10;
        }
        catch {
            // ignore
        }
    }
    // Identify potential root causes
    const rootCauseCandidates = [];
    if (turns.length > 15) {
        rootCauseCandidates.push({
            type: "high_iteration",
            description: `Session had ${turns.length} turns, indicating significant back-and-forth`,
            severity: turns.length > 25 ? "high" : "medium",
        });
    }
    if (toolCancellations > 3) {
        rootCauseCandidates.push({
            type: "tool_rejection",
            description: `${toolCancellations} tool calls were cancelled by user`,
            severity: "medium",
        });
    }
    if (frustrationTimeline.length > 3) {
        rootCauseCandidates.push({
            type: "user_frustration",
            description: `Detected ${frustrationTimeline.length} instances of user frustration/correction`,
            severity: frustrationTimeline.length > 5 ? "high" : "medium",
        });
    }
    for (const [tool, count] of Object.entries(toolsUsed)) {
        if (count > 5) {
            rootCauseCandidates.push({
                type: "tool_retry_loop",
                description: `Tool '${tool}' was called ${count} times, possibly indicating retries`,
                severity: "medium",
            });
        }
    }
    return {
        session_id: sessionId,
        project_hash: projectHash,
        file_path: sessionPath,
        start_time: startTime,
        duration_minutes: durationMinutes,
        summary: {
            total_turns: turns.length,
            total_messages: messages.length,
            total_tool_calls: totalToolCalls,
            tool_successes: toolSuccesses,
            tool_cancellations: toolCancellations,
            tool_failures: toolFailures,
            frustration_count: frustrationTimeline.length,
        },
        tools_used: toolsUsed,
        frustration_timeline: frustrationTimeline,
        root_cause_candidates: rootCauseCandidates,
        turns,
    };
}
// =============================================================================
// Markdown Formatting
// =============================================================================
function formatAsMarkdown(analysis) {
    const lines = [];
    lines.push(`# Deep Analysis: Session ${analysis.session_id}`);
    lines.push("");
    lines.push("**File:** `" + analysis.file_path + "`");
    lines.push(`**Started:** ${analysis.start_time}`);
    lines.push(`**Duration:** ${analysis.duration_minutes} minutes`);
    lines.push("");
    const summary = analysis.summary;
    lines.push("## Summary");
    lines.push("");
    lines.push(`- **Turns:** ${summary.total_turns}`);
    lines.push(`- **Tool calls:** ${summary.total_tool_calls} (${summary.tool_successes} success, ${summary.tool_cancellations} cancelled)`);
    lines.push(`- **Frustration signals:** ${summary.frustration_count}`);
    lines.push("");
    // Root causes
    const rootCauses = analysis.root_cause_candidates;
    if (rootCauses.length > 0) {
        lines.push("## Root Cause Candidates");
        lines.push("");
        for (const rc of rootCauses) {
            const severityEmoji = rc.severity === "high" ? "🔴" : "🟡";
            lines.push(`- ${severityEmoji} **${rc.type}**: ${rc.description}`);
        }
        lines.push("");
    }
    // Frustration timeline
    const frustration = analysis.frustration_timeline;
    if (frustration.length > 0) {
        lines.push("## Frustration Timeline");
        lines.push("");
        for (const f of frustration.slice(0, 10)) {
            lines.push(`**Turn ${f.turn}** - ${f.indicators.join(", ")}`);
            lines.push(`> ${f.message_preview.slice(0, 150)}...`);
            lines.push("");
        }
    }
    // Key turns
    const turns = analysis.turns;
    if (turns.length > 0) {
        lines.push("## Key Turns");
        lines.push("");
        // First turn
        const first = turns[0];
        lines.push("### Turn 1 (Initial Request)");
        lines.push(`> ${first.user_message.slice(0, 400)}`);
        lines.push("");
        // Frustration turns
        const frustrationTurns = turns.filter((t) => t.frustration_indicators.length > 0);
        if (frustrationTurns.length > 0) {
            lines.push("### Frustration Points");
            for (const t of frustrationTurns.slice(0, 5)) {
                lines.push(`**Turn ${t.turn}** (${t.frustration_indicators.join(", ")})`);
                lines.push(`> ${t.user_message.slice(0, 300)}`);
                lines.push("");
            }
        }
        // Last turn
        if (turns.length > 1) {
            const last = turns[turns.length - 1];
            lines.push(`### Turn ${last.turn} (Final)`);
            lines.push(`> ${last.user_message.slice(0, 400)}`);
            lines.push("");
        }
    }
    return lines.join("\n");
}
// =============================================================================
// Main
// =============================================================================
function main() {
    const sessionId = getArg("session-id");
    const filePath = getArg("file-path");
    const format = getArg("format", "json");
    if (!sessionId && !filePath) {
        console.log(JSON.stringify({ error: "Must provide --session-id or --file-path" }));
        process.exit(1);
    }
    let sessionPath = null;
    if (filePath) {
        if (!fs.existsSync(filePath)) {
            console.log(JSON.stringify({ error: `File not found: ${filePath}` }));
            process.exit(1);
        }
        sessionPath = filePath;
    }
    else {
        const tmpDir = getOb1TmpDir();
        if (!fs.existsSync(tmpDir)) {
            console.log(JSON.stringify({
                error: "OB1 tmp directory not found",
                path: tmpDir,
            }));
            process.exit(1);
        }
        sessionPath = findSessionById(tmpDir, sessionId);
        if (!sessionPath) {
            console.log(JSON.stringify({ error: `Session not found: ${sessionId}` }));
            process.exit(1);
        }
    }
    const analysis = analyzeSession(sessionPath);
    if ("error" in analysis) {
        console.log(JSON.stringify(analysis));
        process.exit(1);
    }
    if (format === "markdown") {
        console.log(formatAsMarkdown(analysis));
    }
    else {
        console.log(JSON.stringify(analysis, null, 2));
    }
}
main();
//# sourceMappingURL=analyze_session_deep.js.map