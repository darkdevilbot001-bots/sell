// Socket.IO Client
const socket = io();
let currentBots = [];
let audioFiles = [];
let isAuthenticated = false;

// Initialize the application
document.addEventListener('DOMContentLoaded', () => {
    initializeApp();
});

function initializeApp() {
    checkAuthStatus();
    setupSocketListeners();
    setupEventListeners();
    loadAudioFiles();
}

// Authentication
function checkAuthStatus() {
    fetch('/api/auth/status')
        .then(res => res.json())
        .then(data => {
            if (data.authenticated) {
                window.location.href = '/';
            }
        });
}

function setupEventListeners() {
    // Logout
    document.getElementById('logoutBtn').addEventListener('click', () => {
        fetch('/api/logout', { method: 'POST' })
            .then(() => window.location.reload());
    });

    // Upload audio
    document.getElementById('uploadBtn').addEventListener('click', uploadAudio);
    document.getElementById('audioUpload').addEventListener('change', () => {});

    // Add Bot Modal
    document.getElementById('addBotBtn').addEventListener('click', () => {
        document.getElementById('addBotModal').classList.add('show');
    });

    document.getElementById('closeModal').addEventListener('click', () => {
        document.getElementById('addBotModal').classList.remove('show');
    });

    document.getElementById('addBotForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const token = document.getElementById('botToken').value;
        addBot(token);
    });
}

// Socket.IO Event Listeners
function setupSocketListeners() {
    socket.on('connect', () => {
        console.log('Connected to server');
        loadBots();
    });

    socket.on('systemStats', (stats) => {
        updateSystemStats(stats);
    });

    socket.on('allBotsUpdate', (bots) => {
        currentBots = bots;
        updateBotsGrid(bots);
    });

    socket.on('botUpdate', (botData) => {
        updateBotCard(botData);
    });

    socket.on('newLog', (log) => {
        addLogEntry(log);
    });

    socket.on('operationResult', (result) => {
        showNotification(result.message, result.success ? 'success' : 'error');
    });
}

// Load bots data
function loadBots() {
    fetch('/api/bots')
        .then(res => res.json())
        .then(bots => {
            currentBots = bots;
            updateBotsGrid(bots);
        });
}

// Update system stats
function updateSystemStats(stats) {
    document.getElementById('cpuUsage').textContent = stats.cpu + ' ms';
    document.getElementById('memoryUsage').textContent = formatBytes(stats.memory);
    document.getElementById('uptime').textContent = formatUptime(stats.uptime);
    
    const online = currentBots.filter(b => b.status === 'online' || b.status === 'in-voice').length;
    document.getElementById('onlineBots').textContent = `${online}/30`;
}

