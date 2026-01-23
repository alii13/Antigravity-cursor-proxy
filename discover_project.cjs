const { getAuthStatus } = require('./db_helper.cjs');
const https = require('https');

async function discoverProject(token) {
    const endpoints = [
        'https://daily-cloudcode-pa.googleapis.com',
        'https://cloudcode-pa.googleapis.com'
    ];

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

    const payload = {
        metadata: {
            ideType: 'IDE_UNSPECIFIED',
            platform: 'PLATFORM_UNSPECIFIED',
            pluginType: 'GEMINI'
        }
    };

    for (const endpoint of endpoints) {
        console.log(`Trying ${endpoint}...`);
        try {
            const data = await new Promise((resolve, reject) => {
                const url = `${endpoint}/v1internal:loadCodeAssist`;
                const req = https.request(url, {
                    method: 'POST',
                    headers: headers
                }, (res) => {
                    let body = '';
                    res.on('data', chunk => body += chunk);
                    res.on('end', () => {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            resolve(JSON.parse(body));
                        } else {
                            reject(new Error(`Status ${res.statusCode}: ${body}`));
                        }
                    });
                });
                req.on('error', reject);
                req.write(JSON.stringify(payload));
                req.end();
            });

            if (data.cloudaicompanionProject) {
                const project = typeof data.cloudaicompanionProject === 'string'
                    ? data.cloudaicompanionProject
                    : data.cloudaicompanionProject.id;
                console.log('Discovered project:', project);
                return project;
            }
        } catch (error) {
            console.error(`Error with ${endpoint}:`, error.message);
        }
    }

    console.log('Fallback to default project ID');
    return 'rising-fact-p41fc';
}

if (require.main === module) {
    const status = getAuthStatus();
    if (!status || !status.apiKey) {
        console.error('No token found');
        process.exit(1);
    }
    discoverProject(status.apiKey).then(project => {
        console.log('Resulting Project ID:', project);
    });
}

module.exports = { discoverProject };
