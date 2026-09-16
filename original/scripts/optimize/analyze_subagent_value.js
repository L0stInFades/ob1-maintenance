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
const EXPLORATION_TOOLS = new Set([
    "read_file",
    "glob",
    "search_file_content",
    "list_directory",
]);
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
    const delegations = [];
    let currentDelegation = null;
    const messageTimeline = [];
    const explorationRuns = [];
    let currentExploration = [];
    let cumulativeTokens = 0;
    let delegationState = "none";
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const msgType = msg["type"] ?? "";
        const tokens = msg["tokens"];
        const inputTokens = tokens && typeof tokens === "object" ? (tokens["input"] ?? 0) : 0;
        const outputTokens = tokens && typeof tokens === "object" ? (tokens["output"] ?? 0) : 0;
        const totalTokens = inputTokens + outputTokens;
        const content = msg["content"] ?? "";
        const entry = {
            msg_index: i,
            type: msgType,
            tokens: totalTokens,
            input_tokens: inputTokens,
            cumulative_tokens: cumulativeTokens,
            is_correction: false,
            tools: [],
            delegation_state: delegationState,
        };
        if (msgType === "user") {
            entry.is_correction = isCorrection(content);
            cumulativeTokens += totalTokens;
        }
        else if (msgType === "gemini") {
            cumulativeTokens += totalTokens;
            const toolCalls = msg["toolCalls"] ?? [];
            for (const tc of toolCalls) {
                const toolName = tc["name"] ?? "";
                const toolStatus = tc["status"] ?? "";
                entry.tools.push({ name: toolName, status: toolStatus });
                // Track exploration for missed opportunity detection
                if (EXPLORATION_TOOLS.has(toolName) &&
                    delegationState === "none") {
                    currentExploration.push({
                        tool: toolName,
                        msg_index: i,
                        tokens: totalTokens,
                    });
                }
                else if (!EXPLORATION_TOOLS.has(toolName) &&
                    currentExploration.length > 0) {
                    if (currentExploration.length >= 3) {
                        explorationRuns.push([...currentExploration]);
                    }
                    currentExploration = [];
                }
                // Track delegation lifecycle
                if (toolName === "delegate_to_agent" ||
                    toolName === "handoff_to_agent") {
                    const args = tc["args"] ?? {};
                    delegationState = "delegated";
                    const isBuiltinSubagent = toolName === "delegate_to_agent";
                    currentDelegation = {
                        type: toolName,
                        agent: args["agent_name"] ??
                            args["targetAgent"] ??
                            "unknown",
                        task: (args["objective"] ??
                            args["taskDescription"] ??
                            "").slice(0, 200),
                        start_index: i,
                        start_cumulative_tokens: cumulativeTokens,
                        pre_friction_count: messageTimeline.filter((e) => e.is_correction).length,
                        tool_count: 0,
                        subagent_tokens: 0,
                    };
                    // For built-in subagents, check if delegation completed immediately
                    if (isBuiltinSubagent && toolStatus === "success") {
                        currentDelegation.end_index = i;
                        currentDelegation.return_status = "completed";
                        currentDelegation.end_cumulative_tokens = cumulativeTokens;
                        delegations.push(currentDelegation);
                        currentDelegation = null;
                        delegationState = "returned";
                    }
                }
                else if (toolName === "return_to_agent") {
                    if (currentDelegation) {
                        const args = tc["args"] ?? {};
                        currentDelegation.end_index = i;
                        currentDelegation.return_status =
                            args["status"] ?? "unknown";
                        currentDelegation.end_cumulative_tokens = cumulativeTokens;
                        delegations.push(currentDelegation);
                        currentDelegation = null;
                    }
                    delegationState = "returned";
                }
            }
        }
        messageTimeline.push(entry);
    }
    // Capture any trailing exploration run
    if (currentExploration.length >= 3) {
        explorationRuns.push(currentExploration);
    }
    // If delegation never returned, still record it
    if (currentDelegation) {
        currentDelegation.end_index = messages.length - 1;
        currentDelegation.return_status = "incomplete";
        currentDelegation.end_cumulative_tokens = cumulativeTokens;
        delegations.push(currentDelegation);
    }
    // Calculate metrics
    const totalCorrections = messageTimeline.filter((e) => e.is_correction).length;
    const totalMessages = messageTimeline.length;
    // For each delegation, calculate pre/post friction
    for (const d of delegations) {
        const startIdx = d.start_index;
        const endIdx = d.end_index ?? messageTimeline.length - 1;
        // Pre-delegation friction (last 5 messages before delegation)
        const preStart = Math.max(0, startIdx - 5);
        const preMsgs = messageTimeline.slice(preStart, startIdx);
        d.pre_friction = preMsgs.filter((e) => e.is_correction).length;
        d.pre_msg_count = preMsgs.length;
        // Post-delegation friction (5 messages after return)
        const postEnd = Math.min(messageTimeline.length, endIdx + 6);
        const postMsgs = messageTimeline.slice(endIdx + 1, postEnd);
        d.post_friction = postMsgs.filter((e) => e.is_correction).length;
        d.post_msg_count = postMsgs.length;
        // Token delta during delegation
        d.tokens_during_delegation =
            (d.end_cumulative_tokens ?? 0) - d.start_cumulative_tokens;
    }
    // Estimate missed opportunities
    const missedOpportunities = [];
    for (const run of explorationRuns) {
        if (run.length >= 5) {
            const totalExploreTokens = run.reduce((sum, e) => sum + (e.tokens ?? 0), 0);
            missedOpportunities.push({
                tool_count: run.length,
                tools: run.map((e) => e.tool),
                estimated_tokens: totalExploreTokens,
                start_index: run[0].msg_index,
                recommendation: "Consider using 'explore' or 'file-picker' agent",
            });
        }
    }
    return {
        session_id: sessionId,
        file_path: sessionPath,
        total_messages: totalMessages,
        total_tokens: cumulativeTokens,
        total_corrections: totalCorrections,
        correction_rate: totalMessages > 0
            ? Math.round((totalCorrections / totalMessages) * 1000) / 1000
            : 0,
        delegations,
        delegation_count: delegations.length,
        missed_opportunities: missedOpportunities,
        exploration_runs_without_delegation: explorationRuns.length,
    };
}
// =============================================================================
// Counterfactual Cost Estimation
// =============================================================================
function estimateCounterfactualCost(delegation, avgResultTokens = 800) {
    const actualTokens = delegation.tokens_during_delegation ?? 0;
    // Estimate tool calls from tokens
    let estimatedToolCalls = Math.max(1, Math.floor(actualTokens / 3000));
    estimatedToolCalls = Math.min(estimatedToolCalls, 20);
    const avgSubsequentCalls = 4;
    const contextInflation = estimatedToolCalls * avgResultTokens * avgSubsequentCalls;
    const handoffOverhead = 500;
    const counterfactualCost = actualTokens + contextInflation;
    const actualCost = actualTokens + handoffOverhead;
    const savings = counterfactualCost - actualCost;
    return {
        actual_tokens: actualTokens,
        estimated_tool_calls: estimatedToolCalls,
        context_inflation_avoided: contextInflation,
        handoff_overhead: handoffOverhead,
        counterfactual_cost: counterfactualCost,
        actual_cost: actualCost,
        estimated_savings: savings,
        savings_percent: counterfactualCost > 0
            ? Math.round((savings / counterfactualCost) * 1000) / 10
            : 0,
    };
}
// =============================================================================
// Aggregation
// =============================================================================
function aggregateResults(sessions) {
    const sessionsWithDelegations = sessions.filter((s) => s.delegation_count > 0);
    const sessionsWithoutDelegations = sessions.filter((s) => s.delegation_count === 0);
    // Aggregate delegation metrics
    const allDelegations = [];
    for (const s of sessionsWithDelegations) {
        for (const d of s.delegations) {
            d.session_id = s.session_id;
            d.cost_analysis = estimateCounterfactualCost(d);
            allDelegations.push(d);
        }
    }
    // Group by agent type
    const byAgent = {};
    for (const d of allDelegations) {
        const agent = d.agent ?? "unknown";
        if (!byAgent[agent])
            byAgent[agent] = [];
        byAgent[agent].push(d);
    }
    const agentStats = {};
    for (const [agent, delegations] of Object.entries(byAgent)) {
        const completed = delegations.filter((d) => d.return_status === "completed");
        // Friction improvement
        const frictionImprovements = [];
        for (const d of completed) {
            const pre = d.pre_friction ?? 0;
            const post = d.post_friction ?? 0;
            if ((d.pre_msg_count ?? 0) > 0 && (d.post_msg_count ?? 0) > 0) {
                const preRate = pre / d.pre_msg_count;
                const postRate = post / d.post_msg_count;
                frictionImprovements.push(preRate - postRate);
            }
        }
        const totalSavings = delegations.reduce((sum, d) => sum + (d.cost_analysis?.estimated_savings ?? 0), 0);
        agentStats[agent] = {
            total_delegations: delegations.length,
            completed: completed.length,
            completion_rate: delegations.length > 0
                ? Math.round((completed.length / delegations.length) * 100) /
                    100
                : 0,
            avg_friction_improvement: frictionImprovements.length > 0
                ? Math.round((frictionImprovements.reduce((a, b) => a + b, 0) /
                    frictionImprovements.length) *
                    1000) / 1000
                : null,
            total_estimated_savings: totalSavings,
            avg_savings_per_delegation: delegations.length > 0
                ? Math.round(totalSavings / delegations.length)
                : 0,
        };
    }
    // Sort agent stats by total_delegations descending
    const sortedAgentStats = {};
    const sortedKeys = Object.keys(agentStats).sort((a, b) => (agentStats[b]["total_delegations"] ?? 0) -
        (agentStats[a]["total_delegations"] ?? 0));
    for (const key of sortedKeys) {
        sortedAgentStats[key] = agentStats[key];
    }
    // Missed opportunities analysis
    const allMissed = [];
    for (const s of sessionsWithoutDelegations) {
        for (const m of s.missed_opportunities) {
            m.session_id = s.session_id;
            allMissed.push(m);
        }
    }
    // Compare correction rates
    const withDelegationTotalCorrections = sessionsWithDelegations.reduce((sum, s) => sum + s.total_corrections, 0);
    const withDelegationTotalMessages = sessionsWithDelegations.reduce((sum, s) => sum + s.total_messages, 0);
    const withDelegationCorrectionRate = withDelegationTotalMessages > 0
        ? withDelegationTotalCorrections / withDelegationTotalMessages
        : 0;
    const withoutDelegationTotalCorrections = sessionsWithoutDelegations.reduce((sum, s) => sum + s.total_corrections, 0);
    const withoutDelegationTotalMessages = sessionsWithoutDelegations.reduce((sum, s) => sum + s.total_messages, 0);
    const withoutDelegationCorrectionRate = withoutDelegationTotalMessages > 0
        ? withoutDelegationTotalCorrections / withoutDelegationTotalMessages
        : 0;
    return {
        summary: {
            total_sessions: sessions.length,
            sessions_with_delegations: sessionsWithDelegations.length,
            sessions_without_delegations: sessionsWithoutDelegations.length,
            total_delegations: allDelegations.length,
            total_missed_opportunities: allMissed.length,
        },
        value_analysis: {
            correction_rate_with_delegation: Math.round(withDelegationCorrectionRate * 10000) / 10000,
            correction_rate_without_delegation: Math.round(withoutDelegationCorrectionRate * 10000) / 10000,
            delegation_appears_helpful: withDelegationCorrectionRate < withoutDelegationCorrectionRate,
            total_estimated_token_savings: allDelegations.reduce((sum, d) => sum + (d.cost_analysis?.estimated_savings ?? 0), 0),
        },
        by_agent: sortedAgentStats,
        missed_opportunities: {
            count: allMissed.length,
            total_estimated_wasted_tokens: allMissed.reduce((sum, m) => sum + (m.estimated_tokens ?? 0), 0),
            examples: allMissed.slice(0, 5),
        },
        delegation_examples: allDelegations.slice(0, 10).map((d) => ({
            session_id: d.session_id,
            agent: d.agent,
            task: d.task,
            return_status: d.return_status,
            pre_friction: d.pre_friction,
            post_friction: d.post_friction,
            savings: d.cost_analysis?.estimated_savings ?? 0,
        })),
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
//# sourceMappingURL=analyze_subagent_value.js.map