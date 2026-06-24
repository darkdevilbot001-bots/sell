const socket = io();

// State
let botData = [];
let audioFiles = [];
let config = {};

// Elements
const botGrid = document.getElementById('bot-grid');
const audioList = document.getElementById('audio-list');
const logConsole = document.getElementById('log-console');
const cpuBar = document.getElementById('cpu-bar');
const memBar = document.getElementById('mem-bar');
const botCount = document.getElementById('bot-count');
const globalStatus = document.getElementById('global-status');

// Tab Switching
document.querySelectorAll('.nav-links li[data-tab]').forEach(li => {
    li.addEventListener('click', () => {
        const tab = li.getAttribute('data-tab');
        document.querySelectorAll('.nav-links li').forEach(l => l.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        li.classList.add('active');
        document.getElementById(`tab-${tab}`).classList.add('active');
    });
});

// Playback Controls
document.getElementById('forward-btn').addEventListener('click', () => socket.emit('seek', 15));
document.getElementById('rewind-btn').addEventListener('click', () => socket.emit('seek', -15));
document.getElementById('stop-all-btn').addEventListener('click', () => {
    socket.emit('stop');
    showToast('Stopping all playback...');
});

// Socket: Bot Status Update
socket.on('botStatus', (data) => {
    botData = data.bots || [];
    config = data.config || {};

    const trackName = config.currentAudio || 'No Audio Playing';
    document.getElementById('current-track-name').innerText = trackName;

    updateBotGrid();
    updateConfigUI();
    if (data.usage) updateStats(data.usage);

    const onlineCount = botData.filter(b => b.isOnline).length;
    botCount.innerText = `(${onlineCount}/${botData.length})`;

    if (onlineCount > 0) {
        globalStatus.innerText = 'ONLINE';
        globalStatus.className = 'status-badge online';
    } else {
        globalStatus.innerText = 'OFFLINE';
        globalStatus.className = 'status-badge offline';
    }
});

// Bot Grid
function updateBotGrid() {
    if (!botGrid) return;
    botGrid.innerHTML = botData.map(bot => `
        <div class="bot-card">
            <div class="bot-header">
                <span class="bot-id">#${bot.id + 1}</span>
                <span class="status-badge ${bot.isOnline ? 'online' : 'offline'}">${bot.isOnline ? 'ACTIVE' : 'OFFLINE'}</span>
            </div>
            <div class="bot-name">${bot.tag || `Bot ${bot.id + 1}`}</div>
            <div class="bot-meta">
                <p><i class="fas ${bot.isJoined ? 'fa-link' : 'fa-link-slash'}"></i> ${bot.isJoined ? 'Connected to VC' : 'Idle'}</p>
                <p><i class="fas fa-play"></i> ${bot.status || 'idle'}</p>
            </div>
        </div>
    `).join('');
}

// System Stats
function updateStats(usage) {
    if (!usage) return;
    const memVal = Math.min(100, Math.floor((usage.mem.rss / (1024 * 1024 * 512)) * 100));
    if (cpuBar) cpuBar.style.width = `${Math.min(100, memVal * 0.3)}%`;
    if (memBar) memBar.style.width = `${memVal}%`;
}

// Config Controls
function updateConfigUI() {
    const volEl = document.getElementById('range-vol');
    const bassEl = document.getElementById('range-bass');
    const speedEl = document.getElementById('range-speed');
    const loopBtn = document.getElementById('toggle-loop');

    if (volEl) { volEl.value = config.volume || 100; document.getElementById('vol-val').innerText = `${config.volume || 100}%`; }
    if (bassEl) { bassEl.value = config.bass || 0; document.getElementById('bass-val').innerText = `${config.bass || 0}dB`; }
    if (speedEl) { speedEl.value = config.speed || 1.0; document.getElementById('speed-val').innerText = `${config.speed || 1.0}x`; }
    if (loopBtn) { config.loop ? loopBtn.classList.add('on') : loopBtn.classList.remove('on'); }
}

['vol', 'bass', 'speed'].forEach(id => {
    const el = document.getElementById(`range-${id}`);
    if (!el) return;
    el.addEventListener('change', () => {
        const val = id === 'speed' ? parseFloat(el.value) : parseInt(el.value);
        config[id === 'vol' ? 'volume' : id] = val;
        socket.emit('updateConfig', config);
        showToast(`Updated ${id}: ${val}`);
    });
    el.addEventListener('input', () => {
        const display = document.getElementById(`${id}-val`);
        if (display) display.innerText = `${el.value}${id === 'speed' ? 'x' : id === 'vol' ? '%' : 'dB'}`;
    });
});

const loopToggle = document.getElementById('toggle-loop');
if (loopToggle) {
    loopToggle.addEventListener('click', () => {
        config.loop = !config.loop;
        socket.emit('updateConfig', config);
        showToast(`Loop ${config.loop ? 'Enabled' : 'Disabled'}`);
    });
}

// VC Join / Leave
document.getElementById('join-btn').addEventListener('click', () => {
    const vcId = document.getElementById('vc-input').value.trim();
    if (!vcId) { showToast('Please paste a Channel ID first'); return; }
    socket.emit('joinVC', vcId);
    showToast(`Ordering all bots to join channel...`);
});

document.getElementById('leave-btn').addEventListener('click', () => {
    socket.emit('disconnectAll');
    showToast('Disconnecting all bots...');
});

// Audio Library
async function loadAudio() {
    try {
        const res = await fetch('/api/audio');
        if (!res.ok) return;
        audioFiles = await res.json();
        if (!audioList) return;
        if (audioFiles.length === 0) {
            audioList.innerHTML = '<p style="color: #666; padding: 20px;">No audio files uploaded yet.</p>';
            return;
        }
        audioList.innerHTML = audioFiles.map(file => `
            <div class="audio-item">
                <div class="audio-info">
                    <i class="fas fa-file-audio"></i>
                    <span>${file}</span>
                </div>
                <div class="audio-actions">
                    <button class="btn-primary btn-small" onclick="playAudio('${file}')">
                        <i class="fas fa-play"></i> PLAY ALL
                    </button>
                    <button class="btn-danger btn-small" onclick="deleteAudio('${file}')">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
        `).join('');
    } catch(e) {
        console.error('Failed to load audio:', e);
    }
}

window.playAudio = (file) => {
    socket.emit('play', file);
    showToast(`Playing: ${file}`);
};

window.deleteAudio = async (file) => {
    if (!confirm(`Delete ${file}?`)) return;
    await fetch(`/api/audio/${file}`, { method: 'DELETE' });
    loadAudio();
    showToast('File deleted');
};

// File Upload
const uploadInput = document.getElementById('audio-upload');
if (uploadInput) {
    uploadInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const formData = new FormData();
        formData.append('audio', file);
        showToast('Uploading...');
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        if (res.ok) {
            loadAudio();
            showToast('Upload complete!');
        } else {
            showToast('Upload failed');
        }
        uploadInput.value = '';
    });
}

