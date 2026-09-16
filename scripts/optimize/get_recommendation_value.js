import * as fs from "node:fs";
import { getRecommendationValuePath } from "./utils.js";
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
// Data loading
// =============================================================================
function loadValueState() {
    const filePath = getRecommendationValuePath();
    if (!fs.existsSync(filePath)) {
        return { version: 1, recommendations: {}, lastUpdated: 0 };
    }
    try {
        const content = fs.readFileSync(filePath, "utf-8");
        return JSON.parse(content);
    }
    catch {
        return { version: 1, recommendations: {}, lastUpdated: 0 };
    }
}
// =============================================================================
// Analysis functions
// =============================================================================
function calculateDaysActive(rec) {
    const first = rec.firstUsedAt;
    const last = rec.lastUsedAt;
    if (first != null && last != null) {
        return Math.max(0, Math.floor((last - first) / (24 * 60 * 60 * 1000)));
    }
    return null;
}
function calculateDaysSince(timestamp) {
    if (timestamp == null)
        return null;
    const now = Date.now();
    return Math.max(0, Math.floor((now - timestamp) / (24 * 60 * 60 * 1000)));
}
function getSummary(state) {
    const recs = state.recommendations ?? {};
    const entries = Object.values(recs);
    if (entries.length === 0) {
        return {
            total_recommendations: 0,
            total_actioned: 0,
            adoption_rate: 0,
            total_usage: 0,
            by_type: {},
            message: "No recommendations tracked yet. Run /analyze or /optimize to generate recommendations.",
        };
    }
    const total = entries.length;
    const actioned = entries.filter((r) => r.actionedAt).length;
    const totalUsage = entries.reduce((s, r) => s + (r.usageCount ?? 0), 0);
    const byType = {};
    for (const rec of entries) {
        const rtype = rec.recommendationType ?? "other";
        if (!byType[rtype]) {
            byType[rtype] = { total: 0, actioned: 0, usage: 0 };
        }
        byType[rtype].total += 1;
        if (rec.actionedAt)
            byType[rtype].actioned += 1;
        byType[rtype].usage += rec.usageCount ?? 0;
    }
    return {
        total_recommendations: total,
        total_actioned: actioned,
        adoption_rate: total > 0 ? Math.round((actioned / total) * 1000) / 1000 : 0,
        total_usage: totalUsage,
        by_type: byType,
        last_updated: state.lastUpdated ?? 0,
    };
}
function getTopUsed(state, limit) {
    const recs = state.recommendations ?? {};
    const used = Object.entries(recs)
        .filter(([, r]) => (r.usageCount ?? 0) > 0)
        .map(([rid, r]) => ({
        recommendation_id: rid,
        type: r.recommendationType ?? "other",
        artifact_name: r.artifact?.name ?? null,
        artifact_type: r.artifact?.type ?? null,
        usage_count: r.usageCount ?? 0,
        first_used: r.firstUsedAt ?? null,
        last_used: r.lastUsedAt ?? null,
        days_active: calculateDaysActive(r),
    }));
    used.sort((a, b) => b.usage_count - a.usage_count);
    return used.slice(0, limit);
}
function getUnusedActioned(state) {
    const recs = state.recommendations ?? {};
    return Object.entries(recs)
        .filter(([, r]) => r.actionedAt && (r.usageCount ?? 0) === 0)
        .map(([rid, r]) => ({
        recommendation_id: rid,
        type: r.recommendationType ?? "other",
        artifact_name: r.artifact?.name ?? null,
        actioned_at: r.actionedAt ?? null,
        days_since_actioned: calculateDaysSince(r.actionedAt),
    }));
}
// =============================================================================
// Main
// =============================================================================
function main() {
    const format = getArg("format", "summary") ?? "summary";
    const limit = parseInt(getArg("limit", "10") ?? "10", 10);
    const state = loadValueState();
    let output;
    if (format === "summary") {
        output = getSummary(state);
    }
    else if (format === "top") {
        output = {
            top_used: getTopUsed(state, limit),
            summary: getSummary(state),
        };
    }
    else if (format === "unused") {
        output = {
            unused_actioned: getUnusedActioned(state),
            summary: getSummary(state),
        };
    }
    else {
        // full
        output = state;
    }
    console.log(JSON.stringify(output, null, 2));
}
main();
//# sourceMappingURL=get_recommendation_value.js.map