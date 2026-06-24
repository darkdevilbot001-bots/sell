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
    setupSidebarNavigation();
    loadAudioFiles();
    loadUsers();
}

// User Management
function loadUsers() {
    fetch('/api/users')
        .then(res => {
            if (!res.ok) throw new Error('Unauthorized');
            return res.json();
        })
        .then(users => updateUsersList(users))
        .catch(err => console.log('Not authenticated to load users yet.'));
}

function updateUsersList(users) {
    const list = document.getElementById('usersList');
    if (!list) return;
    list.innerHTML = '';
    users.forEach(user => {
        list.innerHTML += `
            <div class="audio-item">
                <div class="audio-info">
                    <div class="audio-name">${user.username}</div>
                    <div class="audio-size">Role: ${user.role}</div>
                </div>
                <div class="audio-actions">
                    ${user.username !== 'veera' ? `<button class="btn btn-danger" onclick="deleteUser('${user.username}')"><i class="fa-solid fa-trash"></i></button>` : ''}
                </div>
            </div>
        `;
    });
}

async function deleteUser(username) {
    if (!confirm(`Delete user ${username}?`)) return;
    try {
        const res = await fetch(`/api/users/${username}`, { method: 'DELETE' });
        const result = await res.json();
        if (result.success) loadUsers();
        else alert(result.error);
    } catch (e) {
        alert(e.message);
    }
}

// Authentication
function checkAuthStatus() {
    fetch('/api/auth/status')
        .then(res => res.json())
        .then(data => {
            const isLoginPage = window.location.pathname.endsWith('login.html');
            if (data.authenticated && isLoginPage) {
                window.location.href = '/';
            } else if (!data.authenticated && !isLoginPage) {
                window.location.href = '/login.html';
            }
        });
}

// Sidebar Navigation Logic
function setupSidebarNavigation() {
    const navItems = document.querySelectorAll('.nav-item[data-target]');
    const views = document.querySelectorAll('.view');

    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            if (item.classList.contains('placeholder')) return; // Ignore placeholders

            // Remove active from all nav items and views
            navItems.forEach(nav => nav.classList.remove('active'));
            views.forEach(view => view.classList.remove('active'));

            // Add active to clicked item and corresponding view
            item.classList.add('active');
            const targetId = item.getAttribute('data-target');
            document.getElementById(targetId).classList.add('active');
        });
    });
}

function setupEventListeners() {
    // Logout
    document.getElementById('logoutBtn').addEventListener('click', (e) => {
        e.preventDefault();
        fetch('/api/logout', { method: 'POST' })
            .then(() => window.location.reload());
    });

    // Upload audio
    document.getElementById('uploadBtn').addEventListener('click', uploadAudio);

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

    // User Form
    const addUserForm = document.getElementById('addUserForm');
    if (addUserForm) {
        addUserForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const username = document.getElementById('newUsername').value;
            const password = document.getElementById('newPassword').value;
            try {
                const res = await fetch('/api/users', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                const result = await res.json();
                if (result.success) {
                    addUserForm.reset();
                    loadUsers();
                } else {
                    alert(result.error);
                }
            } catch (err) {
                alert(err.message);
            }
        });
    }

    // Global Actions
    const joinAllHandler = () => {
        const channelId = document.getElementById('globalChannelId')?.value || document.getElementById('globalControlChannelId')?.value;
        if (!channelId) {
            alert('Please enter a channel ID');
            return;
        }
        socket.emit('joinAllChannels', { guildId: 'global', channelId: channelId });
    };

    const leaveAllHandler = () => {
        socket.emit('leaveAllChannels');
    };

    const playAllHandler = () => {
        const select = document.getElementById('globalAudioSelect');
        if (!select || !select.value) {
            alert('Please select an audio file first');
            return;
        }
        socket.emit('playAudioGlobal', { filename: select.value });
    };

    const stopAllHandler = () => {
        socket.emit('stopAudioGlobal');
    };

    // Bind handlers to multiple buttons if they exist
    document.getElementById('globalJoinBtn')?.addEventListener('click', joinAllHandler);
    document.getElementById('btnJoinAll')?.addEventListener('click', joinAllHandler);

    document.getElementById('globalLeaveBtn')?.addEventListener('click', leaveAllHandler);
    document.getElementById('btnLeaveAll')?.addEventListener('click', leaveAllHandler);

    document.getElementById('btnPlayAll')?.addEventListener('click', playAllHandler);

    document.getElementById('globalStopBtn')?.addEventListener('click', stopAllHandler);
    document.getElementById('btnStopAll')?.addEventListener('click', stopAllHandler);
}

