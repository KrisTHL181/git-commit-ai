import OpenAI from 'openai';
import * as vscode from 'vscode';

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface OpenAIConfig {
    endpoint: string;
    apiKey: string;
    model: string;
    temperature: number;
    maxTokens: number;
}

export async function chatCompletion(
    config: OpenAIConfig,
    messages: ChatMessage[],
    token: vscode.CancellationToken
): Promise<string> {
    const client = new OpenAI({
        baseURL: config.endpoint.replace(/\/+$/, ''),
        apiKey: config.apiKey || 'not-needed',
    });

    const abort = new AbortController();
    const onCancel = token.onCancellationRequested(() => abort.abort());

    try {
        const response = await client.chat.completions.create(
            {
                model: config.model,
                messages,
                temperature: config.temperature,
                max_tokens: config.maxTokens,
            },
            { signal: abort.signal }
        );

        const content = response.choices[0]?.message?.content;
        if (!content) {
            throw new Error('No content in API response');
        }

        return content;
    } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
            throw new vscode.CancellationError();
        }
        throw err;
    } finally {
        onCancel.dispose();
    }
}
