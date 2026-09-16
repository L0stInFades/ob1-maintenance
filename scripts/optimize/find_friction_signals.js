import * as fs from "node:fs";
import { loadSessionMetrics, getOb1TmpDir, findSessionFiles, detectCorrectionType, } from "./utils.js";
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
// Helpers
// =============================================================================
function normalizeToolArgs(args) {
    if (!args || Object.keys(args).length === 0)
        return "";
    const filePath = args["file_path"] ??
        args["dir_path"] ??
        args["pattern"] ??
        "";
    const oldString = args["old_string"] ?? "";
    const oldLenBucket = oldString
        ? Math.floor(oldString.length / 50) * 50
        : 0;
    const command = args["command"] ?? "";
    const cmdPrefix = command ? command.split(/\s+/)[0] : "";
    return `${filePath}|${oldLenBucket}|${cmdPrefix}`;
}
function detectLoops(toolCalls, threshold = 3) {
    const loops = [];
    if (toolCalls.length < threshold)
        return loops;
    // Track recent tool call patterns
    const recentPatterns = [];
    for (const tc of toolCalls) {
        const toolName = tc["name"] ?? "unknown";
        const args = tc["args"] ?? {};
        const pattern = `${toolName}:${normalizeToolArgs(args)}`;
        recentPatterns.push({
            pattern,
            tool_name: toolName,
            timestamp: tc["timestamp"] ?? "",
            status: tc["status"] ?? "",
        });
    }
    // Detect consecutive similar patterns
    let i = 0;
    while (i < recentPatterns.length) {
        const pattern = recentPatterns[i].pattern;
        let count = 1;
        let j = i + 1;
        while (j < recentPatterns.length &&
            recentPatterns[j].pattern === pattern) {
            count++;
            j++;
        }
        if (count >= threshold) {
            loops.push({
                type: "consecutive_retry",
                tool_name: recentPatterns[i].tool_name,
                count,
                pattern,
                timestamps: recentPatterns
                    .slice(i, j)
                    .map((p) => p.timestamp),
            });
        }
        i = j > i + 1 ? j : i + 1;
    }
    // Detect fix→break→fix cycles (alternating success/failure on same target)
    const toolNames = new Set(toolCalls.map((tc) => tc["name"] ?? ""));
    for (const toolName of toolNames) {
        const toolSpecific = toolCalls.filter((tc) => tc["name"] === toolName);
        if (toolSpecific.length >= 4) {
            const fileEdits = {};
            for (const tc of toolSpecific) {
                const args = tc["args"] ?? {};
                const filePath = args["file_path"] ?? "";
                if (filePath) {
                    if (!fileEdits[filePath])
                        fileEdits[filePath] = [];
                    fileEdits[filePath].push(tc);
                }
            }
            for (const [filePath, edits] of Object.entries(fileEdits)) {
                if (edits.length >= 4) {
                    loops.push({
                        type: "fix_break_fix_cycle",
                        tool_name: toolName,
                        file_path: filePath,
                        edit_count: edits.length,
                        timestamps: edits
                            .slice(0, 5)
                            .map((e) => e["timestamp"] ?? ""),
                    });
                }
            }
        }
    }
    return loops;
}
// =============================================================================
// Session friction extraction
// =============================================================================
function extractFrictionFromSession(sessionPath) {
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
        sessionPath.split("/").slice(-3, -2)[0] ??
        "unknown";
    const messages = data["messages"] ?? [];
    const startTime = data["startTime"] ?? "";
    if (messages.length === 0)
        return null;
    const frictionSignals = [];
    const toolStats = {};
    const allToolCalls = [];
    let prevAssistantContent = "";
    let prevToolCalls = [];
    function getToolStats(name) {
        if (!toolStats[name]) {
            toolStats[name] = {
                approved: 0,
                auto_approved: 0,
                manual_approved: 0,
                cancelled: 0,
                with_feedback: 0,
            };
        }
        return toolStats[name];
    }
    for (const msg of messages) {
        const msgType = msg["type"] ?? "";
        const timestamp = msg["timestamp"] ?? "";
        const content = msg["content"] ?? "";
        if (msgType === "user") {
            const [correctionType, matched] = detectCorrectionType(content);
            if (correctionType) {
                frictionSignals.push({
                    type: "correction",
                    subtype: correctionType,
                    timestamp,
                    content: content.slice(0, 400),
                    matched_pattern: matched,
                    context: {
                        prev_assistant: prevAssistantContent.slice(0, 200),
                        prev_tools: prevToolCalls
                            .slice(-3)
                            .map((t) => t["name"] ?? ""),
                    },
                    session_id: sessionId,
                    file_path: sessionPath,
                });
            }
        }
        else if (msgType === "gemini") {
            prevAssistantContent = content ? content.slice(0, 300) : "";
            prevToolCalls = [];
            const tcs = msg["toolCalls"] ?? [];
            for (const tc of tcs) {
                const toolName = tc["name"] ?? "unknown";
                const status = tc["status"] ?? "unknown";
                const autoApproved = tc["autoApproved"];
                prevToolCalls.push(tc);
                allToolCalls.push(tc);
                const stats = getToolStats(toolName);
                if (status === "success" || status === "completed") {
                    stats.approved++;
                    if (autoApproved === true) {
                        stats.auto_approved++;
                    }
                    else if (autoApproved === false) {
                        stats.manual_approved++;
                    }
                }
                else if (status === "cancelled") {
                    stats.cancelled++;
                    let feedback = "";
                    const result = tc["result"];
                    if (result && Array.isArray(result)) {
                        for (const r of result) {
                            const funcResp = r["functionResponse"] ?? {};
                            const resp = funcResp["response"];
                            if (resp && typeof resp === "object") {
                                const error = resp["error"] ?? "";
                                if (error)
                                    feedback = error;
                            }
                        }
                    }
                    const hasUserFeedback = feedback
                        ? feedback.toLowerCase().includes("user said:")
                        : false;
                    if (hasUserFeedback) {
                        stats.with_feedback++;
                    }
                    frictionSignals.push({
                        type: "tool_cancellation",
                        tool_name: toolName,
                        timestamp: tc["timestamp"] ?? timestamp,
                        args_preview: JSON.stringify(tc["args"] ?? {}).slice(0, 200),
                        has_user_feedback: hasUserFeedback,
                        feedback: feedback ? feedback.slice(0, 300) : "",
                        session_id: sessionId,
                        file_path: sessionPath,
                    });
                }
            }
        }
    }
    // Detect loops
    const loops = detectLoops(allToolCalls);
    for (const loop of loops) {
        frictionSignals.push({
            type: "loop",
            subtype: loop.type,
            tool_name: loop.tool_name,
            count: loop.count ?? loop.edit_count ?? 0,
            file_path_target: loop.file_path ?? loop.pattern ?? "",
            timestamps: loop.timestamps,
            session_id: sessionId,
            file_path: sessionPath,
        });
    }
    if (frictionSignals.length === 0)
        return null;
    return {
        session_id: sessionId,
        project_hash: projectHash,
        file_path: sessionPath,
        start_time: startTime,
        friction_count: frictionSignals.length,
        friction_signals: frictionSignals,
        tool_stats: toolStats,
    };
}
function aggregateFriction(sessions) {
    const correctionsByType = {};
    const cancellationsByTool = {};
    const loopsByType = {};
    const toolStatsTotal = {};
    const sessionsWithFriction = [];
    function getStats(name) {
        if (!toolStatsTotal[name]) {
            toolStatsTotal[name] = {
                approved: 0,
                auto_approved: 0,
                manual_approved: 0,
                cancelled: 0,
                with_feedback: 0,
            };
        }
        return toolStatsTotal[name];
    }
    for (const session of sessions) {
        if (!session)
            continue;
        sessionsWithFriction.push({
            session_id: session.session_id,
            file_path: session.file_path,
            start_time: session.start_time,
            friction_count: session.friction_count,
        });
        for (const signal of session.friction_signals) {
            if (signal.type === "correction") {
                const subtype = signal.subtype ?? "unknown";
                if (!correctionsByType[subtype])
                    correctionsByType[subtype] = [];
                correctionsByType[subtype].push({
                    content: signal.content ?? "",
                    timestamp: signal.timestamp ?? "",
                    session_id: signal.session_id,
                    file_path: signal.file_path,
                    context: signal.context ?? {},
                });
            }
            else if (signal.type === "tool_cancellation") {
                const toolName = signal.tool_name ?? "unknown";
                if (!cancellationsByTool[toolName])
                    cancellationsByTool[toolName] = [];
                cancellationsByTool[toolName].push({
                    timestamp: signal.timestamp ?? "",
                    session_id: signal.session_id,
                    file_path: signal.file_path,
                    has_feedback: signal.has_user_feedback ?? false,
                    feedback: signal.feedback ?? "",
                    args_preview: signal.args_preview ?? "",
                });
            }
            else if (signal.type === "loop") {
                const subtype = signal.subtype ?? "unknown";
                if (!loopsByType[subtype])
                    loopsByType[subtype] = [];
                loopsByType[subtype].push({
                    tool_name: signal.tool_name ?? "",
                    count: signal.count ?? 0,
                    file_path_target: signal.file_path_target ?? "",
                    session_id: signal.session_id,
                    file_path: signal.file_path,
                    timestamps: signal.timestamps ?? [],
                });
            }
        }
        for (const [tool, stats] of Object.entries(session.tool_stats)) {
            const total = getStats(tool);
            total.approved += stats.approved;
            total.auto_approved += stats.auto_approved;
            total.manual_approved += stats.manual_approved;
            total.cancelled += stats.cancelled;
            total.with_feedback += stats.with_feedback;
        }
    }
    // Calculate approval fatigue candidates
    const approvalFatigueCandidates = [];
    for (const [tool, stats] of Object.entries(toolStatsTotal)) {
        const manualApproved = stats.manual_approved;
        const total = stats.approved + stats.cancelled;
        if (manualApproved >= 8 && stats.cancelled <= 2) {
            approvalFatigueCandidates.push({
                tool,
                total_approved: stats.approved,
                manual_approved: manualApproved,
                auto_approved: stats.auto_approved,
                cancelled: stats.cancelled,
                approval_rate: total > 0
                    ? Math.round((stats.approved / total) * 1000) / 10
                    : 100.0,
            });
        }
    }
    approvalFatigueCandidates.sort((a, b) => b["manual_approved"] - a["manual_approved"]);
    // Sort corrections, cancellations, loops by count descending
    const sortedCorrections = Object.entries(correctionsByType)
        .sort((a, b) => b[1].length - a[1].length)
        .reduce((acc, [k, v]) => {
        acc[k] = { count: v.length, examples: v.slice(0, 5) };
        return acc;
    }, {});
    const sortedCancellations = Object.entries(cancellationsByTool)
        .sort((a, b) => b[1].length - a[1].length)
        .reduce((acc, [k, v]) => {
        acc[k] = {
            count: v.length,
            with_feedback: v.filter((x) => x.has_feedback).length,
            examples: v.slice(0, 5),
        };
        return acc;
    }, {});
    const sortedLoops = Object.entries(loopsByType)
        .sort((a, b) => b[1].length - a[1].length)
        .reduce((acc, [k, v]) => {
        acc[k] = {
            count: v.length,
            total_iterations: v.reduce((sum, x) => sum + x.count, 0),
            examples: v.slice(0, 5),
        };
        return acc;
    }, {});
    return {
        summary: {
            total_sessions_analyzed: sessions.length,
            sessions_with_friction: sessionsWithFriction.length,
            total_corrections: Object.values(correctionsByType).reduce((sum, v) => sum + v.length, 0),
            total_cancellations: Object.values(cancellationsByTool).reduce((sum, v) => sum + v.length, 0),
            total_loops: Object.values(loopsByType).reduce((sum, v) => sum + v.length, 0),
        },
        corrections_by_type: sortedCorrections,
        cancellations_by_tool: sortedCancellations,
        loops_by_type: sortedLoops,
        tool_stats: toolStatsTotal,
        approval_fatigue_candidates: approvalFatigueCandidates.slice(0, 5),
        sessions_with_friction: sessionsWithFriction.slice(0, 20),
    };
}
// =============================================================================
// High-turn analysis
// =============================================================================
function countTurns(messages) {
    let turns = 0;
    let prevWasUser = false;
    for (const msg of messages) {
        const msgType = msg["type"] ?? "";
        if (msgType === "user") {
            turns++;
            prevWasUser = true;
        }
        else if (msgType === "gemini" && prevWasUser) {
            prevWasUser = false;
        }
    }
    return turns;
}
function extractSessionMetadata(sessionPath) {
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
        sessionPath.split("/").slice(-3, -2)[0] ??
        "unknown";
    const messages = data["messages"] ?? [];
    const startTime = data["startTime"] ?? "";
    if (messages.length === 0)
        return null;
    const turns = countTurns(messages);
    let firstUserMsg = "";
    for (const msg of messages) {
        if (msg["type"] === "user") {
            firstUserMsg = (msg["content"] ?? "").slice(0, 300);
            break;
        }
    }
    return {
        session_id: sessionId,
        project_hash: projectHash,
        file_path: sessionPath,
        start_time: startTime,
        turn_count: turns,
        message_count: messages.length,
        first_user_message: firstUserMsg,
    };
}
// =============================================================================
// Metrics enrichment
// =============================================================================
function enrichWithMetrics(aggregated) {
    const metricsData = loadSessionMetrics();
    if (!metricsData) {
        aggregated["metrics_enrichment"] = {
            available: false,
            reason: "session_metrics.json not found",
        };
        return aggregated;
    }
    const sessions = metricsData["sessions"] ?? {};
    if (Object.keys(sessions).length === 0) {
        aggregated["metrics_enrichment"] = {
            available: false,
            reason: "No sessions in session_metrics.json",
        };
        return aggregated;
    }
    const sessionList = Object.values(sessions);
    // Identify high-friction sessions from metrics
    const highFrictionMetrics = [];
    for (const s of sessionList) {
        const steering = s["steeringRatio"] ?? 0;
        const corrections = s["correctionTurns"] ?? 0;
        const cancellations = s["toolCancellations"] ?? 0;
        const patterns = s["frictionPatterns"] ?? [];
        if (steering > 0.15 || corrections > 2 || cancellations > 2) {
            highFrictionMetrics.push({
                sessionId: s["sessionId"] ?? "unknown",
                steeringRatio: typeof steering === "number"
                    ? Math.round(steering * 1000) / 1000
                    : steering,
                correctionTurns: corrections,
                toolCancellations: cancellations,
                frictionPatterns: patterns,
                totalTurns: s["totalTurns"] ?? 0,
                totalTokens: s["totalTokens"] ?? 0,
            });
        }
    }
    highFrictionMetrics.sort((a, b) => -(a["steeringRatio"] ?? 0) +
        (b["steeringRatio"] ?? 0) ||
        -(a["correctionTurns"] ?? 0) +
            (b["correctionTurns"] ?? 0));
    // Identify high-value sessions
    const highValue = [];
    for (const s of sessionList) {
        const prs = s["prsSubmitted"] ?? 0;
        const toolExecs = s["toolExecutions"] ?? 0;
        const toolErrors = s["toolErrors"] ?? 0;
        const steering = s["steeringRatio"] ?? 0;
        const turns = s["totalTurns"] ?? 0;
        const toolSuccessRate = toolExecs === 0 ? 1.0 : (toolExecs - toolErrors) / toolExecs;
        let valueScore = 0.0;
        if (prs > 0)
            valueScore += 10 * prs;
        if (toolExecs >= 5 && toolSuccessRate > 0.8)
            valueScore += 3;
        if (steering < 0.1 && turns >= 3)
            valueScore += 2;
        if (toolExecs >= 10 && toolErrors === 0)
            valueScore += 2;
        if (valueScore > 0) {
            highValue.push({
                sessionId: s["sessionId"] ?? "unknown",
                valueScore: Math.round(valueScore * 100) / 100,
                prsSubmitted: prs,
                toolExecutions: toolExecs,
                toolSuccessRate: Math.round(toolSuccessRate * 1000) / 1000,
                steeringRatio: typeof steering === "number"
                    ? Math.round(steering * 1000) / 1000
                    : steering,
                totalTurns: turns,
            });
        }
    }
    highValue.sort((a, b) => b["valueScore"] - a["valueScore"]);
    // Calculate efficiency summary
    const activeSessions = sessionList.filter((s) => (s["totalTurns"] ?? 0) > 0);
    let efficiency = {};
    if (activeSessions.length > 0) {
        const totalSessions = activeSessions.length;
        const totalPrs = activeSessions.reduce((sum, s) => sum + (s["prsSubmitted"] ?? 0), 0);
        const avgSteering = activeSessions.reduce((sum, s) => sum + (s["steeringRatio"] ?? 0), 0) / totalSessions;
        const totalCorrections = activeSessions.reduce((sum, s) => sum + (s["correctionTurns"] ?? 0), 0);
        const totalCancellations = activeSessions.reduce((sum, s) => sum + (s["toolCancellations"] ?? 0), 0);
        efficiency = {
            totalSessions,
            totalPrsSubmitted: totalPrs,
            avgSteeringRatio: Math.round(avgSteering * 1000) / 1000,
            totalCorrections,
            totalCancellations,
        };
    }
    aggregated["metrics_enrichment"] = {
        available: true,
        sessionsInMetrics: sessionList.length,
        efficiency,
        highFrictionFromMetrics: {
            count: highFrictionMetrics.length,
            sessions: highFrictionMetrics.slice(0, 10),
        },
        highValueSessions: {
            count: highValue.length,
            sessions: highValue.slice(0, 10),
            indicators: [
                "PR submissions indicate code that reached review",
                "High tool success rate shows task understanding",
                "Low steering ratio shows efficient completion",
            ],
        },
    };
    return aggregated;
}
// =============================================================================
// Main
// =============================================================================
function main() {
    const limit = parseInt(getArg("limit", "100") ?? "100", 10);
    const projectHash = getArg("project-hash");
    const raw = hasFlag("raw");
    const highTurnThreshold = parseInt(getArg("high-turn-threshold", "15") ?? "15", 10);
    const includeMetrics = hasFlag("include-metrics");
    const tmpDir = getOb1TmpDir();
    if (!fs.existsSync(tmpDir)) {
        console.log(JSON.stringify({ error: "OB1 tmp directory not found", path: tmpDir }));
        process.exit(1);
    }
    const sessionFiles = findSessionFiles(tmpDir, projectHash, limit);
    // Extract friction signals
    const sessionsWithFriction = [];
    for (const sf of sessionFiles) {
        const frictionData = extractFrictionFromSession(sf);
        if (frictionData) {
            sessionsWithFriction.push(frictionData);
        }
    }
    // Detect high-turn sessions
    const highTurnSessions = [];
    for (const sf of sessionFiles) {
        const metadata = extractSessionMetadata(sf);
        if (metadata && metadata.turn_count >= highTurnThreshold) {
            highTurnSessions.push(metadata);
        }
    }
    highTurnSessions.sort((a, b) => b.turn_count - a.turn_count);
    if (raw) {
        console.log(JSON.stringify(sessionsWithFriction, null, 2));
    }
    else {
        let aggregated = aggregateFriction(sessionsWithFriction);
        // Add high-turn sessions to output
        aggregated["high_turn_sessions"] = {
            threshold: highTurnThreshold,
            count: highTurnSessions.length,
            sessions: highTurnSessions.slice(0, 10),
        };
        aggregated["summary"]["high_turn_session_count"] = highTurnSessions.length;
        if (includeMetrics) {
            aggregated = enrichWithMetrics(aggregated);
        }
        console.log(JSON.stringify(aggregated, null, 2));
    }
}
main();
//# sourceMappingURL=find_friction_signals.js.map