// Socket.IO Event Listeners
function setupSocketListeners() {
    socket.on('connect', () => {
        console.log('Connected to server');
        loadBots();
        document.getElementById('globalStatus').className = 'status-badge online';
        document.getElementById('globalStatus').textContent = 'ONLINE';
    });
    
    socket.on('disconnect', () => {
        document.getElementById('globalStatus').className = 'status-badge offline';
        document.getElementById('globalStatus').textContent = 'OFFLINE';
    });

    socket.on('systemStats', (stats) => {
        updateSystemStats(stats);
    });

    socket.on('allBotsUpdate', (bots) => {
        currentBots = bots;
        updateBotsGrid(bots);
        updateGlobalPlayer();
    });

    socket.on('botUpdate', (botData) => {
        updateBotCard(botData);
        // also update the global list reference
        const idx = currentBots.findIndex(b => b.id === botData.id);
        if(idx !== -1) currentBots[idx] = botData;
        updateGlobalPlayer();
    });

    socket.on('newLog', (log) => {
        addLogEntry(log);
    });

    socket.on('operationResult', (result) => {
        // use a simple alert or custom toast if implemented
        if(!result.success) {
            alert(result.message);
        }
    });
}

// Load bots data
function loadBots() {
    fetch('/api/bots')
        .then(res => res.json())
        .then(bots => {
            if (!Array.isArray(bots)) {
                console.error("Failed to load bots:", bots);
                return;
            }
            currentBots = bots;
            updateBotsGrid(bots);
            updateGlobalPlayer();
        })
        .catch(err => console.error("Error loading bots:", err));
}

// Update system stats
function updateSystemStats(stats) {
    // stats.cpu is in ms, let's max it at 100 for percentage
    const cpuPercent = Math.min(parseFloat(stats.cpu) || 0, 100);
    document.getElementById('cpuBar').style.width = cpuPercent + '%';

    // memory stats.memory is bytes. Max arbitrary 1GB for percentage
    const memPercent = Math.min((stats.memory / (1024*1024*1024)) * 100, 100);
    document.getElementById('memBar').style.width = memPercent + '%';
    
    const online = currentBots.filter(b => b.status === 'online' || b.status === 'in-voice').length;
    document.getElementById('onlineBotsCount').textContent = online;
}

// Format helpers
function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

function updateGlobalPlayer() {
    const playingBot = currentBots.find(b => b.currentAudio);
    const globalNowPlaying = document.getElementById('globalNowPlaying');
    if (playingBot && playingBot.currentAudio) {
        globalNowPlaying.textContent = playingBot.currentAudio;
    } else {
        globalNowPlaying.textContent = "NO TRACK SELECTED";
    }
}

// Update bots grid
function updateBotsGrid(bots) {
    const botsGrid = document.getElementById('botsGrid');
    botsGrid.innerHTML = '';

    bots.forEach((bot, index) => {
        const card = createBotCard(bot, index + 1);
        botsGrid.appendChild(card);
    });
}

