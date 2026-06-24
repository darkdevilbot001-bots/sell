let settings = null;

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    await loadSettings();
    setupUI();
    setupEventListeners();
});

async function loadSettings() {
    settings = await window.electronAPI.getSettings();
}

function setupUI() {
    renderTabs();
    navigateToServer(settings.activeServer || 1);
}

function renderTabs() {
    const tabsContainer = document.getElementById('serverTabs');
    tabsContainer.innerHTML = '';

    [settings.server1, settings.server2].forEach((server, idx) => {
        const tab = document.createElement('button');
        tab.className = 'server-tab';
        if ((idx + 1) === settings.activeServer) tab.classList.add('active');
        
        tab.innerHTML = `<span class="status-dot offline"></span> ${server.name || `Instance ${idx + 1}`}`;
        tab.dataset.server = idx + 1;
        tab.addEventListener('click', () => navigateToServer(idx + 1));
        
        tabsContainer.appendChild(tab);
    });
}

function navigateToServer(serverNum) {
    const serverKey = `server${serverNum}`;
    const server = settings[serverKey];
    
    // Update active tab
    document.querySelectorAll('.server-tab').forEach(tab => {
        tab.classList.toggle('active', parseInt(tab.dataset.server) === serverNum);
    });

    // Update loading
    const overlay = document.getElementById('loadingOverlay');
    overlay.classList.remove('hidden');
    document.getElementById('loadingText').textContent = `Connecting to ${server.name || server.url}...`;

    // Navigate webview
    const webview = document.getElementById('mainWebview');
    webview.src = server.url;

    // Hide loading when page loads
    webview.addEventListener('did-stop-loading', () => {
        setTimeout(() => overlay.classList.add('hidden'), 500);
    }, { once: true });
    
    // Fallback: hide loading after 8 seconds
    setTimeout(() => overlay.classList.add('hidden'), 8000);

    settings.activeServer = serverNum;
    window.electronAPI.saveSettings(settings);
}

function setupEventListeners() {
    // Settings button
    document.getElementById('settingsBtn').addEventListener('click', () => {
        // Populate settings form
        document.getElementById('s1Name').value = settings.server1.name;
        document.getElementById('s1Url').value = settings.server1.url;
        document.getElementById('s1Username').value = settings.server1.username;
        document.getElementById('s1Password').value = settings.server1.password;
        
        document.getElementById('s2Name').value = settings.server2.name;
        document.getElementById('s2Url').value = settings.server2.url;
        document.getElementById('s2Username').value = settings.server2.username;
        document.getElementById('s2Password').value = settings.server2.password;
        
        document.getElementById('settingsModal').classList.add('show');
    });

    // Close settings
    document.getElementById('closeSettings').addEventListener('click', () => {
        document.getElementById('settingsModal').classList.remove('show');
    });

    // Save settings
    document.getElementById('saveSettings').addEventListener('click', () => {
        settings.server1.name = document.getElementById('s1Name').value || 'Instance 1';
        settings.server1.url = document.getElementById('s1Url').value;
        settings.server1.username = document.getElementById('s1Username').value || 'veera';
        settings.server1.password = document.getElementById('s1Password').value || 'admin123';
        
        settings.server2.name = document.getElementById('s2Name').value || 'Instance 2';
        settings.server2.url = document.getElementById('s2Url').value;
        settings.server2.username = document.getElementById('s2Username').value || 'veera';
        settings.server2.password = document.getElementById('s2Password').value || 'admin123';
        
        window.electronAPI.saveSettings(settings);
        document.getElementById('settingsModal').classList.remove('show');
        
        // Re-render tabs
        renderTabs();
        
        // Reload current server
        navigateToServer(settings.activeServer);
    });

    // Click outside modal to close
    document.getElementById('settingsModal').addEventListener('click', (e) => {
        if (e.target === document.getElementById('settingsModal')) {
            document.getElementById('settingsModal').classList.remove('show');
        }
    });
}