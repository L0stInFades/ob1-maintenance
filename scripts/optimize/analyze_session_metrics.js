import { getSessionMetricsPath, loadSessionMetrics, } from "./utils.js";
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
// =============================================================================
// Analysis functions
// =============================================================================
function analyzeFriction(sessions, threshold) {
    const highFriction = [];
    const frictionPatternCounts = {};
    for (const session of sessions) {
        const steering = session.steeringRatio ?? 0;
        const corrections = session.correctionTurns ?? 0;
        const cancellations = session.toolCancellations ?? 0;
        const patterns = session.frictionPatterns ?? [];
        const turns = session.totalTurns ?? 0;
        for (const pattern of patterns) {
            frictionPatternCounts[pattern] =
                (frictionPatternCounts[pattern] ?? 0) + 1;
        }
        if (steering > threshold ||
            corrections > 2 ||
            cancellations > 2 ||
            patterns.length > 2) {
            highFriction.push({
                sessionId: session.sessionId ?? "unknown",
                steeringRatio: Math.round(steering * 1000) / 1000,
                correctionTurns: corrections,
                toolCancellations: cancellations,
                frictionPatterns: patterns,
                totalTurns: turns,
                totalTokens: session.totalTokens ?? 0,
                durationSeconds: session.durationSeconds ?? 0,
                startedAt: session.startedAt ?? 0,
            });
        }
    }
    highFriction.sort((a, b) => {
        const steeringDiff = -a["steeringRatio"] + b["steeringRatio"];
        if (steeringDiff !== 0)
            return steeringDiff;
        return (-a["correctionTurns"] + b["correctionTurns"]);
    });
    const topPatterns = Object.entries(frictionPatternCounts)
        .map(([pattern, count]) => ({ pattern, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);
    return {
        count: highFriction.length,
        threshold,
        sessions: highFriction.slice(0, 20),
        topFrictionPatterns: topPatterns,
    };
}
function analyzeValue(sessions, topN) {
    const highValue = [];
    for (const session of sessions) {
        const prs = session.prsSubmitted ?? 0;
        const toolExecs = session.toolExecutions ?? 0;
        const toolErrors = session.toolErrors ?? 0;
        const steering = session.steeringRatio ?? 0;
        const turns = session.totalTurns ?? 0;
        const tokens = session.totalTokens ?? 0;
        const cost = session.totalCost ?? 0;
        const duration = session.durationSeconds ?? 0;
        const toolSuccessRate = toolExecs === 0 ? 1.0 : (toolExecs - toolErrors) / toolExecs;
        const tokensPerTurn = turns > 0 ? tokens / turns : 0;
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
                sessionId: session.sessionId ?? "unknown",
                valueScore: Math.round(valueScore * 100) / 100,
                prsSubmitted: prs,
                toolExecutions: toolExecs,
                toolErrors,
                toolSuccessRate: Math.round(toolSuccessRate * 1000) / 1000,
                steeringRatio: Math.round(steering * 1000) / 1000,
                totalTurns: turns,
                totalTokens: tokens,
                tokensPerTurn: Math.round(tokensPerTurn),
                totalCost: cost ? Math.round(cost * 10000) / 10000 : 0,
                durationSeconds: duration,
                startedAt: session.startedAt ?? 0,
            });
        }
    }
    highValue.sort((a, b) => -a["valueScore"] + b["valueScore"]);
    let avgTurns = 0;
    let avgTokens = 0;
    let avgToolSuccess = 0;
    let totalPrs = 0;
    if (highValue.length > 0) {
        avgTurns =
            highValue.reduce((s, v) => s + v["totalTurns"], 0) /
                highValue.length;
        avgTokens =
            highValue.reduce((s, v) => s + v["totalTokens"], 0) /
                highValue.length;
        avgToolSuccess =
            highValue.reduce((s, v) => s + v["toolSuccessRate"], 0) /
                highValue.length;
        totalPrs = highValue.reduce((s, v) => s + v["prsSubmitted"], 0);
    }
    return {
        count: highValue.length,
        sessions: highValue.slice(0, topN),
        aggregates: {
            totalPrsSubmitted: totalPrs,
            avgTurnsPerSession: Math.round(avgTurns * 10) / 10,
            avgTokensPerSession: Math.round(avgTokens),
            avgToolSuccessRate: Math.round(avgToolSuccess * 1000) / 1000,
        },
        successIndicators: [
            "PR submissions track code that made it to review",
            "High tool success rate (>80%) indicates agent understood the task",
            "Low steering ratio (<0.1) indicates efficient first-attempt success",
            "Multiple tool executions without errors shows complex task completion",
        ],
    };
}
function analyzeEfficiency(sessions) {
    if (sessions.length === 0) {
        return { error: "No sessions to analyze" };
    }
    const activeSessions = sessions.filter((s) => (s.totalTurns ?? 0) > 0);
    if (activeSessions.length === 0) {
        return { error: "No active sessions with turns" };
    }
    const totalSessions = activeSessions.length;
    const totalTurns = activeSessions.reduce((s, v) => s + (v.totalTurns ?? 0), 0);
    const totalTokens = activeSessions.reduce((s, v) => s + (v.totalTokens ?? 0), 0);
    const totalCorrections = activeSessions.reduce((s, v) => s + (v.correctionTurns ?? 0), 0);
    const totalCancellations = activeSessions.reduce((s, v) => s + (v.toolCancellations ?? 0), 0);
    const totalToolExecs = activeSessions.reduce((s, v) => s + (v.toolExecutions ?? 0), 0);
    const totalToolErrors = activeSessions.reduce((s, v) => s + (v.toolErrors ?? 0), 0);
    const totalCost = activeSessions.reduce((s, v) => s + (v.totalCost ?? 0), 0);
    const totalPrs = activeSessions.reduce((s, v) => s + (v.prsSubmitted ?? 0), 0);
    const avgSteering = activeSessions.reduce((s, v) => s + (v.steeringRatio ?? 0), 0) /
        totalSessions;
    return {
        totalSessions,
        totalTurns,
        totalTokens,
        totalCost: Math.round(totalCost * 10000) / 10000,
        totalPrsSubmitted: totalPrs,
        avgTurnsPerSession: Math.round((totalTurns / totalSessions) * 10) / 10,
        avgTokensPerSession: Math.round(totalTokens / totalSessions),
        avgTokensPerTurn: totalTurns > 0 ? Math.round(totalTokens / totalTurns) : 0,
        avgSteeringRatio: Math.round(avgSteering * 1000) / 1000,
        totalCorrections,
        totalCancellations,
        correctionRate: totalTurns > 0
            ? Math.round((totalCorrections / totalTurns) * 1000) / 1000
            : 0,
        toolExecutions: totalToolExecs,
        toolErrors: totalToolErrors,
        toolSuccessRate: totalToolExecs > 0
            ? Math.round(((totalToolExecs - totalToolErrors) / totalToolExecs) * 1000) / 1000
            : 1.0,
    };
}
// =============================================================================
// Markdown formatting
// =============================================================================
function formatAsMarkdown(analysis) {
    const lines = [];
    const NL = "\n";
    lines.push("# Session Metrics Analysis");
    lines.push("");
    // Efficiency summary
    const eff = analysis["efficiency"];
    if (eff && !("error" in eff)) {
        lines.push("## Overall Efficiency");
        lines.push("");
        lines.push(`- **Sessions analyzed:** ${eff["totalSessions"] ?? 0}`);
        lines.push(`- **Total turns:** ${eff["totalTurns"] ?? 0}`);
        lines.push(`- **Total tokens:** ${(eff["totalTokens"] ?? 0).toLocaleString()}`);
        lines.push(`- **Total cost:** $${(eff["totalCost"] ?? 0).toFixed(4)}`);
        lines.push(`- **PRs submitted:** ${eff["totalPrsSubmitted"] ?? 0}`);
        lines.push(`- **Avg steering ratio:** ${(eff["avgSteeringRatio"] ?? 0).toFixed(3)}`);
        const toolRate = eff["toolSuccessRate"] ?? 0;
        lines.push(`- **Tool success rate:** ${(toolRate * 100).toFixed(1)}%`);
        lines.push("");
    }
    // High-friction sessions
    const friction = analysis["highFriction"];
    if (friction && (friction["count"] ?? 0) > 0) {
        lines.push("## High-Friction Sessions");
        lines.push("");
        lines.push(`Found **${friction["count"]}** sessions with steering ratio > ${friction["threshold"] ?? 0.15}`);
        lines.push("");
        const frictionSessions = (friction["sessions"] ?? []).slice(0, 5);
        for (const s of frictionSessions) {
            const sid = s["sessionId"].slice(0, 20);
            lines.push(`### Session ${sid}...`);
            lines.push(`- Steering ratio: ${(s["steeringRatio"] ?? 0).toFixed(2)}`);
            lines.push(`- Corrections: ${s["correctionTurns"]}, Cancellations: ${s["toolCancellations"]}`);
            lines.push(`- Turns: ${s["totalTurns"]}, Tokens: ${(s["totalTokens"] ?? 0).toLocaleString()}`);
            const patterns = s["frictionPatterns"];
            if (patterns && patterns.length > 0) {
                lines.push(`- Patterns: ${patterns.slice(0, 3).join(", ")}`);
            }
            lines.push("");
        }
        const topPatterns = (friction["topFrictionPatterns"] ?? []).slice(0, 5);
        if (topPatterns.length > 0) {
            lines.push("### Top Friction Patterns");
            for (const p of topPatterns) {
                lines.push("- `" + String(p["pattern"]) + "`: " + String(p["count"]) + " occurrences");
            }
            lines.push("");
        }
    }
    // High-value sessions
    const value = analysis["highValue"];
    if (value && (value["count"] ?? 0) > 0) {
        lines.push("## High-Value Sessions");
        lines.push("");
        const agg = value["aggregates"] ?? {};
        lines.push(`Found **${value["count"]}** high-value sessions:`);
        lines.push(`- Total PRs submitted: ${agg["totalPrsSubmitted"] ?? 0}`);
        const avgSuccess = agg["avgToolSuccessRate"] ?? 0;
        lines.push(`- Avg tool success rate: ${(avgSuccess * 100).toFixed(1)}%`);
        lines.push("");
        const valueSessions = (value["sessions"] ?? []).slice(0, 5);
        for (const s of valueSessions) {
            const sid = s["sessionId"].slice(0, 20);
            const successPct = s["toolSuccessRate"] ?? 0;
            lines.push(`### Session ${sid}... (score: ${s["valueScore"]})`);
            lines.push(`- PRs: ${s["prsSubmitted"]}, Tools: ${s["toolExecutions"]} (${Math.round(successPct * 100)}% success)`);
            lines.push(`- Turns: ${s["totalTurns"]}, Steering: ${(s["steeringRatio"] ?? 0).toFixed(2)}`);
            lines.push(`- Tokens: ${(s["totalTokens"] ?? 0).toLocaleString()}, Cost: $${(s["totalCost"] ?? 0).toFixed(4)}`);
            lines.push("");
        }
        lines.push("### Success Indicators");
        const indicators = value["successIndicators"] ?? [];
        for (const indicator of indicators) {
            lines.push(`- ${indicator}`);
        }
        lines.push("");
    }
    else {
        lines.push("## High-Value Sessions");
        lines.push("");
        lines.push("No high-value sessions detected yet. High-value sessions are identified by:");
        lines.push("- PR submissions (code that made it to review)");
        lines.push("- High tool execution with low error rate");
        lines.push("- Low steering ratio (efficient completion)");
        lines.push("");
    }
    return lines.join(NL);
}
// =============================================================================
// Main
// =============================================================================
function main() {
    const frictionThreshold = parseFloat(getArg("friction-threshold", "0.15") ?? "0.15");
    const topValue = parseInt(getArg("top-value", "10") ?? "10", 10);
    const format = getArg("format", "json") ?? "json";
    const data = loadSessionMetrics();
    if (data === null) {
        const result = {
            error: "session_metrics.json not found",
            path: getSessionMetricsPath(),
            hint: "Session metrics are collected automatically. Run some OB1 sessions first.",
        };
        console.log(JSON.stringify(result, null, 2));
        process.exit(1);
    }
    if ("error" in data) {
        console.log(JSON.stringify(data, null, 2));
        process.exit(1);
    }
    const sessionsMap = data["sessions"] ?? {};
    const sessions = Object.values(sessionsMap);
    if (sessions.length === 0) {
        const result = {
            error: "No sessions in session_metrics.json",
            hint: "Session metrics are collected automatically. Run some OB1 sessions first.",
        };
        console.log(JSON.stringify(result, null, 2));
        process.exit(1);
    }
    const analysis = {
        generated_at: new Date().toISOString(),
        sessions_count: sessions.length,
        efficiency: analyzeEfficiency(sessions),
        highFriction: analyzeFriction(sessions, frictionThreshold),
        highValue: analyzeValue(sessions, topValue),
    };
    if (format === "markdown") {
        console.log(formatAsMarkdown(analysis));
    }
    else {
        console.log(JSON.stringify(analysis, null, 2));
    }
}
main();
//# sourceMappingURL=analyze_session_metrics.js.map