// Create bot card HTML
function createBotCard(bot, index) {
    const card = document.createElement('div');
    card.className = 'bot-card';
    if(bot.status === 'in-voice') card.classList.add('selected'); // Highlight playing bot
    card.id = `bot-${bot.id}`;

    const isConnected = bot.status === 'in-voice' || bot.status === 'online';
    const activeClass = isConnected ? 'active' : 'offline';
    const activeText = isConnected ? 'ACTIVE' : 'OFFLINE';

    // Stylize the name if empty
    let displayUsername = bot.username || `Bot ${bot.id}`;
    if(bot.username && bot.username.length > 0) {
        // mimic the image style if you want, but using actual username is better
    } else {
        displayUsername = `† ‖‖ВЛИ СĐМ‖‖✈#${Math.floor(1000 + Math.random() * 9000)}`;
    }

    card.innerHTML = `
        <div class="bot-card-top">
            <span class="bot-index">#${index}</span>
            <span class="bot-status-pill ${activeClass}">${activeText}</span>
        </div>
        <div class="bot-name">${displayUsername}</div>
        <div class="bot-info-line">
            <i class="fa-solid fa-link"></i>
            ${bot.status === 'in-voice' ? 'Connected to VC' : 'Disconnected'}
        </div>
        <div class="bot-info-line">
            <i class="fa-solid ${bot.currentAudio ? 'fa-play' : 'fa-pause'}"></i>
            ${bot.currentAudio ? bot.currentAudio : 'idle'}
        </div>
    `;

    // Make the whole card clickable to connect/disconnect for simplicity
    card.addEventListener('click', () => {
        if(bot.status === 'in-voice') {
            socket.emit('leaveChannel', { botId: bot.id });
        } else {
            // Need a channel ID to join. Using the global one if present
            const globalChannel = document.getElementById('globalChannelId').value;
            if(globalChannel) {
                socket.emit('joinChannel', { botId: bot.id, guildId: 'global', channelId: globalChannel });
            } else {
                alert('Please enter a Global Channel ID first to join.');
            }
        }
    });

    return card;
}

// Update single bot card
function updateBotCard(botData) {
    const card = document.getElementById(`bot-${botData.id}`);
    if (card) {
        // find its current index based on dom
        const botsGrid = document.getElementById('botsGrid');
        const nodes = Array.from(botsGrid.children);
        const index = nodes.indexOf(card) + 1;
        
        const newCard = createBotCard(botData, index);
        card.replaceWith(newCard);
    }
}

// Audio file management
function loadAudioFiles() {
    fetch('/api/audio-files')
        .then(res => res.json())
        .then(files => {
            audioFiles = files;
            updateAudioLibrary(files);
        })
        .catch(err => console.error('Failed to load audio files:', err));
}

function updateAudioLibrary(files) {
    const audioList = document.getElementById('audioList');
    const globalSelect = document.getElementById('globalAudioSelect');
    
    if(audioList) audioList.innerHTML = '';
    if(globalSelect) {
        globalSelect.innerHTML = '<option value="">Select Audio File...</option>';
    }

    files.forEach(file => {
        // Update Library List
        if (audioList) {
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
                    <button class="btn btn-primary" onclick="playAudioFile('${file.filename}')"><i class="fa-solid fa-play"></i></button>
                    <button class="btn btn-danger" onclick="deleteAudioFile('${file.filename}')"><i class="fa-solid fa-trash"></i></button>
                </div>
            `;
            audioList.appendChild(item);
        }

        // Update Global Dropdown
        if (globalSelect) {
            const option = document.createElement('option');
            option.value = file.filename;
            option.textContent = file.originalname || file.filename;
            globalSelect.appendChild(option);
        }
    });
}

async function uploadAudio() {
    const fileInput = document.getElementById('audioUpload');
    const file = fileInput.files[0];

    if (!file) {
        alert('Please select a file');
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
            fileInput.value = '';
            loadAudioFiles();
        } else {
            alert('Upload failed: ' + result.error);
        }
    } catch (error) {
        alert('Upload failed: ' + error.message);
    }
}

function playAudioFile(filename) {
    // Select in first available bot that is in voice
    const onlineBot = currentBots.find(b => b.status === 'in-voice');
    if (onlineBot) {
        socket.emit('playAudio', { botId: onlineBot.id, filename });
    } else {
        alert('No bots are in a voice channel to play audio.');
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
            loadAudioFiles();
        } else {
            alert('Delete failed');
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
            document.getElementById('addBotModal').classList.remove('show');
            document.getElementById('botToken').value = '';
            loadBots();
        } else {
            alert('Failed to add bot: ' + result.error);
        }
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

    while (logContainer.children.length > 100) {
        logContainer.removeChild(logContainer.firstChild);
    }
}

window.playAudioFile = playAudioFile;
window.deleteAudioFile = deleteAudioFile;
window.deleteUser = deleteUser;