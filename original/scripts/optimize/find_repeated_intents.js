import * as fs from "node:fs";
import { getOb1TmpDir, findSessionFiles } from "./utils.js";
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
// Text processing
// =============================================================================
function normalizeText(text) {
    let t = text.toLowerCase();
    t = t.replace(/\s+/g, " ").trim();
    t = t.replace(/[^\w\s-]/g, "");
    return t;
}
const ACTION_PATTERNS = [
    /\b(help me|help)\s+(\w+)/g,
    /\b(create|make|build|generate|write)\s+(\w+)/g,
    /\b(fix|debug|solve|resolve)\s+(\w+)/g,
    /\b(update|modify|change|edit)\s+(\w+)/g,
    /\b(add|remove|delete)\s+(\w+)/g,
    /\b(find|search|look for|locate)\s+(\w+)/g,
    /\b(review|check|analyze|audit)\s+(\w+)/g,
    /\b(run|execute|start|stop)\s+(\w+)/g,
    /\b(deploy|push|release|publish)\s+(\w+)/g,
    /\b(test|verify|validate)\s+(\w+)/g,
    /\b(refactor|optimize|improve)\s+(\w+)/g,
    /\b(explain|describe|show)\s+(\w+)/g,
    /\b(commit|merge|rebase|branch)\b/g,
    /\b(install|setup|configure)\s+(\w+)/g,
];
function extractKeyPhrases(text) {
    const normalized = normalizeText(text);
    const phrases = new Set();
    for (const pattern of ACTION_PATTERNS) {
        // Reset lastIndex for global regex
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(normalized)) !== null) {
            // Combine all capture groups into a phrase
            const parts = [];
            for (let i = 1; i < match.length; i++) {
                if (match[i])
                    parts.push(match[i]);
            }
            if (parts.length > 0) {
                phrases.add(parts.join(" "));
            }
        }
    }
    return phrases;
}
function computeSimilarity(phrases1, phrases2) {
    if (phrases1.size === 0 || phrases2.size === 0)
        return 0.0;
    let intersection = 0;
    for (const p of phrases1) {
        if (phrases2.has(p))
            intersection++;
    }
    const union = new Set([...phrases1, ...phrases2]).size;
    return union > 0 ? intersection / union : 0.0;
}
function extractUserRequests(sessionPath) {
    let data;
    try {
        const raw = fs.readFileSync(sessionPath, "utf-8");
        data = JSON.parse(raw);
    }
    catch {
        return [];
    }
    const sessionId = data["sessionId"] ?? "unknown";
    const projectHash = data["projectHash"] ??
        sessionPath.split("/").slice(-3, -2)[0] ??
        "unknown";
    const messages = data["messages"] ?? [];
    const startTime = data["startTime"] ?? "";
    const requests = [];
    for (const msg of messages) {
        if (msg["type"] !== "user")
            continue;
        const content = msg["content"] ?? "";
        if (!content || content.length < 10)
            continue;
        const wordCount = content.split(/\s+/).length;
        if (wordCount < 3)
            continue;
        if (content.startsWith("{") ||
            content.startsWith("[") ||
            content.includes("```")) {
            continue;
        }
        const phrases = extractKeyPhrases(content);
        if (phrases.size === 0)
            continue;
        requests.push({
            content: content.slice(0, 300),
            phrases: [...phrases],
            timestamp: msg["timestamp"] ?? "",
            session_id: sessionId,
            project_hash: projectHash,
            file_path: sessionPath,
            session_start: startTime,
        });
    }
    return requests;
}
function groupSimilarRequests(requests, similarityThreshold = 0.5) {
    if (requests.length === 0)
        return [];
    const groups = [];
    const used = new Set();
    for (let i = 0; i < requests.length; i++) {
        if (used.has(i))
            continue;
        const req = requests[i];
        const group = {
            representative: req.content,
            phrases: req.phrases,
            instances: [req],
        };
        used.add(i);
        const phrasesI = new Set(req.phrases);
        for (let j = i + 1; j < requests.length; j++) {
            if (used.has(j))
                continue;
            const other = requests[j];
            const phrasesJ = new Set(other.phrases);
            const similarity = computeSimilarity(phrasesI, phrasesJ);
            if (similarity >= similarityThreshold) {
                group.instances.push(other);
                used.add(j);
            }
        }
        groups.push(group);
    }
    return groups;
}
// =============================================================================
// Command name suggestion
// =============================================================================
function suggestCommandName(phrases) {
    if (phrases.length === 0)
        return "custom-command";
    const phrase = phrases[0];
    let name = phrase.toLowerCase().replace(/\s+/g, "-");
    for (const prefix of ["help-me-", "help-"]) {
        if (name.startsWith(prefix)) {
            name = name.slice(prefix.length);
        }
    }
    return name.slice(0, 30);
}
// =============================================================================
// Main
// =============================================================================
function main() {
    const limit = parseInt(getArg("limit", "100") ?? "100", 10);
    const minCount = parseInt(getArg("min-count", "3") ?? "3", 10);
    const similarity = parseFloat(getArg("similarity", "0.4") ?? "0.4");
    const tmpDir = getOb1TmpDir();
    if (!fs.existsSync(tmpDir)) {
        console.log(JSON.stringify({ error: "OB1 tmp directory not found", path: tmpDir }));
        process.exit(1);
    }
    const sessionFiles = findSessionFiles(tmpDir, undefined, limit);
    // Extract all user requests
    const allRequests = [];
    for (const sf of sessionFiles) {
        allRequests.push(...extractUserRequests(sf));
    }
    // Group similar requests
    const groups = groupSimilarRequests(allRequests, similarity);
    // Filter to groups with min_count instances
    const significantGroups = groups
        .filter((g) => g.instances.length >= minCount)
        .sort((a, b) => b.instances.length - a.instances.length);
    // Format output
    const output = {
        summary: {
            total_requests_analyzed: allRequests.length,
            unique_patterns_found: groups.length,
            significant_patterns: significantGroups.length,
        },
        command_candidates: significantGroups.slice(0, 20).map((group) => {
            const instances = group.instances;
            const uniqueSessions = new Set(instances.map((i) => i.session_id));
            const uniqueProjects = new Set(instances.map((i) => i.project_hash));
            let scope;
            let scopeReason;
            if (uniqueProjects.size > 1) {
                scope = "global";
                scopeReason = `Used across ${uniqueProjects.size} projects`;
            }
            else {
                scope = "project";
                scopeReason = "Used in single project";
            }
            return {
                suggested_name: "/" + suggestCommandName(group.phrases),
                occurrence_count: instances.length,
                unique_sessions: uniqueSessions.size,
                key_phrases: group.phrases.slice(0, 5),
                scope,
                scope_reason: scopeReason,
                examples: instances.slice(0, 5).map((inst) => ({
                    content: inst.content,
                    session_id: inst.session_id,
                    file_path: inst.file_path,
                    timestamp: inst.timestamp,
                })),
            };
        }),
    };
    console.log(JSON.stringify(output, null, 2));
}
main();
//# sourceMappingURL=find_repeated_intents.js.map