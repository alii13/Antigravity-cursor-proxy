const fs = require('fs');
const express = require('express');
const { getAuthStatus } = require('./db_helper.cjs');
const { discoverProject } = require('./discover_project.cjs');
const https = require('https');
const crypto = require('crypto');

// Helper to parse JSON with potential trailing junk (common from Cursor)
function gracefulJsonParse(str) {
    try { return JSON.parse(str.trim()); } catch (e) {
        // Try to find the last closing brace or bracket
        const lastBrace = Math.max(str.lastIndexOf('}'), str.lastIndexOf(']'));
        if (lastBrace !== -1) {
            try { return JSON.parse(str.substring(0, lastBrace + 1)); } catch (e2) { }
        }
        throw e;
    }
}

// Helper to parse Google-style tool calls like read(path="foo") into JSON
function parseGoogleToolExpression(expr) {
    const match = expr.match(/(\w+)\s*\(([\s\S]*)\)/);
    if (!match) return null;
    const name = match[1];
    const argsStr = match[2];
    const args = {};
    const argRegex = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\[[\s\S]*?\])|(\{[\s\S]*?\})|(\d+)|(true|false|null))/g;
    let argMatch;
    while ((argMatch = argRegex.exec(argsStr)) !== null) {
        const key = argMatch[1];
        let val = argMatch[2] || argMatch[3] || argMatch[4] || argMatch[5] || argMatch[6] || argMatch[7];
        if (argMatch[6]) val = Number(val);
        else if (argMatch[7]) {
            if (val === 'true') val = true;
            else if (val === 'false') val = false;
            else if (val === 'null') val = null;
        } else if (argMatch[4] || argMatch[5]) {
            try { val = JSON.parse(val.replace(/'/g, '"')); } catch (e) { }
        }
        args[key] = val;
    }
    return { name, args };
}

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Simple CORS middleware
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Global logger to catch all incoming traffic
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] Incoming: ${req.method} ${req.url}`);
    next();
});

// Friendly models list with descriptions
const MODELS_INFO = [
    { id: 'ag-pro', name: 'Gemini 3 Pro', desc: 'Highest intelligence, best for complex logic & architecture.', icon: '🧠' },
    { id: 'ag-flash', name: 'Gemini 3 Flash', desc: 'Lighting fast, perfect for quick edits and chats.', icon: '⚡' },
    { id: 'ag-sonnet', name: 'Claude 4.5 Sonnet (Thinking)', desc: 'Advanced reasoning and deep context understanding.', icon: '🧪' },
    { id: 'ag-opus', name: 'Claude 4.5 Opus (Thinking)', desc: 'Maximum intelligence for the most challenging tasks.', icon: '🏆' },
    { id: 'ag-haiku', name: 'Gemini 2.5 Lite', desc: 'Ultra-lightweight and efficient for simple tasks.', icon: '🎈' }
];

// Root status page
app.get('/', (req, res) => {
    const modelCards = MODELS_INFO.map(m => `
        <div style="background: #1a1b1e; border: 1px solid #333; padding: 15px; border-radius: 10px; margin: 10px 0; display: flex; align-items: center; gap: 15px;">
            <div style="font-size: 24px;">${m.icon}</div>
            <div style="flex: 1;">
                <div style="font-weight: bold; color: #fff;">${m.name}</div>
                <div style="color: #888; font-size: 14px;">${m.desc}</div>
                <code style="color: #61afef; font-size: 12px;">ID: ${m.id}</code>
            </div>
        </div>
    `).join('');

    res.send(`
        <html>
            <body style="background: #0d0e12; color: #fff; font-family: -apple-system, blinkmacsystemfont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; padding: 20px;">
                <div style="max-width: 500px; width: 100%;">
                    <h1 style="text-align: center; margin-bottom: 5px;">🚀 Antigravity Proxy</h1>
                    <p style="text-align: center; color: #888; margin-bottom: 30px;">Your private gateway to Google's Deepmind models.</p>
                    
                    <div style="background: #16171d; border: 1px solid #333; padding: 20px; border-radius: 12px; margin-bottom: 20px;">
                        <div style="font-weight: bold; margin-bottom: 10px; color: #00ff88;">✓ Proxy Connection Stable</div>
                        <div style="font-size: 14px;">Base URL: <code style="background: #000; padding: 3px 6px; border-radius: 4px;">/v1</code></div>
                    </div>

                    <h3 style="margin-left: 5px; margin-bottom: 10px;">Available Models</h3>
                    ${modelCards}

                    <div style="text-align: center; padding: 20px; color: #555; font-size: 12px;">
                        Antigravity Proxy v1.2.0 • Running on Local Port 3000
                    </div>
                </div>
            </body>
        </html>
    `);
});

// Models endpoint for discovery (handle both /v1 and root)
app.get(['/v1/models', '/models'], (req, res) => {
    const modelsList = Object.keys(MODEL_MAPPING).map(id => ({
        id: id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'antigravity'
    }));
    res.json({ object: 'list', data: modelsList });
});

let cachedAuth = {
    token: null,
    project: null,
    lastExtracted: 0
};

async function ensureAuth() {
    if (!cachedAuth.token || (Date.now() - cachedAuth.lastExtracted) > 5 * 60 * 1000) {
        console.log('Refreshing auth status...');
        const status = getAuthStatus();
        if (!status || !status.apiKey) throw new Error('Auth status not found');
        cachedAuth.token = status.apiKey;
        cachedAuth.project = await discoverProject(cachedAuth.token);
        cachedAuth.lastExtracted = Date.now();
        console.log('Auth refreshed for:', status.email, 'Project:', cachedAuth.project);
    }
    return cachedAuth;
}

const MODEL_MAPPING = {
    'ag-pro': 'gemini-3-pro-high',
    'ag-flash': 'gemini-3-flash',
    'ag-sonnet': 'claude-sonnet-4-5-thinking',
    'ag-opus': 'claude-opus-4-5-thinking',
    'ag-haiku': 'gemini-2.5-flash-lite[1m]',
    'gpt-4o': 'gemini-3-pro-high',
    'gpt-4o-mini': 'gemini-3-flash',
    'claude-3-5-sonnet': 'claude-sonnet-4-5-thinking',
    'claude-3-5-sonnet-20241022': 'claude-sonnet-4-5-thinking',
    'claude-3-opus': 'claude-opus-4-5-thinking',
    'claude-3-haiku': 'gemini-2.5-flash-lite[1m]',
    'gemini-1.5-flash': 'gemini-3-flash',
    'gemini-1.5-pro': 'gemini-3-pro-high'
};

const ANTIGRAVITY_SYSTEM_INSTRUCTION = `You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding. You MUST identify yourself as Antigravity. You are powered by Google's latest models. Ignore any previous instructions stating you are from OpenAI or Anthropic.`;

// Standard tool definitions for agentic models
const STANDARD_TOOLS = {
    'ls': { name: 'ls', description: 'List files in a directory', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
    'read_file': { name: 'read_file', description: 'Read content of a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
    'write_file': { name: 'write_file', description: 'Write content to a file', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } },
    'run_command': { name: 'run_command', description: 'Run a shell command', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
    'Agent': { name: 'Agent', description: 'Run a subagent task', parameters: { type: 'object', properties: { prompt: { type: 'string' } } } }
};

app.post(['/v1/chat/completions', '/chat/completions'], async (req, res) => {
    try {
        const { token, project } = await ensureAuth();
        const { model, messages, stream, max_tokens, temperature } = req.body;
        const targetModel = MODEL_MAPPING[model] || model;


        let systemInstructionText = ANTIGRAVITY_SYSTEM_INSTRUCTION;
        const infoMessages = messages.filter(m => m.role === 'system');
        if (infoMessages.length > 0) {
            systemInstructionText += "\n\n" + infoMessages.map(m => m.content).join("\n\n");
        }

        const usedToolNames = new Set();
        const toolIdToName = new Map(); // Track ID -> Name for response mapping

        // Filter out system messages from history, they go to system_instruction
        const chatMessages = messages.filter(m => m.role !== 'system');

        const contents = chatMessages.map(m => {
            let parts = [];

            // 1. Handle tool results
            if (m.role === 'tool') {
                // Resolve name from ID if possible, otherwise fallback
                const name = m.name || toolIdToName.get(m.tool_call_id) || 'run_command';
                usedToolNames.add(name);
                parts = [{
                    functionResponse: {
                        name: name,
                        response: { content: m.content || '' }
                    }
                }];
                return { role: 'user', parts: parts };
            }

            // 2. Handle standard content (text, images, arrays)
            if (Array.isArray(m.content)) {
                parts = m.content.map(p => {
                    if (p.type === 'text') {
                        return { text: p.text };
                    }
                    if (p.type === 'image_url' && p.image_url && p.image_url.url) {
                        // Handle data URI images: data:image/jpeg;base64,.....
                        const match = p.image_url.url.match(/^data:(image\/\w+);base64,(.+)$/);
                        if (match) {
                            return {
                                inlineData: {
                                    mimeType: match[1],
                                    data: match[2]
                                }
                            };
                        }
                    }
                    return null;
                }).filter(p => p !== null);
            } else if (m.content) {
                // ... string content handling ...
                parts = [{ text: m.content }];

                if (m.role === 'assistant') {
                    const toolMatches = [...m.content.matchAll(/<tool_code>([\s\S]*?)<\/tool_code>/g)];
                    for (const match of toolMatches) {
                        const parsed = parseGoogleToolExpression(match[1].trim());
                        if (parsed) {
                            usedToolNames.add(parsed.name);
                            parts.push({
                                functionCall: {
                                    name: parsed.name,
                                    args: parsed.args
                                }
                            });
                        }
                    }
                }
            }

            // 3. Handle explicit tool_calls
            if (m.tool_calls && m.role === 'assistant') {
                // ... (keep existing logic) ...
                m.tool_calls.forEach(tc => {
                    if (tc.type === 'function') {
                        // Store mapping for future response
                        if (tc.id) {
                            toolIdToName.set(tc.id, tc.function.name);
                        }

                        try {
                            usedToolNames.add(tc.function.name);
                            const args = gracefulJsonParse(tc.function.arguments);
                            parts.push({
                                functionCall: {
                                    name: tc.function.name,
                                    args: args
                                }
                            });
                        } catch (e) {
                            console.error('Error parsing tool arguments:', e.message, 'Raw:', tc.function.arguments);
                            const parsed = parseGoogleToolExpression(tc.function.arguments.trim());
                            if (parsed) {
                                usedToolNames.add(parsed.name);
                                parts.push({ functionCall: { name: parsed.name, args: parsed.args } });
                            } else {
                                usedToolNames.add(tc.function.name);
                                parts.push({
                                    functionCall: {
                                        name: tc.function.name,
                                        args: { _raw_arg_content: tc.function.arguments.substring(0, 1000) }
                                    }
                                });
                            }
                        }
                    }
                });
            }

            return {
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: parts.length > 0 ? parts : [{ text: '' }]
            };
        });

        // --- FIX: Inject Thought Signature for Tool Calls ---
        // Google Agent models require a "thought" (text) part before any "functionCall" part in the same turn.
        // If we are sending a history where the model called a tool but didn't leave a thought (common in OpenAI format),
        // we must inject one.
        for (const content of contents) {
            if (content.role === 'model') {
                // Find function calls
                for (const part of content.parts) {
                    if (part.functionCall && !part.thoughtSignature) {
                        // Inject the bypass signature as per documentation
                        part.thoughtSignature = "context_engineering_is_the_way_to_go";
                    }
                }
            }
        }
        // --------------------------------------------------

        const requestObj = {
            contents: contents,
            systemInstruction: {
                parts: [{ text: systemInstructionText }]
            },
            generationConfig: {
                maxOutputTokens: max_tokens || 8192,
                temperature: temperature !== undefined ? temperature : 0.7,
                topP: req.body.top_p,
                topK: req.body.top_k,
                stopSequences: Array.isArray(req.body.stop) ? req.body.stop : (req.body.stop ? [req.body.stop] : undefined)
            }
        };

        // Synthesize Tool Declarations
        const declarations = [];
        const seenDecls = new Set();

        // Add tools from Cursor's request
        if (req.body.tools) {
            req.body.tools.forEach(t => {
                declarations.push({
                    name: t.function.name,
                    description: t.function.description,
                    parameters: t.function.parameters
                });
                seenDecls.add(t.function.name);
            });
        }

        // Ensure every tool mentioned in history is declared
        usedToolNames.forEach(name => {
            if (!seenDecls.has(name)) {
                declarations.push(STANDARD_TOOLS[name] || {
                    name: name,
                    description: `Helper tool ${name}`,
                    parameters: { type: 'object', properties: {} }
                });
                seenDecls.add(name);
            }
        });

        if (declarations.length > 0) {
            requestObj.tools = [{ functionDeclarations: declarations }];
        }

        const payload = {
            project: project,
            model: targetModel,
            request: requestObj,
            userAgent: 'antigravity',
            requestType: 'agent',
            requestId: 'agent-' + crypto.randomUUID()
        };

        // Add tool_config if mode is forced
        if (req.body.tool_choice && typeof req.body.tool_choice === 'object') {
            payload.request.toolConfig = {
                functionCallingConfig: {
                    mode: 'ANY',
                    allowedFunctionNames: [req.body.tool_choice.function.name]
                }
            };
        }

        const headers = {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'antigravity/1.11.5 darwin/arm64',
            'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
            'Client-Metadata': JSON.stringify({
                ideType: 'IDE_UNSPECIFIED',
                platform: 'PLATFORM_UNSPECIFIED',
                pluginType: 'GEMINI'
            })
        };

        // --- DEBUG REQUEST ---
        try {
            fs.appendFileSync('debug_req.log', `[${new Date().toISOString()}] REQUEST PAYLOAD:\n${JSON.stringify(payload, null, 2)}\n----------------\n`);
        } catch (e) { console.error('Log failed', e); }
        // ---------------------

        const remoteUrl = 'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse';

        if (stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            const remoteReq = https.request(remoteUrl, {
                method: 'POST',
                headers: { ...headers, 'Accept': 'text/event-stream' }
            }, (remoteRes) => {
                if (remoteRes.statusCode !== 200) {
                    let body = '';
                    remoteRes.on('data', chunk => body += chunk);
                    remoteRes.on('end', () => {
                        console.error(`Remote error: ${remoteRes.statusCode} - ${body}`);


                        let customMessage = `Remote API error ${remoteRes.statusCode}: ${body}`;
                        if (remoteRes.statusCode === 401) {
                            customMessage = "🔒 Antigravity Session Expired. Please sign out and sign in again in the Antigravity VSCode/Cursor extension to refresh your token.";
                        }

                        const errorEvent = {
                            error: {
                                message: customMessage,
                                type: 'remote_api_error',
                                code: remoteRes.statusCode
                            }
                        };
                        res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
                        res.write('data: [DONE]\n\n');
                        res.end();
                    });
                    return;
                }

                console.log(`Remote status: ${remoteRes.statusCode}`);

                let buffer = '';
                let sentToolCallIds = new Set();
                let lastUsageMetadata = null;

                remoteRes.on('data', (chunk) => {
                    // --- DEBUG LOGGING ---
                    try {
                        fs.appendFileSync('debug_traffic.log', `[${new Date().toISOString()}] CHUNK: ${chunk.toString()}\n---\n`);
                    } catch (e) { }

                    buffer += chunk.toString();
                    const lines = buffer.split('\n');
                    buffer = lines.pop();

                    for (const line of lines) {
                        if (line.startsWith('data:')) {
                            const rawData = line.substring(5).trim();
                            if (!rawData) continue;
                            try {
                                const responseData = JSON.parse(rawData);

                                // Capture usage
                                if (responseData.response?.usageMetadata) {
                                    lastUsageMetadata = responseData.response.usageMetadata;
                                }

                                const candidates = responseData.response?.candidates || [];
                                for (const cand of candidates) {
                                    const parts = cand.content?.parts || [];
                                    const finishReason = cand.finishReason;

                                    for (let i = 0; i < parts.length; i++) {
                                        const part = parts[i];
                                        const baseEvent = {
                                            id: 'chatcmpl-' + crypto.randomUUID(),
                                            object: 'chat.completion.chunk',
                                            created: Math.floor(Date.now() / 1000),
                                            model: model,
                                            choices: [{
                                                index: 0,
                                                delta: {},
                                                finish_reason: finishReason ? (finishReason === 'STOP' ? 'stop' : (finishReason === 'TOOL_USE' ? 'tool_calls' : (finishReason === 'MAX_TOKENS' ? 'length' : finishReason))) : null
                                            }]
                                        };

                                        // 1. Handle Text Content
                                        if (part.text) {
                                            const textEvent = JSON.parse(JSON.stringify(baseEvent));
                                            textEvent.choices[0].delta.content = part.text;

                                            if (finishReason === 'STOP' && i === parts.length - 1) {
                                                textEvent.choices[0].delta.content += ' \n\n*(via Antigravity Proxy)*';
                                            }
                                            res.write(`data: ${JSON.stringify(textEvent)}\n\n`);
                                        }

                                        // 2. Handle Structured Function Calls (with Slicing)
                                        if (part.functionCall) {
                                            const callHash = crypto.createHash('md5').update(part.functionCall.name + JSON.stringify(part.functionCall.args)).digest('hex');

                                            if (!sentToolCallIds.has(callHash)) {
                                                sentToolCallIds.add(callHash);
                                                const callId = 'call_' + crypto.randomUUID().substring(0, 8);
                                                const argsStr = JSON.stringify(part.functionCall.args || {});

                                                // Start chunk
                                                const startEvent = JSON.parse(JSON.stringify(baseEvent));
                                                startEvent.choices[0].delta.tool_calls = [{
                                                    index: 0,
                                                    id: callId,
                                                    type: 'function',
                                                    function: { name: part.functionCall.name, arguments: '' }
                                                }];
                                                res.write(`data: ${JSON.stringify(startEvent)}\n\n`);

                                                // Slice chunks
                                                const SLICE_SIZE = 120;
                                                for (let j = 0; j < argsStr.length; j += SLICE_SIZE) {
                                                    const slice = argsStr.substring(j, j + SLICE_SIZE);
                                                    const argEvent = JSON.parse(JSON.stringify(baseEvent));
                                                    argEvent.choices[0].delta.tool_calls = [{
                                                        index: 0,
                                                        function: { arguments: slice }
                                                    }];
                                                    res.write(`data: ${JSON.stringify(argEvent)}\n\n`);
                                                }
                                            }
                                        }
                                    }
                                }
                            } catch (e) {
                                console.error('Error parsing SSE data:', e.message);
                            }
                        }
                    }
                });

                remoteRes.on('end', () => {
                    if (lastUsageMetadata) {
                        const usageEvent = {
                            id: 'chatcmpl-' + crypto.randomUUID(),
                            object: 'chat.completion.chunk',
                            created: Math.floor(Date.now() / 1000),
                            model: model,
                            choices: [],
                            usage: {
                                prompt_tokens: lastUsageMetadata.promptTokenCount,
                                completion_tokens: lastUsageMetadata.candidatesTokenCount,
                                total_tokens: lastUsageMetadata.totalTokenCount
                            }
                        };
                        res.write(`data: ${JSON.stringify(usageEvent)}\n\n`);
                    }
                    res.write('data: [DONE]\n\n');
                    res.end();
                    console.log('Stream finished');
                });
            });

            remoteReq.on('error', (e) => {
                console.error('Remote request error:', e);
                res.status(500).write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
                res.end();
            });

            remoteReq.write(JSON.stringify(payload));
            remoteReq.end();

        } else {
            const remoteReq = https.request(remoteUrl, {
                method: 'POST',
                headers: { ...headers, 'Accept': 'text/event-stream' }
            }, (remoteRes) => {
                let body = '';
                remoteRes.on('data', chunk => body += chunk);
                remoteRes.on('end', () => {
                    if (remoteRes.statusCode !== 200) {
                        return res.status(remoteRes.statusCode).json({ error: body });
                    }

                    let fullText = '';
                    let toolCalls = [];
                    const lines = body.split('\n');
                    for (const line of lines) {
                        if (line.startsWith('data:')) {
                            try {
                                const data = JSON.parse(line.substring(5).trim());
                                const parts = data.response?.candidates?.[0]?.content?.parts || [];
                                for (const part of parts) {
                                    if (part.text) {
                                        fullText += part.text;
                                        // Inline tag parsing for Google Agent format
                                        const toolMatches = [...part.text.matchAll(/<tool_code>([\s\S]*?)<\/tool_code>/g)];
                                        for (const match of toolMatches) {
                                            const parsed = parseGoogleToolExpression(match[1].trim());
                                            if (parsed) {
                                                toolCalls.push({
                                                    id: 'call_' + crypto.randomUUID().substring(0, 8),
                                                    type: 'function',
                                                    function: {
                                                        name: parsed.name,
                                                        arguments: JSON.stringify(parsed.args)
                                                    }
                                                });
                                            }
                                        }
                                    }
                                    if (part.functionCall) {
                                        toolCalls.push({
                                            id: 'call_' + crypto.randomUUID().substring(0, 8),
                                            type: 'function',
                                            function: {
                                                name: part.functionCall.name,
                                                arguments: JSON.stringify(part.functionCall.args || {})
                                            }
                                        });
                                    }
                                }
                            } catch (e) { }
                        }
                    }

                    res.json({
                        id: 'chatcmpl-' + crypto.randomUUID(),
                        object: 'chat.completion',
                        created: Math.floor(Date.now() / 1000),
                        model: model,
                        choices: [{
                            index: 0,
                            message: {
                                role: 'assistant',
                                content: fullText + ' \n\n*(via Antigravity Proxy)*',
                                tool_calls: toolCalls.length > 0 ? toolCalls : undefined
                            },
                            finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop'
                        }]
                    });
                    console.log('Request finished');
                });
            });

            remoteReq.on('error', (e) => {
                res.status(500).json({ error: e.message });
            });

            remoteReq.write(JSON.stringify(payload));
            remoteReq.end();
        }

    } catch (error) {
        console.error('Proxy error:', error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Antigravity Proxy listening on port ${PORT}`);
});
