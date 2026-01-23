const { execSync } = require('child_process');
const path = require('path');
const os = require('os');

const DB_PATH = path.join(os.homedir(), 'Library/Application Support/Antigravity/User/globalStorage/state.vscdb');

function getAuthStatus() {
    try {
        // Use sqlite3 CLI to extract the value for key 'antigravityAuthStatus'
        // We use -json to get it in a format we can parse if the value is JSON string inside DB
        // Actually, the value is stored as a string in ItemTable.
        const cmd = `sqlite3 "${DB_PATH}" "SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus';"`;
        const output = execSync(cmd).toString().trim();

        if (!output) {
            throw new Error('No auth status found in database');
        }

        const authData = JSON.parse(output);
        return authData;
    } catch (error) {
        console.error('Error reading Antigravity database:', error.message);
        return null;
    }
}

module.exports = { getAuthStatus };

if (require.main === module) {
    const status = getAuthStatus();
    if (status) {
        console.log('Token extracted successfully for:', status.email);
        console.log('Token (prefix):', status.apiKey ? status.apiKey.substring(0, 10) + '...' : 'NONE');
    }
}
