import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { CORRECTION_PATTERNS_SIMPLE } from "./utils.js";
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
// Path helpers
// =============================================================================
function getCodexSessionsDir() {
    return path.join(os.homedir(), ".codex", "sessions");
}
function getClaudeProjectsDir() {
    return path.join(os.homedir(), ".claude", "projects");
}
// =============================================================================
// File discovery
// =============================================================================
function globJsonlRecursive(dir) {
    const results = [];
    if (!fs.existsSync(dir))
        return results;
    try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                results.push(...globJsonlRecursive(fullPath));
            }
            else if (entry.name.endsWith(".jsonl")) {
                results.push(fullPath);
            }
        }
    }
    catch {
        // ignore
    }
    return results;
}
function findCodexSessionFiles(limit) {
    const sessionsDir = getCodexSessionsDir();
    let files = globJsonlRecursive(sessionsDir);
    // Sort by modification time, newest first
    files.sort((a, b) => {
        try {
            return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
        }
        catch {
            return 0;
        }
    });
    if (limit != null && limit > 0) {
        files = files.slice(0, limit);
    }
    return files;
}
function findClaudeSessionFiles(limit) {
    const projectsDir = getClaudeProjectsDir();
    let files = globJsonlRecursive(projectsDir);
    // Sort by modification time, newest first
    files.sort((a, b) => {
        try {
            return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
        }
        catch {
            return 0;
        }
    });
    if (limit != null && limit > 0) {
        files = files.slice(0, limit);
    }
    return files;
}
// =============================================================================
// Codex session extraction
// =============================================================================
function extractCodexSession(sessionPath) {
    let lines;
    try {
        const content = fs.readFileSync(sessionPath, "utf-8");
        lines = content.split("\n");
    }
    catch {
        return null;
    }
    if (lines.length === 0)
        return null;
    let sessionId = null;
    let cwd = null;
    let model = null;
    let cliVersion = null;
    let modelProvider = null;
    let startTime = null;
    const userMessages = [];
    const toolCalls = [];
    const toolErrors = [];
    const corrections = [];
    let prevAssistantContent = "";
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        let obj;
        try {
            obj = JSON.parse(trimmed);
        }
        catch {
            continue;
        }
        const msgType = obj["type"] ?? "";
        const timestamp = obj["timestamp"] ?? "";
        const payload = obj["payload"] ?? {};
        if (msgType === "session_meta") {
            sessionId = payload["id"] ?? null;
            cwd = payload["cwd"] ?? null;
            cliVersion = payload["cli_version"] ?? null;
            modelProvider = payload["model_provider"] ?? null;
            startTime = timestamp;
        }
        else if (msgType === "turn_context") {
            model = payload["model"] ?? null;
        }
        else if (msgType === "response_item") {
            const payloadType = payload["type"] ?? "";
            const role = payload["role"] ?? "";
            // User message
            if (payloadType === "message" && role === "user") {
                const contentList = payload["content"] ?? [];
                for (const contentBlock of contentList) {
                    if (contentBlock["type"] === "input_text") {
                        const text = contentBlock["text"] ?? "";
                        if (text.startsWith("<environment"))
                            continue;
                        const textLower = text.toLowerCase();
                        const isCorrection = CORRECTION_PATTERNS_SIMPLE.some((p) => textLower.includes(p));
                        userMessages.push({
                            timestamp,
                            content: text.slice(0, 500),
                            is_correction: isCorrection,
                        });
                        if (isCorrection) {
                            corrections.push({
                                timestamp,
                                content: text.slice(0, 300),
                                context: prevAssistantContent.slice(0, 200),
                            });
                        }
                    }
                }
            }
            // Assistant message (for context)
            else if (payloadType === "message" && role === "assistant") {
                const contentList = payload["content"] ?? [];
                for (const contentBlock of contentList) {
                    if (contentBlock["type"] === "output_text") {
                        prevAssistantContent =
                            (contentBlock["text"] ?? "").slice(0, 200);
                        break;
                    }
                }
            }
            // Function/tool call
            else if (payloadType === "function_call") {
                toolCalls.push({
                    name: payload["name"] ?? "unknown",
                    call_id: payload["call_id"] ?? "",
                    timestamp,
                    args_preview: (payload["arguments"] ?? "").slice(0, 100),
                });
            }
            // Function call output (check for errors)
            else if (payloadType === "function_call_output") {
                const output = payload["output"] ?? "";
                if (output.toLowerCase().includes("error") ||
                    output.includes("Error")) {
                    toolErrors.push({
                        call_id: payload["call_id"] ?? "",
                        timestamp,
                        output_preview: output.slice(0, 200),
                    });
                }
            }
        }
    }
    if (userMessages.length === 0)
        return null;
    // Calculate duration
    let durationMinutes = 0;
    if (startTime && lines.length > 0) {
        try {
            // Find last non-empty line
            for (let i = lines.length - 1; i >= 0; i--) {
                const trimmed = lines[i].trim();
                if (!trimmed)
                    continue;
                const lastObj = JSON.parse(trimmed);
                const endTime = lastObj["timestamp"] ?? "";
                if (endTime) {
                    const start = new Date(startTime).getTime();
                    const end = new Date(endTime).getTime();
                    durationMinutes = Math.round(((end - start) / 60000) * 10) / 10;
                    break;
                }
            }
        }
        catch {
            // ignore
        }
    }
    return {
        source: "codex",
        session_id: sessionId ?? path.basename(sessionPath, ".jsonl"),
        file_path: sessionPath,
        cwd,
        model,
        model_provider: modelProvider,
        cli_version: cliVersion,
        start_time: startTime,
        duration_minutes: durationMinutes,
        message_count: lines.filter((l) => l.trim()).length,
        user_message_count: userMessages.length,
        user_messages: userMessages,
        tool_calls: toolCalls,
        tool_errors: toolErrors,
        corrections,
        has_friction: corrections.length > 0 || toolErrors.length > 0,
    };
}
// =============================================================================
// Claude session extraction
// =============================================================================
function extractClaudeSession(sessionPath) {
    let lines;
    try {
        const content = fs.readFileSync(sessionPath, "utf-8");
        lines = content.split("\n");
    }
    catch {
        return null;
    }
    if (lines.length === 0)
        return null;
    let sessionId = null;
    let slug = null;
    const projectPath = path.basename(path.dirname(sessionPath));
    let cwd = null;
    let version = null;
    let model = null;
    let gitBranch = null;
    let startTime = null;
    let permissionMode = null;
    const userMessages = [];
    const toolCalls = [];
    const toolErrors = [];
    const corrections = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let prevAssistantContent = "";
    const pendingToolIds = {};
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        let obj;
        try {
            obj = JSON.parse(trimmed);
        }
        catch {
            continue;
        }
        const timestamp = obj["timestamp"] ?? "";
        if (!startTime && timestamp)
            startTime = timestamp;
        if (!sessionId)
            sessionId = obj["sessionId"] ?? null;
        if (!slug)
            slug = obj["slug"] ?? null;
        if (!cwd)
            cwd = obj["cwd"] ?? null;
        if (!version)
            version = obj["version"] ?? null;
        if (!gitBranch)
            gitBranch = obj["gitBranch"] ?? null;
        if (!permissionMode)
            permissionMode = obj["permissionMode"] ?? null;
        const msgType = obj["type"] ?? "";
        const message = obj["message"] ?? {};
        if (msgType === "file-history-snapshot" || msgType === "progress") {
            continue;
        }
        // User message
        if (msgType === "user") {
            const content = message["content"];
            // Handle string content (regular user message)
            if (typeof content === "string" && content) {
                if (content.toLowerCase() === "warmup" ||
                    content.toLowerCase() === "system") {
                    continue;
                }
                const textLower = content.toLowerCase();
                const isCorrection = CORRECTION_PATTERNS_SIMPLE.some((p) => textLower.includes(p));
                userMessages.push({
                    timestamp,
                    content: content.slice(0, 500),
                    is_correction: isCorrection,
                });
                if (isCorrection) {
                    corrections.push({
                        timestamp,
                        content: content.slice(0, 300),
                        context: prevAssistantContent.slice(0, 200),
                    });
                }
            }
            // Handle array content (tool results)
            else if (Array.isArray(content)) {
                for (const contentBlock of content) {
                    if (typeof contentBlock !== "object" || contentBlock === null) {
                        continue;
                    }
                    const blockType = contentBlock["type"] ?? "";
                    if (blockType === "tool_result") {
                        const toolUseId = contentBlock["tool_use_id"] ?? "";
                        const isError = contentBlock["is_error"] === true;
                        const resultContent = contentBlock["content"];
                        if (isError) {
                            const toolName = pendingToolIds[toolUseId] ?? "unknown";
                            toolErrors.push({
                                tool_use_id: toolUseId,
                                tool_name: toolName,
                                timestamp,
                                error_preview: resultContent
                                    ? String(resultContent).slice(0, 200)
                                    : "Error flag set",
                            });
                        }
                    }
                }
            }
            // Check toolUseResult for additional error info
            const toolUseResult = obj["toolUseResult"];
            if (toolUseResult && typeof toolUseResult === "object") {
                const stderr = toolUseResult["stderr"] ?? "";
                if (stderr &&
                    (stderr.toLowerCase().includes("error") ||
                        stderr.includes("Error"))) {
                    toolErrors.push({
                        timestamp,
                        error_preview: stderr.slice(0, 200),
                        source: "toolUseResult.stderr",
                    });
                }
            }
        }
        // Assistant message
        else if (msgType === "assistant") {
            if (!model)
                model = message["model"] ?? null;
            const usage = message["usage"] ?? {};
            if (Object.keys(usage).length > 0) {
                totalInputTokens += usage["input_tokens"] ?? 0;
                totalOutputTokens += usage["output_tokens"] ?? 0;
            }
            const contentList = message["content"];
            if (Array.isArray(contentList)) {
                for (const contentBlock of contentList) {
                    if (typeof contentBlock !== "object" || contentBlock === null) {
                        continue;
                    }
                    const blockType = contentBlock["type"] ?? "";
                    if (blockType === "text") {
                        prevAssistantContent = (contentBlock["text"] ?? "").slice(0, 200);
                    }
                    else if (blockType === "tool_use") {
                        const toolId = contentBlock["id"] ?? "";
                        const toolName = contentBlock["name"] ?? "unknown";
                        pendingToolIds[toolId] = toolName;
                        toolCalls.push({
                            name: toolName,
                            timestamp,
                            id: toolId,
                            input_preview: JSON.stringify(contentBlock["input"] ?? {}).slice(0, 100),
                        });
                    }
                }
            }
        }
    }
    if (userMessages.length === 0)
        return null;
    // Calculate duration
    let durationMinutes = 0;
    if (startTime) {
        try {
            for (let i = lines.length - 1; i >= 0; i--) {
                const trimmed = lines[i].trim();
                if (!trimmed)
                    continue;
                const lastObj = JSON.parse(trimmed);
                const endTime = lastObj["timestamp"] ?? "";
                if (endTime) {
                    const start = new Date(startTime).getTime();
                    const end = new Date(endTime).getTime();
                    durationMinutes = Math.round(((end - start) / 60000) * 10) / 10;
                    break;
                }
            }
        }
        catch {
            // ignore
        }
    }
    const nonEmptyLineCount = lines.filter((l) => l.trim()).length;
    return {
        source: "claude",
        session_id: sessionId ?? path.basename(sessionPath, ".jsonl"),
        slug,
        project_path: projectPath,
        cwd,
        file_path: sessionPath,
        version,
        model,
        git_branch: gitBranch,
        permission_mode: permissionMode,
        start_time: startTime,
        duration_minutes: durationMinutes,
        message_count: nonEmptyLineCount,
        user_message_count: userMessages.length,
        user_messages: userMessages,
        tool_calls: toolCalls,
        tool_call_count: toolCalls.length,
        tool_errors: toolErrors,
        tool_error_count: toolErrors.length,
        corrections,
        correction_count: corrections.length,
        total_input_tokens: totalInputTokens,
        total_output_tokens: totalOutputTokens,
        has_friction: corrections.length > 0 || toolErrors.length > 0,
    };
}
// =============================================================================
// Main
// =============================================================================
function main() {
    const limit = parseInt(getArg("limit", "50") ?? "50", 10);
    const source = getArg("source", "all") ?? "all";
    const frictionOnly = hasFlag("friction-only");
    const summaryMode = hasFlag("summary");
    const sessions = [];
    const sourcesFound = {};
    // Extract Codex sessions
    if (source === "codex" || source === "all") {
        const codexFiles = findCodexSessionFiles(limit);
        sourcesFound["codex"] = codexFiles.length;
        for (const sf of codexFiles) {
            const sessionData = extractCodexSession(sf);
            if (sessionData) {
                if (frictionOnly && !sessionData["has_friction"])
                    continue;
                sessions.push(sessionData);
            }
        }
    }
    // Extract Claude sessions
    if (source === "claude" || source === "all") {
        const claudeFiles = findClaudeSessionFiles(limit);
        sourcesFound["claude"] = claudeFiles.length;
        for (const sf of claudeFiles) {
            const sessionData = extractClaudeSession(sf);
            if (sessionData) {
                if (frictionOnly && !sessionData["has_friction"])
                    continue;
                sessions.push(sessionData);
            }
        }
    }
    if (summaryMode) {
        const codexSessions = sessions.filter((s) => s["source"] === "codex");
        const claudeSessions = sessions.filter((s) => s["source"] === "claude");
        const summary = {
            sources_scanned: sourcesFound,
            codex: {
                sessions_found: sourcesFound["codex"] ?? 0,
                sessions_parsed: codexSessions.length,
                sessions_with_friction: codexSessions.filter((s) => s["has_friction"]).length,
                total_corrections: codexSessions.reduce((sum, s) => sum + (s["corrections"] ?? []).length, 0),
                path: getCodexSessionsDir(),
                exists: fs.existsSync(getCodexSessionsDir()),
            },
            claude: {
                sessions_found: sourcesFound["claude"] ?? 0,
                sessions_parsed: claudeSessions.length,
                sessions_with_friction: claudeSessions.filter((s) => s["has_friction"]).length,
                total_corrections: claudeSessions.reduce((sum, s) => sum + (s["corrections"] ?? []).length, 0),
                path: getClaudeProjectsDir(),
                exists: fs.existsSync(getClaudeProjectsDir()),
            },
            total_sessions: sessions.length,
            total_with_friction: sessions.filter((s) => s["has_friction"])
                .length,
        };
        console.log(JSON.stringify(summary, null, 2));
    }
    else {
        console.log(JSON.stringify(sessions, null, 2));
    }
}
main();
//# sourceMappingURL=extract_external_sessions.js.map