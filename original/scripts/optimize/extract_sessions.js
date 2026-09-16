import * as fs from "node:fs";
import * as path from "node:path";
import { getOb1TmpDir, findSessionFiles, CORRECTION_PATTERNS_SIMPLE, } from "./utils.js";
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
// File path pattern for detecting file references in prompts
// =============================================================================
const FILE_PATH_PATTERN = /[/\]?(?:[\w\-.]+[/\])*[\w\-]+\.(ts|tsx|js|jsx|py|go|rs|java|rb|cpp|c|h|hpp|css|scss|html|json|yaml|yml|md|sql|sh|bash)/g;
const STACK_MAPPING = {
    ".ts": "TypeScript",
    ".tsx": "TypeScript/React",
    ".js": "JavaScript",
    ".jsx": "JavaScript/React",
    ".py": "Python",
    ".go": "Go",
    ".rs": "Rust",
    ".java": "Java",
    ".rb": "Ruby",
    ".cpp": "C++",
    ".c": "C",
    ".h": "C/C++",
    ".hpp": "C++",
    ".css": "CSS",
    ".scss": "SCSS",
    ".html": "HTML",
};
const EXT_PATTERN = /\.(ts|tsx|js|jsx|py|go|rs|java|rb|cpp|c|h|hpp|css|scss|html|json|yaml|yml|md|sql|sh|bash)$/;
function extractSessionData(sessionPath) {
    let data;
    try {
        const raw = fs.readFileSync(sessionPath, "utf-8");
        data = JSON.parse(raw);
    }
    catch {
        return null;
    }
    const sessionId = data["sessionId"] ?? "unknown";
    const projectHash = data["projectHash"] ??
        path.basename(path.dirname(path.dirname(sessionPath)));
    const messages = data["messages"] ?? [];
    if (messages.length === 0)
        return null;
    // Calculate duration
    const startTime = data["startTime"] ?? null;
    const lastUpdated = data["lastUpdated"] ?? null;
    let durationMinutes = 0;
    if (startTime && lastUpdated) {
        try {
            const start = new Date(startTime).getTime();
            const end = new Date(lastUpdated).getTime();
            durationMinutes = Math.round(((end - start) / 60000) * 10) / 10;
        }
        catch {
            // ignore
        }
    }
    const userMessages = [];
    const toolCalls = [];
    const cancellations = [];
    const corrections = [];
    const promptLengths = [];
    let promptsWithFilePaths = 0;
    const fileExtensionsSeen = {};
    let prevAssistantContent = "";
    for (const msg of messages) {
        const msgType = msg["type"] ?? "";
        const timestamp = msg["timestamp"] ?? "";
        const content = msg["content"] ?? "";
        if (msgType === "user") {
            const contentLower = content ? content.toLowerCase() : "";
            const isCorrection = CORRECTION_PATTERNS_SIMPLE.some((p) => contentLower.includes(p));
            if (content) {
                promptLengths.push(content.length);
                // Reset lastIndex for global regex
                FILE_PATH_PATTERN.lastIndex = 0;
                if (FILE_PATH_PATTERN.test(content)) {
                    promptsWithFilePaths++;
                    FILE_PATH_PATTERN.lastIndex = 0;
                    let match;
                    while ((match = FILE_PATH_PATTERN.exec(content)) !== null) {
                        const ext = "." + match[1];
                        fileExtensionsSeen[ext] = (fileExtensionsSeen[ext] ?? 0) + 1;
                    }
                }
            }
            userMessages.push({
                timestamp,
                content: content ? content.slice(0, 500) : "",
                is_correction: isCorrection,
            });
            if (isCorrection) {
                corrections.push({
                    timestamp,
                    content: content ? content.slice(0, 300) : "",
                    context: prevAssistantContent ? prevAssistantContent.slice(0, 200) : "",
                });
            }
        }
        else if (msgType === "gemini") {
            prevAssistantContent = content ? content.slice(0, 200) : "";
            const tcs = msg["toolCalls"] ?? [];
            for (const tc of tcs) {
                const toolName = tc["name"] ?? "unknown";
                const tcStatus = tc["status"] ?? "unknown";
                const tcTimestamp = tc["timestamp"] ?? timestamp;
                const tcArgs = tc["args"] ?? {};
                toolCalls.push({
                    name: toolName,
                    status: tcStatus,
                    timestamp: tcTimestamp,
                    args_preview: JSON.stringify(tcArgs).slice(0, 100),
                });
                // Track file extensions from file operations for stack detection
                if (["read_file", "replace", "write_file", "glob"].includes(toolName)) {
                    const filePath = tcArgs["file_path"] ??
                        tcArgs["pattern"] ??
                        "";
                    if (filePath) {
                        const extMatch = filePath.match(EXT_PATTERN);
                        if (extMatch) {
                            const ext = "." + extMatch[1];
                            fileExtensionsSeen[ext] = (fileExtensionsSeen[ext] ?? 0) + 1;
                        }
                    }
                }
                // Track cancellations with context
                if (tcStatus === "cancelled") {
                    let feedback = "";
                    const result = tc["result"];
                    if (result && Array.isArray(result)) {
                        for (const r of result) {
                            const funcResp = r["functionResponse"] ?? {};
                            const resp = funcResp["response"];
                            if (resp && typeof resp === "object") {
                                const error = resp["error"] ?? "";
                                if (error.toLowerCase().includes("user said:")) {
                                    feedback = error;
                                }
                            }
                        }
                    }
                    cancellations.push({
                        tool_name: toolName,
                        timestamp: tcTimestamp,
                        args_preview: JSON.stringify(tcArgs).slice(0, 150),
                        user_feedback: feedback,
                        display_name: tc["displayName"] ?? "",
                    });
                }
            }
        }
    }
    // Calculate prompt characteristics
    const avgPromptLength = promptLengths.length > 0
        ? Math.round((promptLengths.reduce((a, b) => a + b, 0) / promptLengths.length) *
            10) / 10
        : 0;
    // Extract time-of-day from start_time
    let hourOfDay = null;
    let timeOfDayBucket = null;
    if (startTime) {
        try {
            const dt = new Date(startTime);
            hourOfDay = dt.getHours();
            if (hourOfDay >= 5 && hourOfDay < 12) {
                timeOfDayBucket = "morning";
            }
            else if (hourOfDay >= 12 && hourOfDay < 17) {
                timeOfDayBucket = "afternoon";
            }
            else if (hourOfDay >= 17 && hourOfDay < 21) {
                timeOfDayBucket = "evening";
            }
            else {
                timeOfDayBucket = "night";
            }
        }
        catch {
            // ignore
        }
    }
    // Infer primary tech stack from file extensions
    let primaryStack = null;
    const extEntries = Object.entries(fileExtensionsSeen);
    if (extEntries.length > 0) {
        const topExt = extEntries.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
        primaryStack = STACK_MAPPING[topExt] ?? topExt;
    }
    return {
        session_id: sessionId,
        project_hash: projectHash,
        file_path: sessionPath,
        start_time: startTime,
        duration_minutes: durationMinutes,
        message_count: messages.length,
        user_message_count: userMessages.length,
        user_messages: userMessages,
        tool_calls: toolCalls,
        cancellations,
        corrections,
        has_friction: cancellations.length > 0 || corrections.length > 0,
        prompt_characteristics: {
            avg_prompt_length: avgPromptLength,
            prompts_with_file_paths: promptsWithFilePaths,
            file_path_mention_rate: userMessages.length > 0
                ? Math.round((promptsWithFilePaths / userMessages.length) * 1000) /
                    1000
                : 0,
        },
        time_of_day: {
            hour: hourOfDay,
            bucket: timeOfDayBucket,
        },
        stack_detection: {
            file_extensions: fileExtensionsSeen,
            primary_stack: primaryStack,
        },
    };
}
// =============================================================================
// Main
// =============================================================================
function main() {
    const limit = parseInt(getArg("limit", "100") ?? "100", 10);
    const projectHash = getArg("project-hash");
    const frictionOnly = hasFlag("friction-only");
    const summaryMode = hasFlag("summary");
    const tmpDir = getOb1TmpDir();
    if (!fs.existsSync(tmpDir)) {
        console.log(JSON.stringify({ error: "OB1 tmp directory not found", path: tmpDir }));
        process.exit(1);
    }
    const sessionFiles = findSessionFiles(tmpDir, projectHash, limit);
    const sessions = [];
    for (const sf of sessionFiles) {
        const sessionData = extractSessionData(sf);
        if (sessionData) {
            if (frictionOnly && !sessionData.has_friction)
                continue;
            sessions.push(sessionData);
        }
    }
    if (summaryMode) {
        const totalSessions = sessions.length;
        const sessionsWithFriction = sessions.filter((s) => s.has_friction).length;
        const totalCancellations = sessions.reduce((sum, s) => sum + s.cancellations.length, 0);
        const totalCorrections = sessions.reduce((sum, s) => sum + s.corrections.length, 0);
        const projects = new Set(sessions.map((s) => s.project_hash));
        // Aggregate prompt characteristics
        const allPromptLengths = sessions
            .filter((s) => s.prompt_characteristics)
            .map((s) => s.prompt_characteristics.avg_prompt_length);
        const avgPromptLength = allPromptLengths.length > 0
            ? Math.round((allPromptLengths.reduce((a, b) => a + b, 0) /
                allPromptLengths.length) *
                10) / 10
            : 0;
        const totalPromptsWithPaths = sessions.reduce((sum, s) => sum + s.prompt_characteristics.prompts_with_file_paths, 0);
        // Time-of-day distribution
        const timeDistribution = {
            morning: 0,
            afternoon: 0,
            evening: 0,
            night: 0,
        };
        for (const s of sessions) {
            const bucket = s.time_of_day.bucket;
            if (bucket && bucket in timeDistribution) {
                timeDistribution[bucket]++;
            }
        }
        // Aggregate file extensions across sessions for stack detection
        const allExtensions = {};
        for (const s of sessions) {
            for (const [ext, count] of Object.entries(s.stack_detection.file_extensions)) {
                allExtensions[ext] = (allExtensions[ext] ?? 0) + count;
            }
        }
        // Determine primary stack
        let primaryStack = null;
        const extEntries = Object.entries(allExtensions);
        if (extEntries.length > 0) {
            const topExt = extEntries.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
            const summaryStackMapping = {
                ".ts": "TypeScript",
                ".tsx": "TypeScript/React",
                ".js": "JavaScript",
                ".jsx": "JavaScript/React",
                ".py": "Python",
                ".go": "Go",
                ".rs": "Rust",
                ".java": "Java",
                ".rb": "Ruby",
                ".cpp": "C++",
                ".c": "C",
            };
            primaryStack = summaryStackMapping[topExt] ?? topExt;
        }
        // Sort extensions by count descending and take top 10
        const sortedExtensions = Object.fromEntries(extEntries.sort((a, b) => b[1] - a[1]).slice(0, 10));
        const summary = {
            total_sessions: totalSessions,
            sessions_with_friction: sessionsWithFriction,
            total_cancellations: totalCancellations,
            total_corrections: totalCorrections,
            unique_projects: projects.size,
            project_hashes: [...projects].slice(0, 10),
            date_range: {
                oldest: sessions.length > 0
                    ? sessions[sessions.length - 1].start_time
                    : null,
                newest: sessions.length > 0 ? sessions[0].start_time : null,
            },
            prompt_characteristics: {
                avg_prompt_length: avgPromptLength,
                total_prompts_with_file_paths: totalPromptsWithPaths,
            },
            time_of_day_distribution: timeDistribution,
            stack_detection: {
                file_extensions: sortedExtensions,
                primary_stack: primaryStack,
            },
        };
        console.log(JSON.stringify(summary, null, 2));
    }
    else {
        console.log(JSON.stringify(sessions, null, 2));
    }
}
main();
//# sourceMappingURL=extract_sessions.js.map