// Logs
socket.on('log', (data) => {
    if (!logConsole) return;
    const div = document.createElement('div');
    div.className = data.type || 'info';
    div.innerText = data.message;
    logConsole.appendChild(div);
    if (logConsole.children.length > 200) logConsole.removeChild(logConsole.firstChild);
    logConsole.scrollTop = logConsole.scrollHeight;
});

const clearLogsBtn = document.getElementById('clear-logs');
if (clearLogsBtn) clearLogsBtn.addEventListener('click', () => { if (logConsole) logConsole.innerHTML = ''; });

// Toast Notifications
function showToast(msg) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.innerText = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3000);
}

// User Management
async function checkRole() {
    try {
        const res = await fetch('/api/me');
        if (!res.ok) return;
        const user = await res.json();
        if (user.role === 'admin') {
            const userTabLink = document.getElementById('tab-link-users');
            if (userTabLink) userTabLink.style.display = 'flex';
            loadUsers();
        }
    } catch(e) {}
}

async function loadUsers() {
    try {
        const res = await fetch('/api/users');
        if (!res.ok) return;
        const users = await res.json();
        const list = document.getElementById('user-list');
        if (!list) return;
        list.innerHTML = users.map(u => `
            <div class="audio-item">
                <div class="audio-info">
                    <i class="fas fa-user-shield"></i>
                    <span>${u.username} (${u.role})</span>
                </div>
                <div class="audio-actions">
                    ${u.username !== 'veera' ? `
                        <button class="btn-danger btn-small" onclick="deleteUser('${u.username}')">
                            <i class="fas fa-user-minus"></i>
                        </button>
                    ` : '<span style="color: #5865F2; font-size: 0.75rem;">ADMIN</span>'}
                </div>
            </div>
        `).join('');
    } catch(e) {}
}

const addUserBtn = document.getElementById('add-user-btn');
if (addUserBtn) {
    addUserBtn.addEventListener('click', async () => {
        const username = document.getElementById('new-username').value.trim();
        const password = document.getElementById('new-password').value.trim();
        if (!username || !password) { showToast('Please fill all fields'); return; }
        const res = await fetch('/api/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, role: 'user' })
        });
        const result = await res.json();
        if (res.ok) {
            showToast(`User ${username} added!`);
            document.getElementById('new-username').value = '';
            document.getElementById('new-password').value = '';
            loadUsers();
        } else {
            showToast(result.error || 'Error adding user');
        }
    });
}

window.deleteUser = async (username) => {
    if (!confirm(`Remove user ${username}?`)) return;
    await fetch(`/api/users/${username}`, { method: 'DELETE' });
    loadUsers();
    showToast('User removed');
};

// Initialize
loadAudio();
checkRole();
setInterval(loadAudio, 15000);
