import * as vscode from 'vscode';
import { chatCompletion, type ChatMessage } from './openai';

// Git API types (subset of what the vscode.git extension exposes)
interface GitChange {
    readonly uri: vscode.Uri;
    readonly originalUri: vscode.Uri;
    readonly renameUri: vscode.Uri | undefined;
    readonly status: GitStatus;
}

interface GitRepositoryState {
    readonly HEAD: { name?: string; commit?: string } | undefined;
    readonly indexChanges: GitChange[];
    readonly workingTreeChanges: GitChange[];
    readonly untrackedChanges: GitChange[];
}

interface GitRepository {
    readonly rootUri: vscode.Uri;
    readonly inputBox: { value: string };
    readonly state: GitRepositoryState;
    status(): Promise<void>;
    diffIndexWithHEAD(path: string): Promise<string>;
    diffWithHEAD(path: string): Promise<string>;
    log(options?: { maxEntries?: number; author?: string }): Promise<{ message: string }[]>;
    getConfig(key: string): Promise<string>;
    getGlobalConfig(key: string): Promise<string>;
}

interface GitAPI {
    readonly repositories: GitRepository[];
    openRepository(uri: vscode.Uri): Promise<GitRepository | null>;
}

// Matches the Status enum from vscode.git
const enum GitStatus {
    INDEX_MODIFIED = 0,
    INDEX_ADDED = 1,
    INDEX_DELETED = 2,
    INDEX_RENAMED = 3,
    INDEX_COPIED = 4,
    MODIFIED = 5,
    DELETED = 6,
    UNTRACKED = 7,
}

const MAX_DIFF_SIZE = 100_000; // characters
const MAX_UNTRACKED_FILE_SIZE = 1 * 1024 * 1024; // 1 MB

// ── Git extension resolution ──────────────────────────────────────────

async function getGitApi(): Promise<GitAPI | undefined> {
    const ext = vscode.extensions.getExtension<{ getAPI(version: number): GitAPI }>('vscode.git');
    if (!ext) {
        return undefined;
    }
    const api = (await ext.activate()).getAPI(1);
    return api;
}

async function resolveRepository(uri?: vscode.Uri): Promise<GitRepository | null> {
    const api = await getGitApi();
    if (!api) {
        vscode.window.showErrorMessage('Git extension not available.');
        return null;
    }

    if (!uri && api.repositories.length === 1) {
        return api.repositories[0];
    }

    uri = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!uri) {
        // Fall back to first available repo
        if (api.repositories.length > 0) {
            return api.repositories[0];
        }
        vscode.window.showErrorMessage('No git repository found.');
        return null;
    }

    const repo = await api.openRepository(uri);
    if (!repo) {
        vscode.window.showErrorMessage('Could not open git repository for URI.');
        return null;
    }
    return repo;
}

// ── Diff helpers ──────────────────────────────────────────────────────

async function computeDiff(repo: GitRepository, change: GitChange): Promise<string> {
    const path = change.uri.fsPath;

    switch (change.status) {
        case GitStatus.INDEX_MODIFIED:
        case GitStatus.INDEX_ADDED:
        case GitStatus.INDEX_DELETED:
        case GitStatus.INDEX_RENAMED:
        case GitStatus.INDEX_COPIED:
            return await repo.diffIndexWithHEAD(path);

        case GitStatus.UNTRACKED:
            return await getUntrackedPatch(repo, change.uri);

        default:
            return await repo.diffWithHEAD(path);
    }
}

