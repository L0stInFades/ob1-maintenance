import { GitHubClient, GitHubAPIError, getCurrentRepo, checkGithubAccess, clearCache, } from "./githubUtils.js";
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
// Review Feedback Pattern Detection
// =============================================================================
const REVIEW_FEEDBACK_PATTERNS = {
    needs_tests: [
        /\badd\s+tests?\b/i,
        /\btest\s+coverage\b/i,
        /\bmissing\s+tests?\b/i,
        /\bunit\s+tests?\b/i,
        /\bno\s+tests?\b/i,
        /\btest\s+this\b/i,
        /\bneeds?\s+testing\b/i,
    ],
    needs_docs: [
        /\badd\s+docs?\b/i,
        /\bdocument(ation)?\b/i,
        /\bREADME\b/i,
        /\bcomments?\s+(needed|missing)\b/i,
        /\bJSDoc\b/i,
        /\btypedoc\b/i,
        /\bdocstring\b/i,
    ],
    code_style: [
        /\blint(ing)?\b/i,
        /\bformat(ting)?\b/i,
        /\bstyle\b/i,
        /\bnaming\b/i,
        /\bconsisten(t|cy)\b/i,
        /\bconvention\b/i,
        /\bprettier\b/i,
        /\beslint\b/i,
    ],
    type_safety: [
        /\btype(s|script)?\b/i,
        /\btyping\b/i,
        /\bany\s+type\b/i,
        /\btype\s+error\b/i,
        /\bgeneric\b/i,
        /\binterface\b/i,
    ],
    error_handling: [
        /\berror\s+handl(e|ing)\b/i,
        /\btry[\s-]catch\b/i,
        /\bexception\b/i,
        /\bedge\s+case\b/i,
        /\bnull\s+check\b/i,
        /\bundefined\b/i,
        /\bvalidat(e|ion)\b/i,
    ],
    performance: [
        /\bperformance\b/i,
        /\boptimiz(e|ation)\b/i,
        /\bslow\b/i,
        /\bmemory\b/i,
        /\befficient\b/i,
        /\bcach(e|ing)\b/i,
        /\bO\(n\^?\d*\)\b/i,
    ],
    security: [
        /\bsecur(e|ity)\b/i,
        /\bvulnerab(le|ility)\b/i,
        /\bsanitiz(e|ation)\b/i,
        /\bXSS\b/i,
        /\binjection\b/i,
        /\bauth(entication|orization)?\b/i,
    ],
    architecture: [
        /\brefactor\b/i,
        /\barchitecture\b/i,
        /\bdesign\b/i,
        /\babstraction\b/i,
        /\bcouple|coupling\b/i,
        /\bseparation\b/i,
        /\bSRP\b/i,
        /\bSOLID\b/i,
    ],
    pr_size: [
        /\btoo\s+(big|large)\b/i,
        /\bsplit\s+(this|up|into)\b/i,
        /\bsmaller\s+(PR|change)\b/i,
        /\bbreak\s+(this|up|into)\b/i,
        /\batomic\b/i,
    ],
};
function detectFeedbackPatterns(text) {
    if (!text)
        return [];
    const detected = [];
    for (const [category, patterns] of Object.entries(REVIEW_FEEDBACK_PATTERNS)) {
        for (const pattern of patterns) {
            if (pattern.test(text)) {
                detected.push(category);
                break; // Only count each category once per text
            }
        }
    }
    return detected;
}
function extractActionableFeedback(comment) {
    if (!comment || comment.length < 10)
        return null;
    let firstSentence = comment.split(". ")[0].split("\n")[0];
    if (firstSentence.length > 150) {
        firstSentence = firstSentence.slice(0, 147) + "...";
    }
    return firstSentence.trim();
}
// =============================================================================
// PR Analysis
// =============================================================================
async function analyzePr(client, owner, repo, pr, fetchDetails = true) {
    const prNumber = pr["number"];
    const user = pr["user"];
    const result = {
        number: prNumber,
        title: pr["title"],
        author: user ? user["login"] : "unknown",
        state: pr["state"],
        merged: pr["merged_at"] != null,
        created_at: pr["created_at"] ?? null,
        merged_at: pr["merged_at"] ?? null,
        closed_at: pr["closed_at"] ?? null,
        additions: pr["additions"] ?? 0,
        deletions: pr["deletions"] ?? 0,
        changed_files: pr["changed_files"] ?? 0,
        review_rounds: 0,
        reviewers: [],
        feedback_patterns: [],
        feedback_examples: [],
        files_changed: [],
        time_to_merge_hours: null,
    };
    // Calculate time to merge
    if (result.merged && result.created_at && result.merged_at) {
        try {
            const created = new Date(result.created_at).getTime();
            const merged = new Date(result.merged_at).getTime();
            result.time_to_merge_hours = (merged - created) / 3_600_000;
        }
        catch {
            // ignore
        }
    }
    if (!fetchDetails)
        return result;
    // Fetch reviews
    try {
        const reviews = await client.getPrReviews(owner, repo, prNumber);
        const reviewers = new Set();
        let reviewRounds = 0;
        let changesRequested = false;
        for (const review of reviews) {
            const reviewUser = review["user"];
            const reviewer = reviewUser
                ? reviewUser["login"]
                : "unknown";
            reviewers.add(reviewer);
            const state = review["state"] ?? "";
            if (state === "CHANGES_REQUESTED") {
                changesRequested = true;
                reviewRounds++;
            }
            else if (state === "APPROVED" && changesRequested) {
                changesRequested = false;
            }
            // Check review body for patterns
            const body = review["body"] ?? "";
            const patterns = detectFeedbackPatterns(body);
            result.feedback_patterns.push(...patterns);
            if (patterns.length > 0 && body) {
                const actionable = extractActionableFeedback(body);
                if (actionable) {
                    result.feedback_examples.push({
                        reviewer,
                        patterns,
                        text: actionable,
                    });
                }
            }
        }
        result.reviewers = Array.from(reviewers);
        result.review_rounds = reviews.length > 0 ? Math.max(1, reviewRounds) : 0;
    }
    catch (e) {
        if (!(e instanceof GitHubAPIError))
            throw e;
    }
    // Fetch review comments (inline comments)
    try {
        const comments = await client.getPrComments(owner, repo, prNumber);
        for (const comment of comments) {
            const body = comment["body"] ?? "";
            const patterns = detectFeedbackPatterns(body);
            result.feedback_patterns.push(...patterns);
            const commentPath = comment["path"];
            if (commentPath) {
                result.files_changed.push(commentPath);
            }
            if (patterns.length > 0 && body) {
                const actionable = extractActionableFeedback(body);
                if (actionable) {
                    const commentUser = comment["user"];
                    const reviewer = commentUser
                        ? commentUser["login"]
                        : "unknown";
                    result.feedback_examples.push({
                        reviewer,
                        patterns,
                        text: actionable,
                        file: commentPath,
                    });
                }
            }
        }
    }
    catch (e) {
        if (!(e instanceof GitHubAPIError))
            throw e;
    }
    // Deduplicate
    result.feedback_patterns = [...new Set(result.feedback_patterns)];
    result.files_changed = [...new Set(result.files_changed)];
    return result;
}
// =============================================================================
// Aggregation & Pattern Extraction
// =============================================================================
function aggregatePrAnalysis(prAnalyses) {
    if (prAnalyses.length === 0) {
        return { error: "No PRs to analyze" };
    }
    // =========================================================================
    // Recurring Feedback Patterns
    // =========================================================================
    const feedbackCounts = {};
    const feedbackExamples = {};
    for (const pr of prAnalyses) {
        for (const pattern of pr.feedback_patterns) {
            feedbackCounts[pattern] = (feedbackCounts[pattern] ?? 0) + 1;
        }
        for (const example of pr.feedback_examples) {
            for (const pattern of example.patterns) {
                if (!feedbackExamples[pattern])
                    feedbackExamples[pattern] = [];
                if (feedbackExamples[pattern].length < 3) {
                    feedbackExamples[pattern].push({
                        pr: pr.number,
                        text: example.text,
                        reviewer: example.reviewer,
                    });
                }
            }
        }
    }
    const recurringFeedback = Object.entries(feedbackCounts)
        .filter(([, count]) => count >= 2)
        .sort(([, a], [, b]) => b - a)
        .map(([pattern, count]) => ({
        pattern,
        count,
        percentage: Math.round((count / prAnalyses.length) * 1000) / 10,
        examples: feedbackExamples[pattern] ?? [],
    }));
    // =========================================================================
    // Reviewer Preferences
    // =========================================================================
    const reviewerPatterns = {};
    const reviewerPrCounts = {};
    for (const pr of prAnalyses) {
        for (const example of pr.feedback_examples) {
            const reviewer = example.reviewer ?? "unknown";
            reviewerPrCounts[reviewer] =
                (reviewerPrCounts[reviewer] ?? 0) + 1;
            if (!reviewerPatterns[reviewer])
                reviewerPatterns[reviewer] = {};
            for (const pattern of example.patterns) {
                reviewerPatterns[reviewer][pattern] =
                    (reviewerPatterns[reviewer][pattern] ?? 0) + 1;
            }
        }
    }
    const reviewerPreferences = {};
    for (const [reviewer, patterns] of Object.entries(reviewerPatterns)) {
        if ((reviewerPrCounts[reviewer] ?? 0) >= 2) {
            const topPatterns = Object.entries(patterns)
                .sort(([, a], [, b]) => b - a)
                .slice(0, 3);
            reviewerPreferences[reviewer] = {
                total_reviews: reviewerPrCounts[reviewer],
                focus_areas: topPatterns.map(([p, c]) => ({
                    pattern: p,
                    count: c,
                })),
            };
        }
    }
    // =========================================================================
    // Merge Velocity Analysis
    // =========================================================================
    const mergedPrs = prAnalyses.filter((pr) => pr.merged);
    const fastMerges = [];
    const slowMerges = [];
    for (const pr of mergedPrs) {
        const hours = pr.time_to_merge_hours;
        if (hours == null)
            continue;
        const prSummary = {
            number: pr.number,
            title: pr.title.slice(0, 60),
            hours_to_merge: Math.round(hours * 10) / 10,
            review_rounds: pr.review_rounds,
            additions: pr.additions,
            deletions: pr.deletions,
            feedback_patterns: pr.feedback_patterns,
        };
        if (hours < 24 && pr.review_rounds <= 1) {
            fastMerges.push(prSummary);
        }
        else if (hours > 72 || pr.review_rounds >= 3) {
            slowMerges.push(prSummary);
        }
    }
    // Analyze what makes PRs fast vs slow
    const fastTraits = [];
    const slowBlockers = [];
    if (fastMerges.length > 0) {
        const avgFastSize = fastMerges.reduce((sum, p) => sum +
            p["additions"] +
            p["deletions"], 0) / fastMerges.length;
        if (avgFastSize < 200) {
            fastTraits.push("Small PR size (avg < 200 lines)");
        }
        const fastWithFeedback = fastMerges.filter((p) => (p["feedback_patterns"] ?? []).length > 0);
        if (fastWithFeedback.length < fastMerges.length * 0.3) {
            fastTraits.push("Clean first submission (minimal feedback)");
        }
    }
    if (slowMerges.length > 0) {
        const slowPatterns = {};
        for (const pr of slowMerges) {
            for (const pattern of pr["feedback_patterns"] ??
                []) {
                slowPatterns[pattern] = (slowPatterns[pattern] ?? 0) + 1;
            }
        }
        const topSlowPatterns = Object.entries(slowPatterns)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 3);
        for (const [pattern, count] of topSlowPatterns) {
            if (count >= 2) {
                slowBlockers.push(`${pattern} (${count} PRs)`);
            }
        }
        const avgSlowSize = slowMerges.reduce((sum, p) => sum +
            p["additions"] +
            p["deletions"], 0) / slowMerges.length;
        if (avgSlowSize > 500) {
            slowBlockers.push(`Large PR size (avg ${Math.round(avgSlowSize)} lines)`);
        }
    }
    const mergeVelocity = {
        total_merged: mergedPrs.length,
        fast_merges: {
            count: fastMerges.length,
            criteria: "< 24 hours, <= 1 review round",
            common_traits: fastTraits,
            examples: fastMerges.slice(0, 5),
        },
        slow_merges: {
            count: slowMerges.length,
            criteria: "> 72 hours or 3+ review rounds",
            common_blockers: slowBlockers,
            examples: slowMerges.slice(0, 5),
        },
    };
    // =========================================================================
    // Risk Areas (files/paths with high friction)
    // =========================================================================
    const fileFriction = {};
    for (const pr of prAnalyses) {
        const files = pr.files_changed;
        const feedback = pr.feedback_patterns;
        for (const filePath of files) {
            const dirPath = filePath.split("/").slice(0, -1).join("/") || "root";
            if (!fileFriction[filePath]) {
                fileFriction[filePath] = {
                    prs_touched: 0,
                    feedback_patterns: {},
                };
            }
            if (!fileFriction[dirPath]) {
                fileFriction[dirPath] = {
                    prs_touched: 0,
                    feedback_patterns: {},
                };
            }
            fileFriction[filePath].prs_touched++;
            fileFriction[dirPath].prs_touched++;
            for (const pattern of feedback) {
                fileFriction[filePath].feedback_patterns[pattern] =
                    (fileFriction[filePath].feedback_patterns[pattern] ?? 0) +
                        1;
                fileFriction[dirPath].feedback_patterns[pattern] =
                    (fileFriction[dirPath].feedback_patterns[pattern] ?? 0) +
                        1;
            }
        }
    }
    // Identify high-risk areas
    const riskAreas = [];
    for (const [filePath, data] of Object.entries(fileFriction)) {
        if (data.prs_touched >= 2) {
            const totalFeedback = Object.values(data.feedback_patterns).reduce((sum, c) => sum + c, 0);
            if (totalFeedback >= 3) {
                const topPatterns = Object.entries(data.feedback_patterns)
                    .sort(([, a], [, b]) => b - a)
                    .slice(0, 3);
                riskAreas.push({
                    path: filePath,
                    prs_touched: data.prs_touched,
                    total_feedback_instances: totalFeedback,
                    common_issues: topPatterns.map(([p, c]) => ({
                        pattern: p,
                        count: c,
                    })),
                });
            }
        }
    }
    riskAreas.sort((a, b) => b["total_feedback_instances"] -
        a["total_feedback_instances"]);
    // =========================================================================
    // PR Quality Correlations
    // =========================================================================
    const qualityInsights = [];
    const largePrs = prAnalyses.filter((pr) => pr.additions + pr.deletions > 500);
    const smallPrs = prAnalyses.filter((pr) => pr.additions + pr.deletions <= 200);
    if (largePrs.length > 0 && smallPrs.length > 0) {
        const avgLargeRounds = largePrs.reduce((sum, pr) => sum + pr.review_rounds, 0) /
            largePrs.length;
        const avgSmallRounds = smallPrs.reduce((sum, pr) => sum + pr.review_rounds, 0) /
            smallPrs.length;
        if (avgLargeRounds > avgSmallRounds * 1.5) {
            qualityInsights.push({
                insight: "Large PRs require more review rounds",
                evidence: `PRs > 500 lines: avg ${avgLargeRounds.toFixed(1)} rounds; PRs <= 200 lines: avg ${avgSmallRounds.toFixed(1)} rounds`,
                recommendation: "Consider breaking large changes into smaller PRs",
            });
        }
    }
    // Correlation: specific feedback patterns and review rounds
    for (const [pattern, count] of Object.entries(feedbackCounts)) {
        if (count >= 5) {
            const prsWithPattern = prAnalyses.filter((pr) => pr.feedback_patterns.includes(pattern));
            const avgRounds = prsWithPattern.reduce((sum, pr) => sum + pr.review_rounds, 0) / prsWithPattern.length;
            if (avgRounds >= 2) {
                qualityInsights.push({
                    insight: `'${pattern}' feedback correlates with multiple review rounds`,
                    evidence: `PRs with ${pattern} feedback: avg ${avgRounds.toFixed(1)} review rounds`,
                    recommendation: `Address ${pattern} proactively before submitting PRs`,
                });
            }
        }
    }
    // =========================================================================
    // Summary
    // =========================================================================
    return {
        summary: {
            total_prs_analyzed: prAnalyses.length,
            merged_prs: mergedPrs.length,
            prs_with_feedback: prAnalyses.filter((pr) => pr.feedback_patterns.length > 0).length,
            unique_reviewers: Object.keys(reviewerPreferences).length,
            risk_areas_identified: riskAreas.length,
        },
        recurring_feedback: recurringFeedback.slice(0, 10),
        reviewer_preferences: reviewerPreferences,
        merge_velocity: mergeVelocity,
        risk_areas: riskAreas.slice(0, 10),
        quality_insights: qualityInsights,
    };
}
// =============================================================================
// Output Formatting
// =============================================================================
function formatAsMarkdown(analysis) {
    const lines = [];
    lines.push("# GitHub PR History Analysis");
    lines.push("");
    const summary = analysis["summary"];
    lines.push("## Summary");
    lines.push("");
    lines.push(`- **PRs analyzed:** ${summary["total_prs_analyzed"] ?? 0}`);
    lines.push(`- **Merged PRs:** ${summary["merged_prs"] ?? 0}`);
    lines.push(`- **PRs with feedback:** ${summary["prs_with_feedback"] ?? 0}`);
    lines.push(`- **Unique reviewers:** ${summary["unique_reviewers"] ?? 0}`);
    lines.push(`- **Risk areas identified:** ${summary["risk_areas_identified"] ?? 0}`);
    lines.push("");
    // Recurring feedback
    const feedback = analysis["recurring_feedback"] ?? [];
    if (feedback.length > 0) {
        lines.push("## Recurring Review Feedback");
        lines.push("");
        lines.push("These patterns appear frequently in PR reviews:");
        lines.push("");
        for (const item of feedback.slice(0, 5)) {
            lines.push(`### ${item["pattern"]} (${item["count"]} PRs, ${item["percentage"]}%)`);
            const examples = item["examples"] ?? [];
            for (const ex of examples.slice(0, 2)) {
                lines.push(`- PR #${ex["pr"]}: "${ex["text"]}"`);
            }
            lines.push("");
        }
    }
    // Merge velocity
    const velocity = analysis["merge_velocity"];
    if (velocity) {
        lines.push("## Merge Velocity");
        lines.push("");
        const fast = velocity["fast_merges"];
        if (fast["count"] > 0) {
            lines.push(`### Fast Merges (${fast["count"]} PRs)`);
            lines.push(`Criteria: ${fast["criteria"]}`);
            const traits = fast["common_traits"] ?? [];
            if (traits.length > 0) {
                lines.push("Common traits:");
                for (const trait of traits) {
                    lines.push(`- ${trait}`);
                }
            }
            lines.push("");
        }
        const slow = velocity["slow_merges"];
        if (slow["count"] > 0) {
            lines.push(`### Slow Merges (${slow["count"]} PRs)`);
            lines.push(`Criteria: ${slow["criteria"]}`);
            const blockers = slow["common_blockers"] ?? [];
            if (blockers.length > 0) {
                lines.push("Common blockers:");
                for (const blocker of blockers) {
                    lines.push(`- ${blocker}`);
                }
            }
            lines.push("");
        }
    }
    // Risk areas
    const risk = analysis["risk_areas"] ?? [];
    if (risk.length > 0) {
        lines.push("## Risk Areas");
        lines.push("");
        lines.push("Files/directories with high review friction:");
        lines.push("");
        for (const area of risk.slice(0, 5)) {
            const issues = (area["common_issues"] ?? [])
                .map((i) => `${i["pattern"]}`)
                .join(", ");
            lines.push(`- **${area["path"]}**: ${area["total_feedback_instances"]} feedback instances (${issues})`);
        }
        lines.push("");
    }
    // Quality insights
    const insights = analysis["quality_insights"] ?? [];
    if (insights.length > 0) {
        lines.push("## Quality Insights");
        lines.push("");
        for (const insight of insights) {
            lines.push(`### ${insight["insight"]}`);
            lines.push(`**Evidence:** ${insight["evidence"]}`);
            lines.push(`**Recommendation:** ${insight["recommendation"]}`);
            lines.push("");
        }
    }
    // Reviewer preferences
    const reviewers = analysis["reviewer_preferences"] ?? {};
    const reviewerEntries = Object.entries(reviewers);
    if (reviewerEntries.length > 0) {
        lines.push("## Reviewer Focus Areas");
        lines.push("");
        for (const [reviewer, data] of reviewerEntries.slice(0, 5)) {
            const focus = (data["focus_areas"] ?? [])
                .map((a) => `${a["pattern"]}`)
                .join(", ");
            lines.push(`- **${reviewer}** (${data["total_reviews"]} reviews): ${focus}`);
        }
        lines.push("");
    }
    return lines.join("\n");
}
// =============================================================================
// Main
// =============================================================================
async function main() {
    const limit = parseInt(getArg("limit", "50"), 10);
    const format = getArg("format", "json");
    const clearCacheFlag = hasFlag("clear-cache");
    const checkAccessFlag = hasFlag("check-access");
    const noCache = hasFlag("no-cache");
    const skipDetails = hasFlag("skip-details");
    const ownerArg = getArg("owner");
    const repoArg = getArg("repo");
    // Handle utility commands
    if (clearCacheFlag) {
        const count = clearCache();
        console.log(JSON.stringify({
            cleared: count,
            message: `Cleared ${count} cached files`,
        }));
        return;
    }
    if (checkAccessFlag) {
        const status = await checkGithubAccess();
        console.log(JSON.stringify(status, null, 2));
        return;
    }
    // Determine repository
    let owner = ownerArg;
    let repo = repoArg;
    if (!owner || !repo) {
        const detected = getCurrentRepo();
        if (detected) {
            owner = owner ?? detected[0];
            repo = repo ?? detected[1];
        }
        else {
            console.log(JSON.stringify({
                error: "Could not detect GitHub repository",
                hint: "Run from a git repository with a GitHub remote, or specify --owner and --repo",
            }));
            process.exit(1);
        }
    }
    // Initialize client
    const client = new GitHubClient();
    if (!client.token) {
        console.log(JSON.stringify({
            error: "No GitHub authentication found",
            hint: "Set GITHUB_TOKEN environment variable or run 'gh auth login'",
        }));
        process.exit(1);
    }
    // Fetch PRs
    let prs;
    try {
        prs = await client.getPullRequests(owner, repo, "closed", limit, !noCache);
    }
    catch (e) {
        if (e instanceof GitHubAPIError) {
            console.log(JSON.stringify({
                error: `Failed to fetch PRs: ${e.message}`,
                status: e.status,
            }));
            process.exit(1);
        }
        throw e;
    }
    if (!prs || prs.length === 0) {
        console.log(JSON.stringify({
            error: "No closed PRs found",
            repo: `${owner}/${repo}`,
        }));
        process.exit(1);
    }
    // Analyze each PR
    const prAnalyses = [];
    for (const pr of prs) {
        try {
            const analysis = await analyzePr(client, owner, repo, pr, !skipDetails);
            prAnalyses.push(analysis);
        }
        catch (e) {
            if (e instanceof GitHubAPIError)
                continue;
            throw e;
        }
    }
    // Aggregate results
    const aggregated = aggregatePrAnalysis(prAnalyses);
    aggregated["repo"] = `${owner}/${repo}`;
    aggregated["analyzed_at"] =
        new Date().toISOString();
    // Output
    if (format === "markdown") {
        console.log(formatAsMarkdown(aggregated));
    }
    else {
        console.log(JSON.stringify(aggregated, null, 2));
    }
}
main();
//# sourceMappingURL=analyze_github_history.js.map