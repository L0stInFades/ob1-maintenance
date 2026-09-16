import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
// =============================================================================
// Configuration
// =============================================================================
const GITHUB_API_BASE = "https://api.github.com";
const CACHE_DIR = path.join(os.homedir(), ".ob1", "cache", "github");
const CACHE_TTL_MS = 1 * 60 * 60 * 1000; // 1 hour
const DEFAULT_PER_PAGE = 100;
const MAX_PAGES = 10;
function rateLimitFromHeaders(headers) {
    return {
        remaining: parseInt(headers.get("x-ratelimit-remaining") ?? "60", 10),
        limit: parseInt(headers.get("x-ratelimit-limit") ?? "60", 10),
        resetTime: new Date(parseInt(headers.get("x-ratelimit-reset") ??
            String(Math.floor(Date.now() / 1000) + 3600), 10) * 1000),
    };
}
// =============================================================================
// Authentication
// =============================================================================
export function getGithubToken() {
    const token = process.env["GITHUB_TOKEN"] || process.env["GH_TOKEN"];
    if (token)
        return token;
    try {
        const result = execSync("gh auth token", {
            timeout: 5000,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        });
        const trimmed = result.trim();
        if (trimmed)
            return trimmed;
    }
    catch {
        // gh CLI not installed or not authenticated
    }
    return null;
}
export function getCurrentRepo() {
    try {
        const result = execSync("git remote get-url origin", {
            timeout: 5000,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        });
        const remoteUrl = result.trim();
        if (!remoteUrl.includes("github.com"))
            return null;
        let repoPath;
        if (remoteUrl.startsWith("git@")) {
            // SSH format: git@github.com:owner/repo.git
            repoPath = remoteUrl.split(":").pop() ?? "";
        }
        else {
            // HTTPS format: https://github.com/owner/repo.git
            repoPath = remoteUrl.split("github.com/").pop() ?? "";
        }
        repoPath = repoPath.replace(/\.git$/, "").replace(/\/$/, "");
        const parts = repoPath.split("/");
        if (parts.length >= 2) {
            return [parts[0], parts[1]];
        }
    }
    catch {
        // Not a git repo or no origin remote
    }
    return null;
}
// =============================================================================
// Caching
// =============================================================================
function getCachePath(cacheKey) {
    const safeKey = cacheKey
        .replace(/\//g, "_")
        .replace(/\?/g, "_")
        .replace(/&/g, "_");
    return path.join(CACHE_DIR, `${safeKey}.json`);
}
function isCacheValid(cachePath) {
    try {
        const stat = fs.statSync(cachePath);
        return Date.now() - stat.mtimeMs < CACHE_TTL_MS;
    }
    catch {
        return false;
    }
}
function readCache(cacheKey) {
    const cachePath = getCachePath(cacheKey);
    if (!isCacheValid(cachePath))
        return null;
    try {
        const content = fs.readFileSync(cachePath, "utf-8");
        return JSON.parse(content);
    }
    catch {
        return null;
    }
}
function writeCache(cacheKey, data) {
    try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        const cachePath = getCachePath(cacheKey);
        fs.writeFileSync(cachePath, JSON.stringify(data));
    }
    catch {
        // Cache write failures are non-fatal
    }
}
export function clearCache() {
    if (!fs.existsSync(CACHE_DIR))
        return 0;
    let count = 0;
    for (const entry of fs.readdirSync(CACHE_DIR)) {
        if (entry.endsWith(".json")) {
            try {
                fs.unlinkSync(path.join(CACHE_DIR, entry));
                count++;
            }
            catch {
                // Ignore unlink failures
            }
        }
    }
    return count;
}
// =============================================================================
// API Client
// =============================================================================
export class GitHubAPIError extends Error {
    status;
    response;
    constructor(status, message, response = null) {
        super(`GitHub API error ${status}: ${message}`);
        this.name = "GitHubAPIError";
        this.status = status;
        this.response = response;
    }
}
export class GitHubClient {
    token;
    rateLimit = null;
    _lastRequestTime = 0;
    constructor(token) {
        this.token = token ?? getGithubToken();
    }
    async _makeRequest(endpoint, params, useCache = true) {
        // Build URL with params
        let url = `${GITHUB_API_BASE}${endpoint}`;
        if (params) {
            const queryParts = [];
            for (const [k, v] of Object.entries(params)) {
                if (v != null)
                    queryParts.push(`${k}=${v}`);
            }
            if (queryParts.length > 0) {
                url = `${url}?${queryParts.join("&")}`;
            }
        }
        const cacheKey = url;
        // Check cache first
        if (useCache) {
            const cached = readCache(cacheKey);
            if (cached != null)
                return cached;
        }
        // Rate limit check
        if (this.rateLimit && this.rateLimit.remaining < 10) {
            const waitTime = (this.rateLimit.resetTime.getTime() - Date.now()) / 1000;
            if (waitTime > 0) {
                if (waitTime > 60) {
                    throw new GitHubAPIError(429, `Rate limit exceeded. Resets at ${this.rateLimit.resetTime.toISOString()}`);
                }
                await new Promise((resolve) => setTimeout(resolve, Math.min(waitTime, 60) * 1000));
            }
        }
        // Throttle requests (max 10/second)
        const elapsed = Date.now() - this._lastRequestTime;
        if (elapsed < 100) {
            await new Promise((resolve) => setTimeout(resolve, 100 - elapsed));
        }
        // Build request headers
        const headers = {
            Accept: "application/vnd.github+json",
            "User-Agent": "OB1-Optimize",
            "X-GitHub-Api-Version": "2022-11-28",
        };
        if (this.token) {
            headers["Authorization"] = `Bearer ${this.token}`;
        }
        this._lastRequestTime = Date.now();
        let response;
        try {
            response = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            throw new GitHubAPIError(0, `Network error: ${message}`);
        }
        // Update rate limit info
        this.rateLimit = rateLimitFromHeaders(response.headers);
        if (!response.ok) {
            let errorBody = {};
            try {
                errorBody = (await response.json());
            }
            catch {
                // ignore parse errors
            }
            throw new GitHubAPIError(response.status, errorBody["message"] ?? response.statusText, errorBody);
        }
        const data = await response.json();
        // Cache successful response
        if (useCache) {
            writeCache(cacheKey, data);
        }
        return data;
    }
    async _paginate(endpoint, params, limit, useCache = true) {
        const p = { ...params };
        p["per_page"] = Math.min(DEFAULT_PER_PAGE, limit ?? DEFAULT_PER_PAGE);
        const allItems = [];
        let page = 1;
        while (page <= MAX_PAGES) {
            p["page"] = page;
            let response;
            try {
                response = await this._makeRequest(endpoint, p, useCache);
            }
            catch {
                break;
            }
            if (!response || !Array.isArray(response))
                break;
            allItems.push(...response);
            if (limit && allItems.length >= limit) {
                return allItems.slice(0, limit);
            }
            if (response.length < p["per_page"])
                break;
            page++;
        }
        return allItems;
    }
    // =========================================================================
    // High-level API methods
    // =========================================================================
    async getPullRequests(owner, repo, state = "closed", limit = 50, useCache = true) {
        return this._paginate(`/repos/${owner}/${repo}/pulls`, { state, sort: "updated", direction: "desc" }, limit, useCache);
    }
    async getPrReviews(owner, repo, prNumber, useCache = true) {
        return this._paginate(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, undefined, undefined, useCache);
    }
    async getPrComments(owner, repo, prNumber, useCache = true) {
        return this._paginate(`/repos/${owner}/${repo}/pulls/${prNumber}/comments`, undefined, undefined, useCache);
    }
    async getPrCommits(owner, repo, prNumber, useCache = true) {
        return this._paginate(`/repos/${owner}/${repo}/pulls/${prNumber}/commits`, undefined, undefined, useCache);
    }
    async getRepoInfo(owner, repo, useCache = true) {
        return (await this._makeRequest(`/repos/${owner}/${repo}`, undefined, useCache));
    }
    async getAuthenticatedUser() {
        if (!this.token)
            return null;
        try {
            return (await this._makeRequest("/user", undefined, false));
        }
        catch {
            return null;
        }
    }
}
// =============================================================================
// Convenience functions
// =============================================================================
export async function checkGithubAccess() {
    const client = new GitHubClient();
    const result = {
        authenticated: false,
        username: null,
        rate_limit: null,
        repo: null,
    };
    // Check authentication
    const user = await client.getAuthenticatedUser();
    if (user) {
        result["authenticated"] = true;
        result["username"] = user["login"] ?? null;
    }
    // Check rate limit
    if (client.rateLimit) {
        result["rate_limit"] = {
            remaining: client.rateLimit.remaining,
            limit: client.rateLimit.limit,
            reset: client.rateLimit.resetTime.toISOString(),
        };
    }
    // Check if in a GitHub repo
    const repoInfo = getCurrentRepo();
    if (repoInfo) {
        result["repo"] = {
            owner: repoInfo[0],
            name: repoInfo[1],
        };
    }
    return result;
}
//# sourceMappingURL=githubUtils.js.map