async function getUntrackedPatch(repo: GitRepository, resource: vscode.Uri): Promise<string> {
    const patch: string[] = [];
    const relativePath = vscode.workspace.asRelativePath(resource, false);

    try {
        const stat = await vscode.workspace.fs.stat(resource);
        if (stat.size > MAX_UNTRACKED_FILE_SIZE) {
            patch.push(`diff --git a/${relativePath} b/${relativePath}`);
            patch.push('new file mode 100644');
            patch.push('--- /dev/null', `+++ b/${relativePath}`);
            patch.push(`\\ File too large to diff (${Math.round(stat.size / 1024)} KB)`);
            return patch.join('\n') + '\n';
        }
    } catch {
        // stat failed — fall through and try reading anyway
    }

    try {
        const buffer = await vscode.workspace.fs.readFile(resource);
        const content = buffer.toString();
        patch.push(`diff --git a/${relativePath} b/${relativePath}`);
        patch.push('new file mode 100644');
        patch.push('--- /dev/null', `+++ b/${relativePath}`);

        if (content.length > 0) {
            const lines = content.split('\n');
            if (content.endsWith('\n')) {
                lines.pop();
            }
            patch.push(`@@ -0,0 +1,${lines.length} @@`);
            patch.push(...lines.map(line => `+${line}`));
            if (!content.endsWith('\n')) {
                patch.push('\\ No newline at end of file');
            }
        }
    } catch (err) {
        console.warn(`[Git Commit AI] Failed to read untracked file ${relativePath}: ${err}`);
        return '';
    }

    return patch.join('\n') + '\n';
}

function truncateDiff(diff: string): string {
    if (diff.length > MAX_DIFF_SIZE) {
        return diff.substring(0, MAX_DIFF_SIZE) + '\n... [diff truncated]\n';
    }
    return diff;
}

// ── Prompt building ───────────────────────────────────────────────────

function buildSystemPrompt(): string {
    const config = vscode.workspace.getConfiguration('gitcommitai');
    const customSystem = config.get<string>('systemPrompt', '').trim();
    if (customSystem) {
        return customSystem;
    }

    const custom = config.get<string>('customInstructions', '').trim();
    let prompt = `You are an AI programming assistant helping a developer write the best git commit message for their code changes.
You excel at interpreting code changes to craft succinct, clear commit messages.

Follow these steps:
1. Analyze the code changes thoroughly to understand what was modified.
2. Identify the purpose of the changes — answer the *why* for the commit message.
3. Review recent commit messages for style conventions (format, tone, length, capitalization), but do NOT copy them.
4. Generate a thoughtful, succinct commit message following the established conventions.
5. Remove meta-information like issue references, tags, or author names.
6. Return ONLY the commit message wrapped in a single markdown \`\`\`text code block. No other prose.`;

    if (custom) {
        prompt += `\n\nAdditional instructions from the user:\n${custom}`;
    }

    return prompt;
}

function buildUserMessage(
    repoName: string,
    branchName: string,
    repoCommits: string[],
    userCommits: string[],
    diffs: { path: string; diff: string }[]
): string {
    const parts: string[] = [];

    parts.push(`## Repository: ${repoName}`);
    parts.push(`## Branch: ${branchName}`);

    if (userCommits.length > 0) {
        parts.push('\n## Recent Commits (your commits, for style reference only — do NOT copy):');
        for (const msg of userCommits) {
            parts.push(`- ${msg}`);
        }
    }

    if (repoCommits.length > 0) {
        parts.push('\n## Recent Repository Commits (for style reference only — do NOT copy):');
        for (const msg of repoCommits) {
            parts.push(`- ${msg}`);
        }
    }

    parts.push('\n## Changes:');
    for (const { path, diff } of diffs) {
        parts.push(`\n### File: ${path}`);
        parts.push('```diff');
        parts.push(diff);
        parts.push('```');
    }

    parts.push('\nNow generate a commit message describing these changes. Return ONLY a ```text code block.');

    return parts.join('\n');
}

// ── Response parsing ──────────────────────────────────────────────────

