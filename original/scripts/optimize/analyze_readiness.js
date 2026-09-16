import * as fs from "node:fs";
import * as path from "node:path";
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
// Analysis
// =============================================================================
function analyzeReadiness(projectDir, outputFormat) {
    const projectPath = projectDir;
    const results = {
        version: "2.0-typescript",
        assessment: {
            overallScore: 0,
            level: 1,
            levelDescription: "Minimal",
        },
        categories: {},
        recommendations: [],
    };
    const criteriaResults = {
        documentation: [],
        agentReadiness: [],
        devEnvironment: [],
        codeQuality: [],
        testing: [],
        cicd: [],
    };
    // ==========================================================================
    // Monorepo Detection
    // ==========================================================================
    const monorepoSubdirs = [];
    const potentialSubdirs = [
        "ob1-extension",
        "gemini-cli",
        "packages",
        "apps",
        "libs",
        "src",
        "client",
        "server",
        "frontend",
        "backend",
        "core",
    ];
    for (const subdir of potentialSubdirs) {
        const subdirPath = path.join(projectPath, subdir);
        try {
            if (fs.statSync(subdirPath).isDirectory()) {
                monorepoSubdirs.push(subdir);
                // Also check for nested packages
                if (subdir === "packages") {
                    for (const pkg of fs.readdirSync(subdirPath)) {
                        const pkgPath = path.join(subdirPath, pkg);
                        try {
                            if (fs.statSync(pkgPath).isDirectory()) {
                                monorepoSubdirs.push(`packages/${pkg}`);
                            }
                        }
                        catch {
                            // ignore
                        }
                    }
                }
            }
        }
        catch {
            // ignore
        }
    }
    // ==========================================================================
    // Helper functions
    // ==========================================================================
    function fileExists(...paths) {
        for (const p of paths) {
            if (fs.existsSync(path.join(projectPath, p))) {
                return [true, p];
            }
        }
        return [false, null];
    }
    function fileExistsWithSubdirs(...paths) {
        // First check root
        for (const p of paths) {
            if (fs.existsSync(path.join(projectPath, p))) {
                return [true, p];
            }
        }
        // Then check subdirectories
        for (const subdir of monorepoSubdirs) {
            for (const p of paths) {
                const fullPath = `${subdir}/${p}`;
                if (fs.existsSync(path.join(projectPath, fullPath))) {
                    return [true, fullPath];
                }
            }
        }
        return [false, null];
    }
    function fileContains(filepath, patterns) {
        try {
            const content = fs
                .readFileSync(path.join(projectPath, filepath), "utf-8")
                .toLowerCase();
            for (const p of patterns) {
                if (content.includes(p.toLowerCase())) {
                    return true;
                }
            }
        }
        catch {
            // ignore
        }
        return false;
    }
    function getFileSize(filepath) {
        try {
            return fs.statSync(path.join(projectPath, filepath)).size;
        }
        catch {
            return 0;
        }
    }
    // ==========================================================================
    // Documentation Criteria
    // ==========================================================================
    // DOC-001: README.md exists
    let [exists, foundPath] = fileExists("README.md", "readme.md", "Readme.md");
    criteriaResults["documentation"].push({
        id: "DOC-001",
        name: "README.md exists",
        status: exists ? "pass" : "fail",
        score: exists ? 1 : 0,
        weight: 1,
        evidence: exists ? `Found at ${foundPath}` : "No README.md found",
    });
    // DOC-007: AGENTS.md exists
    const agentFiles = [
        "AGENTS.md",
        "CLAUDE.md",
        ".cursor/rules",
        ".github/copilot-instructions.md",
    ];
    [exists, foundPath] = fileExists(...agentFiles);
    const agentFileExists = exists;
    const agentFilePath = foundPath;
    criteriaResults["documentation"].push({
        id: "DOC-007",
        name: "AGENTS.md exists",
        status: exists ? "pass" : "fail",
        score: exists ? 1 : 0,
        weight: 2,
        evidence: exists
            ? `Found at ${foundPath}`
            : "No agent context file found",
    });
    // DOC-008: Agent file has build command
    const hasBuild = agentFileExists && agentFilePath
        ? fileContains(agentFilePath, ["build", "compile", "make"])
        : false;
    criteriaResults["documentation"].push({
        id: "DOC-008",
        name: "Agent file has build command",
        status: hasBuild ? "pass" : "fail",
        score: hasBuild ? 1 : 0,
        weight: 1.5,
        evidence: hasBuild
            ? "Build command found"
            : "No build command in agent file",
    });
    // DOC-009: Agent file has test command
    const hasTest = agentFileExists && agentFilePath
        ? fileContains(agentFilePath, ["test", "spec", "check"])
        : false;
    criteriaResults["documentation"].push({
        id: "DOC-009",
        name: "Agent file has test command",
        status: hasTest ? "pass" : "fail",
        score: hasTest ? 1 : 0,
        weight: 1.5,
        evidence: hasTest
            ? "Test command found"
            : "No test command in agent file",
    });
    // ==========================================================================
    // Agent Readiness Criteria
    // ==========================================================================
    // AGT-001: Agent context file exists
    criteriaResults["agentReadiness"].push({
        id: "AGT-001",
        name: "Agent context file exists",
        status: agentFileExists ? "pass" : "fail",
        score: agentFileExists ? 1 : 0,
        weight: 2,
        evidence: agentFileExists
            ? `Found at ${agentFilePath}`
            : "No AGENTS.md or similar",
    });
    // AGT-025: AGENTS.md appropriately sized
    let agtStatus;
    let agtScore;
    let agtEvidence;
    if (agentFileExists && agentFilePath) {
        const size = getFileSize(agentFilePath);
        if (size <= 8192) {
            agtStatus = "pass";
            agtScore = 1;
        }
        else if (size <= 16384) {
            agtStatus = "partial";
            agtScore = 0.5;
        }
        else {
            agtStatus = "fail";
            agtScore = 0;
        }
        agtEvidence = `File size: ${(size / 1024).toFixed(1)}KB (recommended < 8KB)`;
    }
    else {
        agtStatus = "na";
        agtScore = 0;
        agtEvidence = "N/A";
    }
    criteriaResults["agentReadiness"].push({
        id: "AGT-025",
        name: "AGENTS.md appropriately sized",
        status: agtStatus,
        score: agtScore,
        weight: 1.5,
        evidence: agtEvidence,
    });
    // ==========================================================================
    // Dev Environment Criteria
    // ==========================================================================
    // ENV-004: .gitignore exists
    [exists] = fileExists(".gitignore");
    criteriaResults["devEnvironment"].push({
        id: "ENV-004",
        name: ".gitignore exists",
        status: exists ? "pass" : "fail",
        score: exists ? 1 : 0,
        weight: 1,
        evidence: exists ? "Found .gitignore" : "No .gitignore",
    });
    // ENV-001: .env.example exists
    [exists, foundPath] = fileExists(".env.example", ".env.sample", ".env.template");
    criteriaResults["devEnvironment"].push({
        id: "ENV-001",
        name: ".env.example exists",
        status: exists ? "pass" : "fail",
        score: exists ? 1 : 0,
        weight: 1,
        evidence: exists ? `Found at ${foundPath}` : "No .env.example",
    });
    // ENV-012: Lock file committed
    const lockFiles = [
        "package-lock.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        "bun.lockb",
        "Cargo.lock",
        "poetry.lock",
        "Gemfile.lock",
    ];
    [exists, foundPath] = fileExists(...lockFiles);
    criteriaResults["devEnvironment"].push({
        id: "ENV-012",
        name: "Lock file committed",
        status: exists ? "pass" : "fail",
        score: exists ? 1 : 0,
        weight: 1,
        evidence: exists ? `Found ${foundPath}` : "No lock file",
    });
    // ==========================================================================
    // Code Quality Criteria
    // ==========================================================================
    // QUAL-001: Linter configured
    const linterFiles = [
        ".eslintrc",
        ".eslintrc.js",
        ".eslintrc.json",
        "eslint.config.js",
        "eslint.config.mjs",
        "biome.json",
        ".pylintrc",
        "ruff.toml",
        "pyproject.toml",
    ];
    [exists, foundPath] = fileExistsWithSubdirs(...linterFiles);
    criteriaResults["codeQuality"].push({
        id: "QUAL-001",
        name: "Linter configured",
        status: exists ? "pass" : "fail",
        score: exists ? 1 : 0,
        weight: 1,
        evidence: exists ? `Found ${foundPath}` : "No linter configured",
    });
    // QUAL-004: Type checking configured
    const typeFiles = [
        "tsconfig.json",
        "jsconfig.json",
        "mypy.ini",
        "pyrightconfig.json",
        "pyproject.toml",
    ];
    [exists, foundPath] = fileExistsWithSubdirs(...typeFiles);
    // Rust/Go auto-pass
    if (!exists) {
        const [rustExists] = fileExistsWithSubdirs("Cargo.toml");
        const [goExists] = fileExistsWithSubdirs("go.mod");
        if (rustExists || goExists) {
            exists = true;
            foundPath = rustExists ? "Cargo.toml" : "go.mod";
        }
    }
    criteriaResults["codeQuality"].push({
        id: "QUAL-004",
        name: "Type checking configured",
        status: exists ? "pass" : "fail",
        score: exists ? 1 : 0,
        weight: 1,
        evidence: exists
            ? `Found ${foundPath}`
            : "No type checker configured",
    });
    // ==========================================================================
    // Testing Criteria
    // ==========================================================================
    // TEST-001: Test directory exists
    const testDirs = ["test", "tests", "__tests__", "spec"];
    [exists, foundPath] = fileExistsWithSubdirs(...testDirs);
    criteriaResults["testing"].push({
        id: "TEST-001",
        name: "Test directory exists",
        status: exists ? "pass" : "fail",
        score: exists ? 1 : 0,
        weight: 1,
        evidence: exists ? `Found at ${foundPath}/` : "No test directory",
    });
    // TEST-003: Test framework configured
    const testConfigs = [
        "jest.config.js",
        "jest.config.ts",
        "vitest.config.ts",
        "vitest.config.js",
        "pytest.ini",
        "conftest.py",
    ];
    [exists, foundPath] = fileExistsWithSubdirs(...testConfigs);
    criteriaResults["testing"].push({
        id: "TEST-003",
        name: "Test framework configured",
        status: exists ? "pass" : "fail",
        score: exists ? 1 : 0,
        weight: 1,
        evidence: exists
            ? `Found ${foundPath}`
            : "No test framework configured",
    });
    // ==========================================================================
    // CI/CD Criteria
    // ==========================================================================
    // CI-001: CI config exists
    const ciPaths = [
        ".github/workflows",
        ".gitlab-ci.yml",
        ".circleci",
        "Jenkinsfile",
    ];
    [exists, foundPath] = fileExists(...ciPaths);
    criteriaResults["cicd"].push({
        id: "CI-001",
        name: "CI config exists",
        status: exists ? "pass" : "fail",
        score: exists ? 1 : 0,
        weight: 1,
        evidence: exists ? `Found at ${foundPath}` : "No CI configuration",
    });
    // ==========================================================================
    // Calculate Scores
    // ==========================================================================
    const categoryWeights = {
        agentReadiness: 3.0,
        documentation: 2.0,
        testing: 1.5,
        codeQuality: 1.5,
        devEnvironment: 1.25,
        cicd: 1.0,
    };
    let totalWeightedScore = 0;
    let totalWeight = 0;
    for (const [categoryId, criteria] of Object.entries(criteriaResults)) {
        const catWeight = categoryWeights[categoryId] ?? 1.0;
        const applicable = criteria.filter((c) => c.status !== "na");
        let catScore;
        if (applicable.length === 0) {
            catScore = null;
        }
        else {
            const totalCriterionWeight = applicable.reduce((sum, c) => sum + c.weight, 0);
            const weightedSum = applicable.reduce((sum, c) => sum + c.score * c.weight, 0);
            catScore =
                totalCriterionWeight > 0
                    ? (weightedSum / totalCriterionWeight) * 100
                    : 0;
        }
        const passed = criteria.filter((c) => c.status === "pass").length;
        const partial = criteria.filter((c) => c.status === "partial").length;
        const failed = criteria.filter((c) => c.status === "fail").length;
        results.categories[categoryId] = {
            score: catScore != null ? Math.round(catScore) : null,
            weight: catWeight,
            passed,
            partial,
            failed,
            notApplicable: criteria.length - applicable.length,
            criteria,
        };
        if (catScore != null) {
            totalWeightedScore += catScore * catWeight;
            totalWeight += catWeight;
        }
    }
    const overallScore = totalWeight > 0 ? totalWeightedScore / totalWeight : 0;
    // Determine level
    let level;
    let levelDesc;
    if (overallScore >= 80) {
        level = 5;
        levelDesc = "Excellent";
    }
    else if (overallScore >= 65) {
        level = 4;
        levelDesc = "High";
    }
    else if (overallScore >= 50) {
        level = 3;
        levelDesc = "Moderate";
    }
    else if (overallScore >= 35) {
        level = 2;
        levelDesc = "Basic";
    }
    else {
        level = 1;
        levelDesc = "Minimal";
    }
    results.assessment.overallScore = Math.round(overallScore);
    results.assessment.level = level;
    results.assessment.levelDescription = levelDesc;
    // Generate recommendations for failing criteria
    for (const [categoryId, category] of Object.entries(results.categories)) {
        for (const criterion of category.criteria) {
            if (criterion.status === "fail" ||
                criterion.status === "partial") {
                results.recommendations.push({
                    criterionId: criterion.id,
                    category: categoryId,
                    title: criterion.name,
                    description: criterion.evidence,
                    impact: criterion.weight >= 1.5 ? "high" : "medium",
                });
            }
        }
    }
    // Sort recommendations by category weight
    results.recommendations.sort((a, b) => -(results.categories[a.category]?.weight ?? 0) +
        (results.categories[b.category]?.weight ?? 0));
    results.recommendations = results.recommendations.slice(0, 10);
    if (outputFormat === "markdown") {
        return formatMarkdown(results);
    }
    return results;
}
// =============================================================================
// Markdown Formatting
// =============================================================================
function formatMarkdown(report) {
    const lines = [];
    const assessment = report.assessment;
    lines.push("# Agent Readiness Report");
    lines.push("");
    lines.push(`**Overall Score:** ${assessment.overallScore}/100`);
    lines.push(`**Level:** ${assessment.level} - ${assessment.levelDescription}`);
    lines.push("");
    lines.push("## Category Scores");
    lines.push("");
    lines.push("| Category | Score | Passed | Failed |");
    lines.push("|----------|-------|--------|--------|");
    for (const [catId, cat] of Object.entries(report.categories)) {
        const score = cat.score != null ? `${cat.score}%` : "N/A";
        lines.push(`| ${catId} | ${score} | ${cat.passed} | ${cat.failed} |`);
    }
    lines.push("");
    if (report.recommendations.length > 0) {
        lines.push("## Top Recommendations");
        lines.push("");
        for (let i = 0; i < Math.min(5, report.recommendations.length); i++) {
            const rec = report.recommendations[i];
            lines.push(`${i + 1}. **${rec.title}** (${rec.criterionId})`);
            lines.push(`   - ${rec.description}`);
        }
        lines.push("");
    }
    return lines.join("\n");
}
// =============================================================================
// Main
// =============================================================================
function main() {
    const projectDirArg = getArg("project-dir", ".");
    const format = getArg("format", "json");
    const projectDir = path.resolve(projectDirArg);
    try {
        if (!fs.statSync(projectDir).isDirectory()) {
            console.error(`Error: ${projectDir} is not a valid directory`);
            process.exit(1);
        }
    }
    catch {
        console.error(`Error: ${projectDir} is not a valid directory`);
        process.exit(1);
    }
    const result = analyzeReadiness(projectDir, format);
    if (result == null) {
        console.error("Error: Failed to analyze codebase");
        process.exit(1);
    }
    if (typeof result === "string") {
        console.log(result);
    }
    else {
        console.log(JSON.stringify(result, null, 2));
    }
}
main();
//# sourceMappingURL=analyze_readiness.js.map