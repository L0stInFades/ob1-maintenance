import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
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
// Helpers
// =============================================================================
function countLines(filePath) {
    try {
        const content = fs.readFileSync(filePath, "utf-8");
        return content.split(/\r?\n/).length;
    }
    catch {
        return 0;
    }
}
function getFileSections(filePath) {
    const sections = [];
    try {
        const content = fs.readFileSync(filePath, "utf-8");
        for (const line of content.split(/\r?\n/)) {
            if (line.startsWith("#")) {
                const header = line.replace(/^#+\s*/, "").trim();
                if (header)
                    sections.push(header);
            }
        }
    }
    catch {
        // ignore
    }
    return sections;
}
function globMd(dir) {
    if (!fs.existsSync(dir))
        return [];
    try {
        return fs
            .readdirSync(dir)
            .filter((f) => f.endsWith(".md"))
            .map((f) => path.join(dir, f));
    }
    catch {
        return [];
    }
}
function readJsonSafe(filePath) {
    try {
        const content = fs.readFileSync(filePath, "utf-8");
        return JSON.parse(content);
    }
    catch {
        return null;
    }
}
// =============================================================================
// Check functions
// =============================================================================
function checkAgentsMd(projectDir, homeDir) {
    const result = {
        project: null,
        global: null,
        warnings: [],
    };
    const projectAgents = path.join(projectDir, "AGENTS.md");
    if (fs.existsSync(projectAgents)) {
        const lines = countLines(projectAgents);
        const sections = getFileSections(projectAgents);
        result["project"] = {
            path: projectAgents,
            lines,
            sections,
            size_bytes: fs.statSync(projectAgents).size,
        };
        if (lines > 150) {
            result["warnings"].push(`Project AGENTS.md has ${lines} lines (>150 recommended max)`);
        }
    }
    const globalAgents = path.join(homeDir, ".ob1", "AGENTS.md");
    if (fs.existsSync(globalAgents)) {
        const lines = countLines(globalAgents);
        const sections = getFileSections(globalAgents);
        result["global"] = {
            path: globalAgents,
            lines,
            sections,
            size_bytes: fs.statSync(globalAgents).size,
        };
        if (lines > 150) {
            result["warnings"].push(`Global AGENTS.md has ${lines} lines (>150 recommended max)`);
        }
    }
    return result;
}
function checkSkills(homeDir) {
    const skillsDir = path.join(homeDir, ".ob1", "skills");
    const result = {
        path: skillsDir,
        exists: fs.existsSync(skillsDir),
        skills: [],
    };
    if (fs.existsSync(skillsDir)) {
        const skills = globMd(skillsDir);
        result["skills"].push(...skills.map((p) => ({
            name: path.basename(p, ".md"),
            path: p,
            lines: countLines(p),
        })));
    }
    return result;
}
function checkCommands(homeDir, projectDir) {
    const result = {
        global: [],
        project: [],
    };
    const globalCommands = path.join(homeDir, ".ob1", "commands");
    if (fs.existsSync(globalCommands)) {
        result["global"].push(...globMd(globalCommands).map((p) => ({
            name: path.basename(p, ".md"),
            path: p,
        })));
    }
    const projectCommands = path.join(projectDir, ".ob1", "commands");
    if (fs.existsSync(projectCommands)) {
        result["project"].push(...globMd(projectCommands).map((p) => ({
            name: path.basename(p, ".md"),
            path: p,
        })));
    }
    return result;
}
function checkHooks(homeDir, projectDir) {
    const hookTypes = [
        "BeforeTool",
        "AfterTool",
        "BeforeAgent",
        "AfterAgent",
        "SessionStart",
        "SessionEnd",
        "BeforeToolSelection",
    ];
    const result = {
        global_settings: null,
        project_settings: null,
        hooks_enabled: false,
        configured_hooks: [],
    };
    // Check global settings
    const globalSettingsPath = path.join(homeDir, ".ob1", "settings.json");
    if (fs.existsSync(globalSettingsPath)) {
        const settings = readJsonSafe(globalSettingsPath);
        if (settings) {
            result["global_settings"] = globalSettingsPath;
            const hooks = settings["hooks"] ?? {};
            if (hooks["enabled"]) {
                result["hooks_enabled"] = true;
            }
            for (const hookType of hookTypes) {
                const hookVal = hooks[hookType];
                if (hookVal && Array.isArray(hookVal) && hookVal.length > 0) {
                    result["configured_hooks"].push({
                        type: hookType,
                        count: hookVal.length,
                    });
                }
            }
        }
    }
    // Check project settings
    const projectSettingsPath = path.join(projectDir, ".ob1", "settings.json");
    if (fs.existsSync(projectSettingsPath)) {
        const settings = readJsonSafe(projectSettingsPath);
        if (settings) {
            result["project_settings"] = projectSettingsPath;
            const hooks = settings["hooks"] ?? {};
            if (hooks["enabled"]) {
                result["hooks_enabled"] = true;
            }
            for (const hookType of hookTypes) {
                const hookVal = hooks[hookType];
                if (hookVal && Array.isArray(hookVal) && hookVal.length > 0) {
                    result["configured_hooks"].push({
                        type: hookType,
                        count: hookVal.length,
                        source: "project",
                    });
                }
            }
        }
    }
    return result;
}
function parsePolicyTomlFiles(dir) {
    const tools = [];
    if (!fs.existsSync(dir))
        return tools;
    let files;
    try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith(".toml"));
    }
    catch {
        return tools;
    }
    for (const file of files) {
        try {
            const content = fs.readFileSync(path.join(dir, file), "utf-8");
            // Parse [[rule]] blocks: extract tool names where decision = "allow"
            // Split on [[rule]] boundaries and process each block
            const blocks = content.split(/\[\[rule\]\]/);
            for (const block of blocks) {
                const toolMatch = block.match(/tool\s*=\s*"([^"]+)"/);
                const decisionMatch = block.match(/decision\s*=\s*"([^"]+)"/);
                if (toolMatch && decisionMatch && decisionMatch[1] === "allow") {
                    if (!tools.includes(toolMatch[1])) {
                        tools.push(toolMatch[1]);
                    }
                }
            }
        }
        catch {
            // ignore unreadable files
        }
    }
    return tools;
}
function checkPolicyRules(homeDir, projectDir) {
    const result = {
        global: [],
        project: [],
        all: [],
        count: 0,
    };
    // Check global policy rules
    const globalPoliciesDir = path.join(homeDir, ".ob1", "policies");
    const globalTools = parsePolicyTomlFiles(globalPoliciesDir);
    if (globalTools.length > 0) {
        result["global"] = globalTools;
        result["all"].push(...globalTools);
    }
    // Check project policy rules
    const projectPoliciesDir = path.join(projectDir, ".ob1", "policies");
    const projectTools = parsePolicyTomlFiles(projectPoliciesDir);
    if (projectTools.length > 0) {
        result["project"] = projectTools;
        for (const tool of projectTools) {
            if (!result["all"].includes(tool)) {
                result["all"].push(tool);
            }
        }
    }
    result["count"] = result["all"].length;
    return result;
}
function checkMcp(homeDir) {
    const result = {
        configured: [],
        count: 0,
    };
    const settingsPath = path.join(homeDir, ".ob1", "settings.json");
    if (fs.existsSync(settingsPath)) {
        const settings = readJsonSafe(settingsPath);
        if (settings) {
            const mcpServers = settings["mcpServers"] ??
                {};
            for (const [name, config] of Object.entries(mcpServers)) {
                result["configured"].push({
                    name,
                    command: (config["command"] ?? "unknown").slice(0, 50),
                });
            }
            result["count"] = result["configured"].length;
        }
    }
    return result;
}
function checkClaudeMigration(homeDir) {
    const result = {
        has_claude_skills: false,
        has_claude_commands: false,
        has_claude_agents: false,
        migration_candidates: [],
    };
    const claudeDir = path.join(homeDir, ".claude");
    if (!fs.existsSync(claudeDir))
        return result;
    // Check for skills
    const skillsDir = path.join(claudeDir, "skills");
    if (fs.existsSync(skillsDir)) {
        const skills = globMd(skillsDir);
        if (skills.length > 0) {
            result["has_claude_skills"] = true;
            result["migration_candidates"].push({
                type: "skills",
                count: skills.length,
                path: skillsDir,
            });
        }
    }
    // Check for commands
    const commandsDir = path.join(claudeDir, "commands");
    if (fs.existsSync(commandsDir)) {
        const commands = globMd(commandsDir);
        if (commands.length > 0) {
            result["has_claude_commands"] = true;
            result["migration_candidates"].push({
                type: "commands",
                count: commands.length,
                path: commandsDir,
            });
        }
    }
    // Check for agents
    const agentsDir = path.join(claudeDir, "agents");
    if (fs.existsSync(agentsDir)) {
        const agents = globMd(agentsDir);
        if (agents.length > 0) {
            result["has_claude_agents"] = true;
            result["migration_candidates"].push({
                type: "agents",
                count: agents.length,
                path: agentsDir,
            });
        }
    }
    return result;
}
function checkExternalSessions(homeDir) {
    const result = {
        codex: {
            path: path.join(homeDir, ".codex", "sessions"),
            exists: false,
            session_count: 0,
        },
        claude: {
            path: path.join(homeDir, ".claude", "projects"),
            exists: false,
            session_count: 0,
        },
        total_external_sessions: 0,
        has_external_history: false,
    };
    // Check Codex sessions
    const codexDir = path.join(homeDir, ".codex", "sessions");
    if (fs.existsSync(codexDir)) {
        const codex = result["codex"];
        codex["exists"] = true;
        codex["session_count"] = countJsonlFilesRecursive(codexDir);
    }
    // Check Claude Code sessions
    const claudeProjectsDir = path.join(homeDir, ".claude", "projects");
    if (fs.existsSync(claudeProjectsDir)) {
        const claude = result["claude"];
        claude["exists"] = true;
        claude["session_count"] = countJsonlFilesRecursive(claudeProjectsDir);
    }
    const codexCount = result["codex"]["session_count"];
    const claudeCount = result["claude"]["session_count"];
    result["total_external_sessions"] = codexCount + claudeCount;
    result["has_external_history"] = codexCount + claudeCount > 0;
    return result;
}
function countJsonlFilesRecursive(dir) {
    let count = 0;
    try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                count += countJsonlFilesRecursive(fullPath);
            }
            else if (entry.name.endsWith(".jsonl")) {
                count++;
            }
        }
    }
    catch {
        // ignore
    }
    return count;
}
// =============================================================================
// Main
// =============================================================================
function main() {
    const projectDir = path.resolve(getArg("project-dir", ".") ?? ".");
    const homeDir = os.homedir();
    const output = {
        project_dir: projectDir,
        agents_md: checkAgentsMd(projectDir, homeDir),
        skills: checkSkills(homeDir),
        commands: checkCommands(homeDir, projectDir),
        hooks: checkHooks(homeDir, projectDir),
        mcp: checkMcp(homeDir),
        policy_rules: checkPolicyRules(homeDir, projectDir),
        claude_migration: checkClaudeMigration(homeDir),
        external_sessions: checkExternalSessions(homeDir),
        recommendations: [],
    };
    // Generate recommendations
    const agentsMd = output["agents_md"];
    if (!agentsMd["project"]) {
        output["recommendations"].push({
            type: "create_agents_md",
            priority: "high",
            message: "Create AGENTS.md with project-specific guidelines",
        });
    }
    const warnings = agentsMd["warnings"] ?? [];
    for (const warning of warnings) {
        output["recommendations"].push({
            type: "agents_md_size",
            priority: "medium",
            message: warning,
        });
    }
    const skills = output["skills"];
    if (!(skills["skills"] ?? []).length) {
        output["recommendations"].push({
            type: "create_skills",
            priority: "low",
            message: "Consider creating skills for repeated personal workflows",
        });
    }
    const claudeMigration = output["claude_migration"];
    const migrationCandidates = claudeMigration["migration_candidates"] ?? [];
    if (migrationCandidates.length > 0) {
        output["recommendations"].push({
            type: "migrate_claude",
            priority: "medium",
            message: `Found ${migrationCandidates.length} Claude Code artifacts to migrate`,
        });
    }
    const externalSessions = output["external_sessions"];
    if (externalSessions["has_external_history"]) {
        const total = externalSessions["total_external_sessions"];
        const sources = [];
        const codex = externalSessions["codex"];
        const claude = externalSessions["claude"];
        if (codex["session_count"] > 0) {
            sources.push(`Codex (${codex["session_count"]})`);
        }
        if (claude["session_count"] > 0) {
            sources.push(`Claude (${claude["session_count"]})`);
        }
        output["recommendations"].push({
            type: "analyze_external_sessions",
            priority: "low",
            message: `Found ${total} sessions from other AI assistants (${sources.join(", ")}) - analyze for transferable patterns`,
        });
    }
    console.log(JSON.stringify(output, null, 2));
}
main();
//# sourceMappingURL=check_setup.js.map