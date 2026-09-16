import * as fs from "node:fs";
import { isCorrection, getOb1TmpDir, findSessionFiles, } from "./utils.js";
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
// Session Analysis
// =============================================================================
function createModelMetrics() {
    return {
        message_count: 0,
        total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        cost: 0,
        corrections_after: 0,
        cancellations: 0,
        tool_calls: 0,
        tool_errors: 0,
    };
}
function analyzeSession(sessionPath) {
    let data;
    try {
        const content = fs.readFileSync(sessionPath, "utf-8");
        data = JSON.parse(content);
    }
    catch {
        return null;
    }
    const sessionId = data["sessionId"] ?? "unknown";
    const messages = data["messages"] ?? [];
    if (messages.length === 0)
        return null;
    // Track per-model metrics
    const modelMetrics = {};
    // Track model switches
    const modelSwitches = [];
    let prevModel = null;
    let prevHadFriction = false;
    // Track timeline for switch analysis
    let currentModel = null;
    let messagesSinceSwitch = 0;
    let frictionSinceSwitch = 0;
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const msgType = msg["type"] ?? "";
        const content = msg["content"] ?? "";
        if (msgType === "user") {
            if (isCorrection(content)) {
                if (currentModel) {
                    if (!modelMetrics[currentModel])
                        modelMetrics[currentModel] = createModelMetrics();
                    modelMetrics[currentModel].corrections_after++;
                    frictionSinceSwitch++;
                }
                prevHadFriction = true;
            }
            else {
                prevHadFriction = false;
            }
        }
        else if (msgType === "gemini") {
            const model = msg["model"] ?? "unknown";
            const tokens = msg["tokens"];
            let inputTokens = 0;
            let outputTokens = 0;
            let totalTokens = 0;
            let cost = 0;
            if (tokens && typeof tokens === "object") {
                inputTokens = tokens["input"] ?? 0;
                outputTokens = tokens["output"] ?? 0;
                totalTokens = tokens["total"] ?? inputTokens + outputTokens;
                cost = tokens["cost"] ?? 0;
            }
            // Update model metrics
            if (!modelMetrics[model])
                modelMetrics[model] = createModelMetrics();
            const m = modelMetrics[model];
            m.message_count++;
            m.total_tokens += totalTokens;
            m.input_tokens += inputTokens;
            m.output_tokens += outputTokens;
            m.cost += cost;
            // Track tool calls
            const toolCalls = msg["toolCalls"] ?? [];
            for (const tc of toolCalls) {
                m.tool_calls++;
                const status = tc["status"] ?? "";
                if (status === "cancelled") {
                    m.cancellations++;
                }
                else if (status === "error" || status === "failed") {
                    m.tool_errors++;
                }
            }
            // Detect model switch
            if (prevModel && model !== prevModel) {
                modelSwitches.push({
                    from_model: prevModel,
                    to_model: model,
                    message_index: i,
                    friction_before_switch: prevHadFriction,
                    messages_with_prev_model: messagesSinceSwitch,
                    friction_with_prev_model: frictionSinceSwitch,
                });
                messagesSinceSwitch = 0;
                frictionSinceSwitch = 0;
            }
            prevModel = model;
            currentModel = model;
            messagesSinceSwitch++;
        }
    }
    // Calculate per-model quality metrics
    const modelQuality = {};
    for (const [model, metrics] of Object.entries(modelMetrics)) {
        const msgCount = metrics.message_count;
        if (msgCount > 0) {
            modelQuality[model] = {
                ...metrics,
                correction_rate: Math.round((metrics.corrections_after / msgCount) * 10000) /
                    10000,
                cancellation_rate: Math.round((metrics.cancellations / Math.max(1, metrics.tool_calls)) *
                    10000) / 10000,
                avg_tokens_per_message: Math.round(metrics.total_tokens / msgCount),
                avg_cost_per_message: metrics.cost > 0
                    ? Math.round((metrics.cost / msgCount) * 10000) / 10000
                    : null,
            };
        }
    }
    // Find primary model
    let primaryModel = null;
    let maxMessages = 0;
    for (const [model, metrics] of Object.entries(modelMetrics)) {
        if (metrics.message_count > maxMessages) {
            maxMessages = metrics.message_count;
            primaryModel = model;
        }
    }
    const switchesDueToFriction = modelSwitches.filter((s) => s.friction_before_switch).length;
    return {
        session_id: sessionId,
        file_path: sessionPath,
        models_used: Object.keys(modelMetrics),
        model_count: Object.keys(modelMetrics).length,
        is_multi_model: Object.keys(modelMetrics).length > 1,
        model_quality: modelQuality,
        model_switches: modelSwitches,
        switch_count: modelSwitches.length,
        switches_due_to_friction: switchesDueToFriction,
        primary_model: primaryModel,
    };
}
function createModelAggregate() {
    return {
        sessions: 0,
        total_messages: 0,
        total_tokens: 0,
        total_cost: 0,
        total_corrections: 0,
        total_cancellations: 0,
        total_tool_calls: 0,
    };
}
function calcSessionCorrectionRate(sessions) {
    let totalCorrections = 0;
    let totalMessages = 0;
    for (const s of sessions) {
        for (const q of Object.values(s.model_quality)) {
            totalCorrections += q.corrections_after;
            totalMessages += q.message_count;
        }
    }
    return totalMessages > 0 ? totalCorrections / totalMessages : 0;
}
function aggregateResults(sessions) {
    const modelAggregate = {};
    const multiModelSessions = [];
    const singleModelSessions = [];
    const allSwitches = [];
    for (const s of sessions) {
        if (s.is_multi_model) {
            multiModelSessions.push(s);
        }
        else {
            singleModelSessions.push(s);
        }
        for (const [model, quality] of Object.entries(s.model_quality)) {
            if (!modelAggregate[model])
                modelAggregate[model] = createModelAggregate();
            const agg = modelAggregate[model];
            agg.sessions++;
            agg.total_messages += quality.message_count;
            agg.total_tokens += quality.total_tokens;
            agg.total_cost += quality.cost;
            agg.total_corrections += quality.corrections_after;
            agg.total_cancellations += quality.cancellations;
            agg.total_tool_calls += quality.tool_calls;
        }
        allSwitches.push(...s.model_switches);
    }
    // Calculate aggregate quality metrics per model
    const modelComparison = [];
    for (const [model, agg] of Object.entries(modelAggregate)) {
        if (agg.total_messages > 0) {
            const correctionRate = agg.total_corrections / agg.total_messages;
            const cancellationRate = agg.total_cancellations / Math.max(1, agg.total_tool_calls);
            const avgCost = agg.total_cost > 0
                ? agg.total_cost / agg.total_messages
                : null;
            modelComparison.push({
                model,
                sessions: agg.sessions,
                total_messages: agg.total_messages,
                correction_rate: Math.round(correctionRate * 10000) / 10000,
                cancellation_rate: Math.round(cancellationRate * 10000) / 10000,
                avg_tokens_per_message: Math.round(agg.total_tokens / agg.total_messages),
                avg_cost_per_message: avgCost
                    ? Math.round(avgCost * 10000) / 10000
                    : null,
                total_cost: agg.total_cost > 0
                    ? Math.round(agg.total_cost * 100) / 100
                    : null,
                quality_score: Math.round((1 - correctionRate) * 10000) / 10000,
            });
        }
    }
    // Sort by sessions (most used first)
    modelComparison.sort((a, b) => b["sessions"] - a["sessions"]);
    // Analyze switch patterns
    const switchOutcomes = {
        helpful: 0,
        neutral: 0,
        unhelpful: 0,
    };
    const switchPatterns = {};
    for (const sw of allSwitches) {
        const pattern = `${sw.from_model} -> ${sw.to_model}`;
        switchPatterns[pattern] = (switchPatterns[pattern] ?? 0) + 1;
        if (sw.friction_before_switch) {
            switchOutcomes["helpful"]++;
        }
        else {
            switchOutcomes["neutral"]++;
        }
    }
    // Sort switch patterns by count, take top 5
    const sortedSwitchPatterns = {};
    const sortedPatternKeys = Object.entries(switchPatterns)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5);
    for (const [key, value] of sortedPatternKeys) {
        sortedSwitchPatterns[key] = value;
    }
    // Compare multi-model vs single-model
    const multiCorrectionRate = calcSessionCorrectionRate(multiModelSessions);
    const singleCorrectionRate = calcSessionCorrectionRate(singleModelSessions);
    return {
        summary: {
            total_sessions: sessions.length,
            multi_model_sessions: multiModelSessions.length,
            single_model_sessions: singleModelSessions.length,
            total_model_switches: allSwitches.length,
            unique_models_used: Object.keys(modelAggregate).length,
        },
        quality_comparison: {
            multi_model_correction_rate: Math.round(multiCorrectionRate * 10000) / 10000,
            single_model_correction_rate: Math.round(singleCorrectionRate * 10000) / 10000,
            multi_model_better: multiCorrectionRate < singleCorrectionRate,
            interpretation: multiCorrectionRate < singleCorrectionRate
                ? "Switching models mid-session correlates with LOWER friction"
                : "Switching models mid-session correlates with HIGHER friction (may indicate struggle)",
        },
        model_ranking: modelComparison.slice(0, 10),
        switch_analysis: {
            total_switches: allSwitches.length,
            switches_due_to_friction: allSwitches.filter((s) => s.friction_before_switch).length,
            common_patterns: sortedSwitchPatterns,
            outcomes: switchOutcomes,
        },
    };
}
// =============================================================================
// Main
// =============================================================================
function main() {
    const limit = parseInt(getArg("limit", "100"), 10);
    const verbose = hasFlag("verbose");
    const tmpDir = getOb1TmpDir();
    if (!fs.existsSync(tmpDir)) {
        console.log(JSON.stringify({ error: "OB1 tmp directory not found" }));
        process.exit(1);
    }
    const sessionFiles = findSessionFiles(tmpDir, undefined, limit);
    const sessions = [];
    for (const sf of sessionFiles) {
        const result = analyzeSession(sf);
        if (result)
            sessions.push(result);
    }
    let output;
    if (verbose) {
        output = {
            sessions,
            aggregate: aggregateResults(sessions),
        };
    }
    else {
        output = aggregateResults(sessions);
    }
    console.log(JSON.stringify(output, null, 2));
}
main();
//# sourceMappingURL=analyze_model_routing.js.map