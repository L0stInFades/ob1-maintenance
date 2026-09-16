import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
// =============================================================================
// Correction/Friction Pattern Detection
// =============================================================================
/** Simple patterns for quick detection (used by most scripts) */
export const CORRECTION_PATTERNS_SIMPLE = [
    "no,",
    "no ",
    "don't",
    "dont",
    "actually",
    "instead",
    "that's wrong",
    "thats wrong",
    "not that",
    "wrong",
    "I meant",
    "i meant",
    "should be",
];
/** Detailed patterns grouped by type (used for categorization) */
export const CORRECTION_PATTERNS_BY_TYPE = {
    explicit_no: [
        "\bno,?\s+(?:use|do|try|make|don't|dont)",
        "\bthat's wrong\b",
        "\bthats wrong\b",
        "\bwrong\b.*\bshould be\b",
    ],
    actually: [
        "\bactually,?\s+",
        "\bin fact,?\s+",
        "\bI meant\b",
        "\bi meant\b",
    ],
    dont: [
        "\bdon't\s+(?:use|do|add|remove|change)",
        "\bdont\s+(?:use|do|add|remove|change)",
        "\bnever\s+(?:use|do|add)",
        "\bstop\s+(?:using|doing)",
    ],
    explicit_remember: [
        "\bremember:\s*",
        "\balways\s+(?:use|do|run|check)",
        "\bnever\s+(?:use|do|run)",
    ],
    preference: [
        "\bprefer\s+",
        "\binstead\s+(?:of|use)",
        "\brather\s+than\b",
        "\buse\s+\w+\s+not\s+\w+",
    ],
};
/**
 * Quick check if user message is a correction.
 *
 * Use this for simple friction detection where you don't need
 * to know the correction type.
 */
export function isCorrection(content) {
    if (!content)
        return false;
    const contentLower = content.toLowerCase();
    return CORRECTION_PATTERNS_SIMPLE.some((p) => contentLower.includes(p));
}
/**
 * Detect if text contains a correction pattern and return its type.
 *
 * Use this when you need to categorize corrections by type
 * (e.g., for detailed friction analysis).
 *
 * @returns [correctionType, matchedPattern] or [null, null]
 */
export function detectCorrectionType(text) {
    if (!text)
        return [null, null];
    const textLower = text.toLowerCase();
    for (const [correctionType, patterns] of Object.entries(CORRECTION_PATTERNS_BY_TYPE)) {
        for (const pattern of patterns) {
            const match = textLower.match(new RegExp(pattern));
            if (match) {
                return [correctionType, match[0]];
            }
        }
    }
    return [null, null];
}
// =============================================================================
// Common Paths
// =============================================================================
/** Get the ~/.ob1 directory path. */
export function getOb1Dir() {
    return path.join(os.homedir(), ".ob1");
}
/** Get the OB1 tmp directory path. */
export function getOb1TmpDir() {
    return path.join(os.homedir(), ".ob1", "tmp");
}
/** Get the path to session_metrics.json. */
export function getSessionMetricsPath() {
    return path.join(os.homedir(), ".ob1", "session_metrics.json");
}
/** Get the path to recommendation_value.json. */
export function getRecommendationValuePath() {
    return path.join(os.homedir(), ".ob1", "recommendation_value.json");
}
// =============================================================================
// Data Loading
// =============================================================================
/**
 * Load session metrics from disk.
 *
 * @returns Parsed session metrics object, or null if file doesn't exist.
 *          On parse error, returns object with 'error' key.
 */
export function loadSessionMetrics() {
    const metricsPath = getSessionMetricsPath();
    if (!fs.existsSync(metricsPath)) {
        return null;
    }
    try {
        let content = fs.readFileSync(metricsPath, "utf-8");
        // Remove BOM if present
        content = content.replace(/^\uFEFF/, "");
        return JSON.parse(content);
    }
    catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { error: `Failed to load session metrics: ${message}` };
    }
}
/**
 * Find all session files, sorted by modification time (newest first).
 *
 * @param tmpDir - The .ob1/tmp directory (defaults to ~/.ob1/tmp)
 * @param projectHash - Optional filter to specific project
 * @param limit - Optional max number of sessions to return
 */
export function findSessionFiles(tmpDir, projectHash, limit) {
    const dir = tmpDir ?? getOb1TmpDir();
    let sessionFiles = [];
    if (projectHash) {
        const projectDir = path.join(dir, projectHash, "chats");
        if (fs.existsSync(projectDir)) {
            sessionFiles = fs
                .readdirSync(projectDir)
                .filter((f) => f.startsWith("session-") && f.endsWith(".json"))
                .map((f) => path.join(projectDir, f));
        }
    }
    else {
        if (!fs.existsSync(dir))
            return [];
        for (const entry of fs.readdirSync(dir)) {
            const entryPath = path.join(dir, entry);
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
            const files = fs
                .readdirSync(chatsDir)
                .filter((f) => f.startsWith("session-") && f.endsWith(".json"))
                .map((f) => path.join(chatsDir, f));
            sessionFiles.push(...files);
        }
    }
    // Sort by modification time, newest first
    sessionFiles.sort((a, b) => {
        try {
            return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
        }
        catch {
            return 0;
        }
    });
    if (limit != null && limit > 0) {
        sessionFiles = sessionFiles.slice(0, limit);
    }
    return sessionFiles;
}
//# sourceMappingURL=utils.js.map