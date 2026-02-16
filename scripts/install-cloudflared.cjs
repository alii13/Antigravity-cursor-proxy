const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const { platform, arch } = process;

const BINARY_NAME = 'cloudflared';
const TARGET_DIR = path.join(__dirname, '..');
const TARGET_PATH = path.join(TARGET_DIR, BINARY_NAME);

// Check if already installed
if (fs.existsSync(TARGET_PATH)) {
    console.log('✅ cloudflared binary already exists. Skipping download.');
    process.exit(0);
}

const getDownloadUrl = () => {
    // Map Node architecture to Cloudflare's naming
    const archMap = {
        'x64': 'amd64',
        'arm64': 'arm64',
        'ia32': '386'
    };

    const mappedArch = archMap[arch];
    if (!mappedArch) {
        console.error(`❌ Unsupported architecture: ${arch}`);
        process.exit(1);
    }

    if (platform === 'darwin') {
        return `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${mappedArch}.tgz`;
    } else if (platform === 'linux') {
        return `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${mappedArch}`;
    } else if (platform === 'win32') {
        return `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-${mappedArch}.exe`;
    } else {
        console.error(`❌ Unsupported platform: ${platform}`);
        process.exit(1);
    }
};

const downloadFile = (url, dest) => {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (response) => {
            if (response.statusCode === 302 || response.statusCode === 301) {
                downloadFile(response.headers.location, dest).then(resolve).catch(reject);
                return;
            }
            if (response.statusCode !== 200) {
                reject(new Error(`Failed to download: ${response.statusCode}`));
                return;
            }
            response.pipe(file);
            file.on('finish', () => {
                file.close(resolve);
            });
        }).on('error', (err) => {
            fs.unlink(dest, () => { });
            reject(err);
        });
    });
};

const install = async () => {
    const url = getDownloadUrl();
    console.log(`⬇️ Downloading cloudflared from: ${url}`);

    try {
        if (url.endsWith('.tgz')) {
            const tarPath = path.join(TARGET_DIR, 'cloudflared.tgz');
            await downloadFile(url, tarPath);
            console.log('📦 Extracting...');
            execSync(`tar -xzf ${tarPath} -C ${TARGET_DIR}`);
            fs.unlinkSync(tarPath);
        } else {
            await downloadFile(url, TARGET_PATH);
        }

        // Set executable permissions (Unix)
        if (platform !== 'win32') {
            fs.chmodSync(TARGET_PATH, 0o755);
        }

        console.log('✅ cloudflared installed successfully!');
    } catch (error) {
        console.error('❌ Installation failed:', error.message);
        // Clean up partial files
        if (fs.existsSync(TARGET_PATH)) fs.unlinkSync(TARGET_PATH);
        process.exit(1);
    }
};

install();