// Format helpers
function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m ${secs}s`;
}

// Update bots grid
function updateBotsGrid(bots) {
    const botsGrid = document.getElementById('botsGrid');
    botsGrid.innerHTML = '';

    bots.forEach(bot => {
        const card = createBotCard(bot);
        botsGrid.appendChild(card);
    });
}

// Create bot card HTML
function createBotCard(bot) {
    const card = document.createElement('div');
    card.className = `bot-card ${bot.status}`;
    card.id = `bot-${bot.id}`;

    const hasAvatar = bot.avatar ? `<img src="${bot.avatar}" alt="${bot.username}">` : bot.username.charAt(0);
    const statusClass = bot.status === 'online' ? 'status-online' : 
                       bot.status === 'in-voice' ? 'status-in-voice' : 'status-offline';

    card.innerHTML = `
        <div class="bot-header">
            <div class="bot-avatar">${hasAvatar}</div>
            <div class="bot-info">
                <h3>${bot.username || `Bot ${bot.id}`}</h3>
                <span class="bot-id">ID: ${bot.id}</span>
                <span class="status-indicator ${statusClass}"></span>
                <span>${bot.status}</span>
            </div>
        </div>
        ${bot.status !== 'offline' ? createControlsHTML(bot) : ''}
    `;

    // If not offline, skip controls creation since the HTML is already in the template
    if (bot.status === 'offline') {
        const controlsDiv = card.querySelector('.bot-controls');
        if (controlsDiv) controlsDiv.remove();
    } else {
        // Setup event listeners for controls
        setupBotControls(card, bot.id);
    }

    return card;
}

function createControlsHTML(bot) {
    return `
        <div class="bot-controls">
            <div class="control-group">
                <span>Now Playing: ${bot.currentAudio || 'None'}</span>
            </div>
            
            <div class="control-group">
                <button class="btn btn-success btn-small" onclick="joinChannel(${bot.id})">Join VC</button>
                <button class="btn btn-danger btn-small" onclick="leaveChannel(${bot.id})">Leave VC</button>
                <button class="btn btn-primary btn-small" onclick="togglePlay(${bot.id})">
                    ${bot.isPaused ? '▶ Play' : '⏸ Pause'}
                </button>
                <button class="btn btn-danger btn-small" onclick="stopPlayback(${bot.id})">⏹ Stop</button>
                <button class="btn btn-secondary btn-small" onclick="toggleLoop(${bot.id})">
                    🔁 ${bot.isLooping ? 'ON' : 'OFF'}
                </button>
            </div>

            <div class="control-group">
                <label>Volume:</label>
                <input type="range" min="0" max="200" value="${bot.volume}" 
                       oninput="setVolume(${bot.id}, this.value)">
                <span class="value-display">${bot.volume}%</span>
            </div>

            <div class="control-group">
                <label>Bass Boost:</label>
                <input type="range" min="0" max="100" value="${bot.bassBoost}" 
                       oninput="setBassBoost(${bot.id}, this.value)">
                <span class="value-display">${bot.bassBoost}%</span>
            </div>

            <div class="control-group">
                <label>Speed:</label>
                <input type="range" min="0.5" max="2.0" step="0.1" value="${bot.playbackSpeed}" 
                       oninput="setPlaybackSpeed(${bot.id}, this.value)">
                <span class="value-display">${bot.playbackSpeed}x</span>
            </div>

            <div class="control-group">
                <label>Guild ID:</label>
                <input type="text" class="guild-id-input" placeholder="Guild ID" value="${bot.guildId || ''}">
            </div>

            <div class="control-group">
                <label>Channel ID:</label>
                <input type="text" class="channel-id-input" placeholder="Channel ID" value="${bot.currentChannel || ''}">
            </div>

            <div class="audio-library-mini">
                <select class="audio-select">
                    <option value="">Select Audio...</option>
                    ${audioFiles.map(f => `<option value="${f.filename}">${f.originalname}</option>`).join('')}
                </select>
                <button class="btn btn-primary btn-small" onclick="playAudio(${bot.id})">Play</button>
            </div>
        </div>
    `;
}

function setupBotControls(card, botId) {
    // Update value displays when sliders change
    const sliders = card.querySelectorAll('input[type="range"]');
    sliders.forEach(slider => {
        slider.addEventListener('input', (e) => {
            const valueDisplay = e.target.nextElementSibling;
            if (valueDisplay && valueDisplay.classList.contains('value-display')) {
                valueDisplay.textContent = e.target.value + (e.target.step === '0.1' ? 'x' : '%');
            }
        });
    });
}

// Update single bot card
function updateBotCard(botData) {
    const card = document.getElementById(`bot-${botData.id}`);
    if (card) {
        const newCard = createBotCard(botData);
        card.replaceWith(newCard);
    }
}

// Bot control functions
function joinChannel(botId) {
    const card = document.getElementById(`bot-${botId}`);
    const guildId = card.querySelector('.guild-id-input')?.value;
    const channelId = card.querySelector('.channel-id-input')?.value;

    if (!guildId || !channelId) {
        showNotification('Please enter Guild ID and Channel ID', 'error');
        return;
    }

    socket.emit('joinChannel', { botId, guildId, channelId });
}

function leaveChannel(botId) {
    socket.emit('leaveChannel', { botId });
}

function playAudio(botId) {
    const card = document.getElementById(`bot-${botId}`);
    const filename = card.querySelector('.audio-select')?.value;

    if (!filename) {
        showNotification('Please select an audio file', 'error');
        return;
    }

    socket.emit('playAudio', { botId, filename });
}

function togglePlay(botId) {
    const bot = currentBots.find(b => b.id === botId);
    if (bot && bot.isPaused) {
        socket.emit('resumePlayback', { botId });
    } else {
        socket.emit('pausePlayback', { botId });
    }
}

function stopPlayback(botId) {
    socket.emit('stopPlayback', { botId });
}

function setVolume(botId, value) {
    socket.emit('setVolume', { botId, volume: parseInt(value) });
}

function setBassBoost(botId, value) {
    socket.emit('setBassBoost', { botId, level: parseInt(value) });
}

function setPlaybackSpeed(botId, value) {
    socket.emit('setPlaybackSpeed', { botId, speed: parseFloat(value) });
}

function toggleLoop(botId) {
    socket.emit('toggleLoop', { botId });
}

// Audio file management
function loadAudioFiles() {
    fetch('/api/audio-files')
        .then(res => res.json())
        .then(files => {
            audioFiles = files;
            updateAudioLibrary(files);
        })
        .catch(err => {
            console.error('Failed to load audio files:', err);
            // Load from DB or server files
            loadAudioFromServer();
        });
}

function loadAudioFromServer() {
    // Fetch from server-side storage
    fetch('/api/audio-files')
        .then(res => res.json())
        .then(files => {
            audioFiles = files;
            updateAudioLibrary(files);
        });
}

function updateAudioLibrary(files) {
    const audioList = document.getElementById('audioList');
    audioList.innerHTML = '';

    files.forEach(file => {
        const item = document.createElement('div');
        item.className = 'audio-item';
        item.innerHTML = `
            <div class="audio-info">
                <div class="audio-name" title="${file.originalname || file.filename}">
                    ${file.originalname || file.filename}
                </div>
                <div class="audio-size">${formatBytes(file.size)}</div>
            </div>
            <div class="audio-actions">
                <button class="btn btn-primary btn-small" onclick="playAudioFile('${file.filename}')">Play</button>
                <button class="btn btn-danger btn-small" onclick="deleteAudioFile('${file.filename}')">Delete</button>
            </div>
        `;
        audioList.appendChild(item);
    });
}

async function uploadAudio() {
    const fileInput = document.getElementById('audioUpload');
    const file = fileInput.files[0];

    if (!file) {
        showNotification('Please select a file', 'error');
        return;
    }

    const formData = new FormData();
    formData.append('audio', file);

    try {
        const response = await fetch('/api/audio-files/upload', {
            method: 'POST',
            body: formData
        });

        const result = await response.json();
        
        if (result.success) {
            showNotification('Audio uploaded successfully', 'success');
            fileInput.value = '';
            loadAudioFiles();
        } else {
            showNotification('Upload failed: ' + result.error, 'error');
        }
    } catch (error) {
        showNotification('Upload failed: ' + error.message, 'error');
    }
}

function playAudioFile(filename) {
    // Select in first available bot
    const onlineBot = currentBots.find(b => b.status === 'online' || b.status === 'in-voice');
    if (onlineBot) {
        socket.emit('playAudio', { botId: onlineBot.id, filename });
    } else {
        showNotification('No online bots available', 'error');
    }
}

function deleteAudioFile(filename) {
    if (!confirm('Are you sure you want to delete this file?')) return;

    fetch(`/api/audio-files/${filename}`, {
        method: 'DELETE'
    })
    .then(res => res.json())
    .then(result => {
        if (result.success) {
            showNotification('File deleted', 'success');
            loadAudioFiles();
        } else {
            showNotification('Delete failed', 'error');
        }
    });
}

// Add bot functionality
function addBot(token) {
    fetch('/api/bots/add', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ token })
    })
    .then(res => res.json())
    .then(result => {
        if (result.success) {
            showNotification('Bot added successfully', 'success');
            document.getElementById('addBotModal').classList.remove('show');
            document.getElementById('botToken').value = '';
            loadBots();
        } else {
            showNotification('Failed to add bot: ' + result.error, 'error');
        }
    })
    .catch(err => {
        showNotification('Error adding bot', 'error');
    });
}

// Log management
function addLogEntry(log) {
    const logContainer = document.getElementById('logContainer');
    const entry = document.createElement('div');
    entry.className = `log-entry ${log.type}`;
    
    const time = new Date(log.timestamp).toLocaleTimeString();
    entry.innerHTML = `
        <span class="log-timestamp">[${time}]</span>
        <span>Bot ${log.botId}: ${log.message}</span>
    `;

    logContainer.appendChild(entry);
    logContainer.scrollTop = logContainer.scrollHeight;

    // Keep only last 100 logs
    while (logContainer.children.length > 100) {
        logContainer.removeChild(logContainer.firstChild);
    }
}

// Notification system
function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        padding: 15px 25px;
        background-color: ${type === 'success' ? '#57F287' : type === 'error' ? '#ED4245' : '#5865F2'};
        color: white;
        border-radius: 5px;
        z-index: 2000;
        animation: slideIn 0.3s ease;
    `;
    document.body.appendChild(notification);

    setTimeout(() => {
        notification.remove();
    }, 3000);
}

// Add CSS animation for notifications
const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn {
        from {
            transform: translateX(400px);
            opacity: 0;
        }
        to {
            transform: translateX(0);
            opacity: 1;
        }
    }
`;
document.head.appendChild(style);

// Make functions global for onclick handlers
window.joinChannel = joinChannel;
window.leaveChannel = leaveChannel;
window.playAudio = playAudio;
window.stopPlayback = stopPlayback;
window.togglePlay = togglePlay;
window.setVolume = setVolume;
window.setBassBoost = setBassBoost;
window.setPlaybackSpeed = setPlaybackSpeed;
window.toggleLoop = toggleLoop;
window.playAudioFile = playAudioFile;
window.deleteAudioFile = deleteAudioFile;