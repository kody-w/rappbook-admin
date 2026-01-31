const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const Store = require('electron-store');
const { Octokit } = require('@octokit/rest');

const store = new Store();

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1000,
        minHeight: 700,
        titleBarStyle: 'hiddenInset',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        backgroundColor: '#0a0a0b'
    });

    mainWindow.loadFile('index.html');

    // Open external links in browser
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

// IPC Handlers

// Store management
ipcMain.handle('store:get', (_, key) => store.get(key));
ipcMain.handle('store:set', (_, key, value) => store.set(key, value));
ipcMain.handle('store:delete', (_, key) => store.delete(key));

// GitHub authentication
ipcMain.handle('github:auth', async (_, token) => {
    try {
        const octokit = new Octokit({ auth: token });
        const { data: user } = await octokit.users.getAuthenticated();
        store.set('github_token', token);
        store.set('github_user', user);
        return { success: true, user };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('github:logout', async () => {
    store.delete('github_token');
    store.delete('github_user');
    return { success: true };
});

// GitHub API operations
ipcMain.handle('github:api', async (_, method, endpoint, data) => {
    const token = store.get('github_token');
    if (!token) {
        return { success: false, error: 'Not authenticated' };
    }

    try {
        const octokit = new Octokit({ auth: token });
        let result;

        switch (method) {
            case 'GET':
                result = await octokit.request(`GET ${endpoint}`);
                break;
            case 'POST':
                result = await octokit.request(`POST ${endpoint}`, data);
                break;
            case 'PUT':
                result = await octokit.request(`PUT ${endpoint}`, data);
                break;
            case 'PATCH':
                result = await octokit.request(`PATCH ${endpoint}`, data);
                break;
            case 'DELETE':
                result = await octokit.request(`DELETE ${endpoint}`);
                break;
            default:
                throw new Error(`Unknown method: ${method}`);
        }

        return { success: true, data: result.data };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// RAPP API
ipcMain.handle('rapp:api', async (_, action, params) => {
    const endpoint = store.get('rapp_endpoint');
    if (!endpoint) {
        return { success: false, error: 'RAPP API endpoint not configured. Set it in Settings.' };
    }

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                rapp_action: action,
                rapp_params: params
            })
        });

        const data = await response.json();
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Copilot/AI generation
ipcMain.handle('ai:generate', async (_, prompt, context) => {
    // Check for Anthropic API key first (more capable)
    const anthropicKey = store.get('anthropic_api_key');
    if (anthropicKey) {
        try {
            const Anthropic = require('@anthropic-ai/sdk');
            const client = new Anthropic({ apiKey: anthropicKey });

            const message = await client.messages.create({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 4096,
                system: `You are an AI assistant helping to manage RAPPbook, a social network for AI agents.
You help create posts, moderate content, and generate engaging content for the community.
When generating posts, use proper JSON format that matches the RAPPbook schema.
Available communities: agents, demos, crypto, enterprise, general`,
                messages: [{ role: 'user', content: `${context ? `Context: ${context}\n\n` : ''}${prompt}` }]
            });

            return {
                success: true,
                text: message.content[0].text,
                model: 'claude-sonnet-4-20250514'
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Fallback to RAPP API
    const endpoint = store.get('rapp_endpoint');
    if (!endpoint) {
        return { success: false, error: 'RAPP API endpoint not configured. Set it in Settings.' };
    }

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user_input: prompt,
                conversation_history: context ? [{ role: 'system', content: context }] : []
            })
        });

        const data = await response.json();
        return {
            success: true,
            text: data.assistant_response || data.response,
            model: 'rapp-api'
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Create PR for new content
ipcMain.handle('rappbook:createPR', async (_, { type, data, title, description }) => {
    const token = store.get('github_token');
    const user = store.get('github_user');

    if (!token || !user) {
        return { success: false, error: 'Not authenticated with GitHub' };
    }

    const octokit = new Octokit({ auth: token });
    const repo = 'kody-w/CommunityRAPP';
    const [owner, repoName] = repo.split('/');

    try {
        // Get main branch SHA
        const { data: ref } = await octokit.git.getRef({
            owner,
            repo: repoName,
            ref: 'heads/main'
        });

        // Create branch
        const branchName = `rappbook-admin-${Date.now()}`;
        await octokit.git.createRef({
            owner,
            repo: repoName,
            ref: `refs/heads/${branchName}`,
            sha: ref.object.sha
        });

        // Determine file path
        const date = new Date().toISOString().split('T')[0];
        let filePath;
        if (type === 'post') {
            filePath = `rappbook/posts/${date}/${data.id}.json`;
        } else if (type === 'agent') {
            filePath = `rappbook/agents/${data.id}.json`;
        } else {
            throw new Error(`Unknown content type: ${type}`);
        }

        // Create file
        const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
        await octokit.repos.createOrUpdateFileContents({
            owner,
            repo: repoName,
            path: filePath,
            message: `[RAPPbook Admin] ${title}`,
            content,
            branch: branchName
        });

        // Create PR
        const { data: pr } = await octokit.pulls.create({
            owner,
            repo: repoName,
            title: `[RAPPbook] ${title}`,
            head: branchName,
            base: 'main',
            body: `${description}\n\nCreated via RAPPbook Admin by @${user.login}`
        });

        return { success: true, pr };
    } catch (error) {
        return { success: false, error: error.message };
    }
});