function extractCommitMessage(raw: string): string {
    // Try to extract from ```text code block (same as Copilot extension)
    const textBlockRegex = /^```text\s*([\s\S]+?)\s*```$/m;
    const match = textBlockRegex.exec(raw.trim());
    if (match) {
        return match[1].trim();
    }

    // Try any markdown code block
    const codeBlockRegex = /^```[\s\S]*?\s*([\s\S]+?)```$/m;
    const codeMatch = codeBlockRegex.exec(raw.trim());
    if (codeMatch) {
        return codeMatch[1].trim();
    }

    // Fallback: return the raw text, strip any surrounding quotes
    return raw.trim().replace(/^["']|["']$/g, '');
}

// ── Main command handler ──────────────────────────────────────────────

async function generateCommitMessage(
    rootUri: vscode.Uri | undefined,
    cancellationToken: vscode.CancellationToken
): Promise<void> {
    const repo = await resolveRepository(rootUri);
    if (!repo) {
        return;
    }

    // Refresh repository state
    await repo.status();

    const state = repo.state;
    const totalChanges =
        state.indexChanges.length +
        state.workingTreeChanges.length +
        (state.untrackedChanges?.length ?? 0);

    if (totalChanges === 0) {
        vscode.window.showInformationMessage('No changes to commit.');
        return;
    }

    // Prefer staged changes, fall back to unstaged
    const changes: GitChange[] =
        state.indexChanges.length > 0
            ? state.indexChanges
            : [...state.workingTreeChanges, ...(state.untrackedChanges ?? [])];

    // Compute diffs
    const diffs: { path: string; diff: string }[] = [];
    for (const change of changes) {
        if (cancellationToken.isCancellationRequested) {
            return;
        }
        const rawDiff = await computeDiff(repo, change);
        if (rawDiff) {
            const relativePath = vscode.workspace.asRelativePath(change.uri, false);
            diffs.push({ path: relativePath, diff: truncateDiff(rawDiff) });
        }
    }

    if (diffs.length === 0) {
        vscode.window.showInformationMessage('No diff data available for the changes.');
        return;
    }

    // Get recent commits for style reference (non-critical, log but don't block)
    let repoCommits: string[] = [];
    let userCommits: string[] = [];
    try {
        const commits = await repo.log({ maxEntries: 5 });
        repoCommits = commits.map(c => c.message.split('\n')[0]);
    } catch (err) {
        console.warn(`[Git Commit AI] Failed to get recent commits: ${err}`);
    }
    try {
        const author = (await repo.getConfig('user.name')) ?? (await repo.getGlobalConfig('user.name'));
        if (author) {
            const userLog = await repo.log({ maxEntries: 5, author });
            userCommits = userLog.map(c => c.message.split('\n')[0]);
        }
    } catch (err) {
        console.warn(`[Git Commit AI] Failed to get user commits: ${err}`);
    }

    // Build prompts
    const config = vscode.workspace.getConfiguration('gitcommitai');
    const repoName = vscode.workspace.asRelativePath(repo.rootUri, false).split('/').pop() ?? 'repository';
    const branchName = state.HEAD?.name ?? 'HEAD';

    const systemPrompt = buildSystemPrompt();
    const userMessage = buildUserMessage(repoName, branchName, repoCommits, userCommits, diffs);

    const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
    ];

    // Call API with progress
    const commitMessage = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.SourceControl, title: 'Generating commit message...' },
        async () => {
            const rawResponse = await chatCompletion(
                {
                    endpoint: config.get<string>('apiEndpoint', 'https://api.openai.com/v1'),
                    apiKey: config.get<string>('apiKey', ''),
                    model: config.get<string>('model', 'gpt-4o'),
                    temperature: config.get<number>('temperature', 0.3),
                    maxTokens: config.get<number>('maxTokens', 1024),
                },
                messages,
                cancellationToken
            );
            return extractCommitMessage(rawResponse);
        }
    );

    if (commitMessage) {
        repo.inputBox.value = commitMessage;
    }
}

// ── Activation ────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
    const disposable = vscode.commands.registerCommand(
        'gitcommitai.generateCommitMessage',
        async (rootUri: vscode.Uri | undefined) => {
            const tokenSource = new vscode.CancellationTokenSource();
            try {
                await generateCommitMessage(rootUri, tokenSource.token);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                console.error(`[Git Commit AI] ${message}`, err);
                vscode.window.showErrorMessage(`Git Commit AI: ${message}`);
            } finally {
                tokenSource.dispose();
            }
        }
    );

    context.subscriptions.push(disposable);
}

export function deactivate(): void { }
