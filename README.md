# Git Commit AI

AI-powered git commit message generator for VS Code. Works with any OpenAI-compatible API.

## Why

The official GitHub Copilot Chat extension automatically appends `Co-Authored-By: Copilot` to commit messages it generates. This extension exists because I don't want AI signatures in my commit history — the commit message should reflect my intent, not an advertisement for the tool that helped draft it.

## Features

- Sparkle button in the SCM commit input box — one click to generate a commit message
- Supports any OpenAI-compatible provider: OpenAI, Azure, Ollama, DeepSeek, local LLMs, etc.
- Fully configurable endpoint, model, temperature, and custom instructions
- Zero runtime dependencies beyond the `openai` SDK

## Configuration

| Setting | Default | Description |
|---|---|---|
| `gitcommitai.apiEndpoint` | `https://api.openai.com/v1` | OpenAI-compatible API base URL |
| `gitcommitai.apiKey` | *(empty)* | API key (leave empty for local services) |
| `gitcommitai.model` | `gpt-4o` | Model name |
| `gitcommitai.temperature` | `0.3` | Creativity (0–2) |
| `gitcommitai.maxTokens` | `1024` | Max output tokens |
| `gitcommitai.customInstructions` | *(empty)* | Appended to system prompt, e.g. "Use conventional commits format" |
| `gitcommitai.systemPrompt` | *(empty)* | Override the entire system prompt |

## Examples

**OpenAI:**
```json
"gitcommitai.apiKey": "sk-..."
"gitcommitai.model": "gpt-4o-mini"
```

**Ollama (local):**
```json
"gitcommitai.apiEndpoint": "http://localhost:11434/v1"
"gitcommitai.apiKey": ""
"gitcommitai.model": "llama3"
```

**DeepSeek:**
```json
"gitcommitai.apiEndpoint": "https://api.deepseek.com/v1"
"gitcommitai.apiKey": "sk-..."
"gitcommitai.model": "deepseek-chat"
```

**Conventional commits:**
```json
"gitcommitai.customInstructions": "Use conventional commits format: type(scope): description. Types: feat, fix, docs, style, refactor, perf, test, chore."
```

## How It Works

1. Click the sparkle icon in the SCM input box
2. The extension collects staged changes (or unstaged if nothing is staged), computes diffs, and fetches recent commit messages for style reference
3. A prompt is sent to the configured AI model
4. The generated commit message is inserted into the input box

## Requirements

- VS Code 1.82+
- The `--enable-proposed-api git-commit-ai.git-commit-ai` flag (only needed outside dev mode)
