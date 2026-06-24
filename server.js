require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, GatewayIntentBits } = require('discord.js');
const { EmbedBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnection } = require('@discordjs/voice');
const { join } = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const session = require('express-session');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;
const AUDIO_STORAGE_PATH = process.env.AUDIO_STORAGE_PATH || './audio-files';
const MAX_AUDIO_SIZE = parseInt(process.env.MAX_AUDIO_SIZE) || 50; // MB

// Ensure audio storage directory exists
if (!fs.existsSync(AUDIO_STORAGE_PATH)){
    fs.mkdirSync(AUDIO_STORAGE_PATH, { recursive: true });
}

// Session middleware
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));

app.use(express.json());
app.use(express.static('public'));
app.use('/audio-files', express.static(AUDIO_STORAGE_PATH));

// Multer configuration for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, AUDIO_STORAGE_PATH + '/')
  },
  filename: function (req, file, cb) {
    const uniqueName = uuidv4() + '-' + file.originalname;
    cb(null, uniqueName)
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: MAX_AUDIO_SIZE * 1024 * 1024 // Convert MB to bytes
  },
  fileFilter: function (req, file, cb) {
    if (file.mimetype.startsWith('audio/') || file.originalname.endsWith('.mp3')) {
      cb(null, true);
    } else {
      cb(new Error('Only audio files (MP3) are allowed'));
    }
  }
});

// Bot Manager Class
class BotManager {
  constructor() {
    this.bots = new Map();
    this.botTokens = this.parseBotTokens();
    this.initializeBots();
  }

  parseBotTokens() {
    if (!process.env.BOT_TOKENS) return [];
    return process.env.BOT_TOKENS.split(',').map(t => t.trim()).filter(t => t);
  }

  async initializeBots() {
    for (let index = 0; index < this.botTokens.length; index++) {
      const token = this.botTokens[index];
      const botId = index + 1;
      
      const client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildVoiceStates,
        ]
      });

      const botData = {
        id: botId,
        token: token,
        client: client,
        status: 'offline',
        connection: null,
        player: null,
        currentAudio: null,
        volume: 100,
        bassBoost: 0,
        playbackSpeed: 1.0,
        isLooping: false,
        isPaused: false,
        currentChannel: null,
        guildId: null
      };

      client.on('ready', () => {
        botData.status = 'online';
        botData.username = client.user.username;
        botData.avatar = client.user.displayAvatarURL();
        this.broadcastBotUpdate(botId, botData);
        this.addLog(botId, 'info', `Bot ${botId} logged in as ${client.user.username}`);
      });

      client.on('disconnect', () => {
        botData.status = 'offline';
        this.broadcastBotUpdate(botId, botData);
        this.addLog(botId, 'warning', `Bot ${botId} disconnected`);
      });

      client.on('error', (error) => {
        this.addLog(botId, 'error', `Bot ${botId} error: ${error.message}`);
      });

      client.login(token).catch(err => {
        this.addLog(botId, 'error', `Bot ${botId} login failed: ${err.message}`);
        botData.status = 'offline';
      });

      this.bots.set(botId, botData);

      // Discord rate limits Identify requests (logins) to 1 per 5 seconds.
      // We must wait between starting each bot, otherwise Discord blocks the IP.
      await new Promise(resolve => setTimeout(resolve, 5500));
    }
  }

  sanitizeBotData(data) {
    return {
      id: data.id,
      username: data.username,
      avatar: data.avatar,
      status: data.status,
      guildId: data.guildId,
      currentChannel: data.currentChannel,
      currentAudio: data.currentAudio,
      volume: data.volume,
      bassBoost: data.bassBoost,
      playbackSpeed: data.playbackSpeed,
      isLooping: data.isLooping,
      isPaused: data.isPaused
    };
  }

  broadcastBotUpdate(botId, data) {
    const safeData = this.sanitizeBotData(data);
    io.emit('botUpdate', { botId, ...safeData });
  }

  addLog(botId, type, message) {
    const timestamp = new Date().toISOString();
    io.emit('newLog', { botId, type, message, timestamp });
  }

  async joinVoiceChannel(botId, guildId, channelId, token) {
    const bot = this.bots.get(botId);
    if (!bot || bot.status !== 'online') {
      throw new Error('Bot is not online');
    }

    try {
      // If guildId is global or missing, resolve it from the channel ID
      let resolvedGuildId = guildId;
      if (!resolvedGuildId || resolvedGuildId === 'global') {
        const channel = await bot.client.channels.fetch(channelId).catch(() => null);
        if (!channel) throw new Error('Cannot find channel. Ensure bot is in the server.');
        resolvedGuildId = channel.guildId || channel.guild.id;
      }

      const connection = joinVoiceChannel({
        channelId: channelId,
        guildId: resolvedGuildId,
        adapterCreator: bot.client.guilds.cache.get(resolvedGuildId)?.voiceAdapterCreator,
      });

      bot.connection = connection;
      bot.currentChannel = channelId;
      bot.guildId = guildId;
      bot.status = 'in-voice';
      bot.player = createAudioPlayer();
      
      connection.subscribe(bot.player);

      bot.player.on(AudioPlayerStatus.Idle, () => {
        if (!bot.isLooping || !bot.currentAudio) {
          this.addLog(botId, 'info', 'Playback finished');
        } else if (bot.isLooping) {
          this.playAudioFile(botId, bot.currentAudio);
        }
      });

      this.broadcastBotUpdate(botId, bot);
      this.addLog(botId, 'success', `Joined voice channel`);
      return { success: true };
    } catch (error) {
      this.addLog(botId, 'error', `Failed to join voice: ${error.message}`);
      throw error;
    }
  }

  async leaveVoiceChannel(botId) {
    const bot = this.bots.get(botId);
    if (!bot || !bot.connection) {
      throw new Error('Bot is not in a voice channel');
    }

    bot.player?.stop();
    bot.connection?.destroy();
    bot.connection = null;
    bot.player = null;
    bot.currentAudio = null;
    bot.currentChannel = null;
    bot.guildId = null;
    bot.status = 'online';
    bot.isPaused = false;

    this.broadcastBotUpdate(botId, bot);
    this.addLog(botId, 'info', 'Left voice channel');
    return { success: true };
  }

  async playAudioFile(botId, filename) {
    const bot = this.bots.get(botId);
    if (!bot || !bot.player) {
      throw new Error('Bot is not in voice channel');
    }

    const filePath = join(AUDIO_STORAGE_PATH, filename);
    if (!fs.existsSync(filePath)) {
      throw new Error('Audio file not found');
    }

    try {
      const resource = createAudioResource(filePath, {
        inlineVolume: true,
      });

      // Apply volume
      if (resource.volume) {
        resource.volume.setVolumeLogarithmic(bot.volume / 100);
      }

      bot.player.play(resource);
      bot.currentAudio = filename;
      bot.isPaused = false;
      bot.status = 'in-voice';

      this.broadcastBotUpdate(botId, bot);
      this.addLog(botId, 'success', `Playing: ${filename}`);
      return { success: true };
    } catch (error) {
      this.addLog(botId, 'error', `Failed to play audio: ${error.message}`);
      throw error;
    }
  }

  pausePlayback(botId) {
    const bot = this.bots.get(botId);
    if (!bot || !bot.player) {
      throw new Error('Bot is not playing');
    }

    bot.player.pause();
    bot.isPaused = true;
    this.broadcastBotUpdate(botId, bot);
    this.addLog(botId, 'info', 'Playback paused');
    return { success: true };
  }

  resumePlayback(botId) {
    const bot = this.bots.get(botId);
    if (!bot || !bot.player) {
      throw new Error('Bot is not playing');
    }

    bot.player.unpause();
    bot.isPaused = false;
    this.broadcastBotUpdate(botId, bot);
    this.addLog(botId, 'info', 'Playback resumed');
    return { success: true };
  }

  stopPlayback(botId) {
    const bot = this.bots.get(botId);
    if (!bot || !bot.player) {
      throw new Error('Bot is not playing');
    }

    bot.player.stop();
    bot.currentAudio = null;
    bot.isPaused = false;
    bot.status = 'in-voice';
    this.broadcastBotUpdate(botId, bot);
    this.addLog(botId, 'info', 'Playback stopped');
    return { success: true };
  }

  setVolume(botId, volume) {
    const bot = this.bots.get(botId);
    if (!bot || !bot.player) {
      throw new Error('Bot is not initialized');
    }

    bot.volume = Math.max(0, Math.min(200, volume));
    if (bot.currentAudio) {
      // Restart player with new volume
      const resource = createAudioResource(join(AUDIO_STORAGE_PATH, bot.currentAudio), {
        inlineVolume: true,
      });
      if (resource.volume) {
        resource.volume.setVolumeLogarithmic(bot.volume / 100);
      }
      bot.player.play(resource);
    }
    this.broadcastBotUpdate(botId, bot);
    return { success: true, volume: bot.volume };
  }

  setBassBoost(botId, level) {
    const bot = this.bots.get(botId);
    if (!bot) {
      throw new Error('Bot not found');
    }
    
    bot.bassBoost = Math.max(0, Math.min(100, level));
    this.broadcastBotUpdate(botId, bot);
    return { success: true, bassBoost: bot.bassBoost };
  }

  setPlaybackSpeed(botId, speed) {
    const bot = this.bots.get(botId);
    if (!bot || !bot.player) {
      throw new Error('Bot is not initialized');
    }

    bot.playbackSpeed = Math.max(0.5, Math.min(2.0, speed));
    if (bot.currentAudio) {
      const resource = createAudioResource(join(AUDIO_STORAGE_PATH, bot.currentAudio), {
        inlineVolume: true,
      });
      if (resource.volume) {
        resource.volume.setVolumeLogarithmic(bot.volume / 100);
      }
      bot.player.play(resource);
    }
    this.broadcastBotUpdate(botId, bot);
    return { success: true, speed: bot.playbackSpeed };
  }

  toggleLoop(botId) {
    const bot = this.bots.get(botId);
    if (!bot) {
      throw new Error('Bot not found');
    }

    bot.isLooping = !bot.isLooping;
    this.broadcastBotUpdate(botId, bot);
    this.addLog(botId, 'info', `Loop ${bot.isLooping ? 'enabled' : 'disabled'}`);
    return { success: true, isLooping: bot.isLooping };
  }

  getBotStatus(botId) {
    const bot = this.bots.get(botId);
    if (!bot) return null;
    return {
      id: bot.id,
      status: bot.status,
      username: bot.username,
      avatar: bot.avatar,
      currentAudio: bot.currentAudio,
      volume: bot.volume,
      bassBoost: bot.bassBoost,
      playbackSpeed: bot.playbackSpeed,
      isLooping: bot.isLooping,
      isPaused: bot.isPaused
    };
  }

  getAllBots() {
    const bots = [];
    for (let i = 1; i <= 30; i++) {
      const bot = this.bots.get(i);
      if (bot) {
        bots.push(this.getBotStatus(i));
      } else {
        bots.push({
          id: i,
          status: 'offline',
          username: `Bot ${i}`,
          avatar: null,
          currentAudio: null,
          volume: 100,
          bassBoost: 0,
          playbackSpeed: 1.0,
          isLooping: false,
          isPaused: false
        });
      }
    }
    return bots;
  }
}

const botManager = new BotManager();

// System monitoring
let systemStats = {
  cpu: 0,
  memory: 0,
  uptime: 0
};

setInterval(() => {
  const usage = process.cpuUsage();
  const memUsage = process.memoryUsage();
  
  systemStats = {
    cpu: Math.round((usage.user + usage.system) / 1024 / 1024),
    memory: Math.round(memUsage.heapUsed / 1024 / 1024),
    uptime: process.uptime()
  };

  io.emit('systemStats', systemStats);
}, 5000);

// Auth middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

// User Management (In-memory)
const users = [
  { username: 'veera', password: process.env.ADMIN_PASSWORD || 'admin123', role: 'admin' }
];

// Routes
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = users.find(u => u.username === username && u.password === password);
  
  if (user) {
    req.session.authenticated = true;
    req.session.username = username;
    req.session.role = user.role;
    res.json({ success: true, username: user.username, role: user.role });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

app.get('/api/users', requireAuth, (req, res) => {
  res.json(users.map(u => ({ username: u.username, role: u.role })));
});

app.post('/api/users', requireAuth, (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  if (users.find(u => u.username === username)) {
    return res.status(400).json({ error: 'User already exists' });
  }
  users.push({ username, password, role: role || 'user' });
  res.json({ success: true });
});

app.delete('/api/users/:username', requireAuth, (req, res) => {
  if (req.params.username === 'veera') {
    return res.status(400).json({ error: 'Cannot delete primary admin' });
  }
  const index = users.findIndex(u => u.username === req.params.username);
  if (index !== -1) {
    users.splice(index, 1);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'User not found' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/auth/status', (req, res) => {
  res.json({ authenticated: req.session?.authenticated || false });
});

// Audio file routes
app.get('/api/audio-files', requireAuth, (req, res) => {
  try {
    const files = fs.readdirSync(AUDIO_STORAGE_PATH)
      .filter(file => file.endsWith('.mp3'))
      .map(file => {
        const stats = fs.statSync(join(AUDIO_STORAGE_PATH, file));
        // Extract original name: format is UUID-originalname.ext
        const match = file.match(/^[a-f0-9-]+-(.+)$/);
        const originalname = match ? match[1] : file;
        return {
          filename: file,
          originalname: originalname,
          size: Math.round(stats.size / 1024 / 1024 * 100) / 100,
          uploadedAt: stats.mtimeISO
        };
      });
    res.json(files);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/audio-files/upload', requireAuth, upload.single('audio'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  res.json({ 
    success: true, 
    file: {
      filename: req.file.filename,
      originalname: req.file.originalname,
      size: req.file.size
    }
  });
});

app.delete('/api/audio-files/:filename', requireAuth, (req, res) => {
  const filePath = join(AUDIO_STORAGE_PATH, req.params.filename);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});

// Bot control routes
app.get('/api/bots', requireAuth, (req, res) => {
  res.json(botManager.getAllBots());
});

app.get('/api/bots/:botId', requireAuth, (req, res) => {
  const bot = botManager.getBotStatus(parseInt(req.params.botId));
  if (bot) {
    res.json(bot);
  } else {
    res.status(404).json({ error: 'Bot not found' });
  }
});

app.post('/api/bots/:botId/join', requireAuth, async (req, res) => {
  try {
    const { guildId, channelId, token } = req.body;
    const result = await botManager.joinVoiceChannel(
      parseInt(req.params.botId),
      guildId,
      channelId,
      token
    );
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/bots/:botId/leave', requireAuth, async (req, res) => {
  try {
    const result = await botManager.leaveVoiceChannel(parseInt(req.params.botId));
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/bots/:botId/play', requireAuth, async (req, res) => {
  try {
    const { filename } = req.body;
    const result = await botManager.playAudioFile(parseInt(req.params.botId), filename);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/bots/:botId/pause', requireAuth, async (req, res) => {
  try {
    const result = botManager.pausePlayback(parseInt(req.params.botId));
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/bots/:botId/resume', requireAuth, async (req, res) => {
  try {
    const result = botManager.resumePlayback(parseInt(req.params.botId));
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/bots/:botId/stop', requireAuth, async (req, res) => {
  try {
    const result = botManager.stopPlayback(parseInt(req.params.botId));
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/bots/:botId/volume', requireAuth, async (req, res) => {
  try {
    const { volume } = req.body;
    const result = botManager.setVolume(parseInt(req.params.botId), volume);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/bots/:botId/bassboost', requireAuth, async (req, res) => {
  try {
    const { level } = req.body;
    const result = botManager.setBassBoost(parseInt(req.params.botId), level);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/bots/:botId/speed', requireAuth, async (req, res) => {
  try {
    const { speed } = req.body;
    const result = botManager.setPlaybackSpeed(parseInt(req.params.botId), speed);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/bots/:botId/loop', requireAuth, async (req, res) => {
  try {
    const result = botManager.toggleLoop(parseInt(req.params.botId));
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add bot endpoint
app.post('/api/bots/add', requireAuth, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }
    
    // Find next available bot slot
    let botSlot = -1;
    for (let i = 1; i <= 30; i++) {
      if (!botManager.bots.has(i)) {
        botSlot = i;
        break;
      }
    }
    
    if (botSlot === -1) {
      return res.status(400).json({ error: 'Maximum 30 bots reached' });
    }

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
      ]
    });

    const botData = {
      id: botSlot,
      token: token,
      client: client,
      status: 'offline',
      connection: null,
      player: null,
      currentAudio: null,
      volume: 100,
      bassBoost: 0,
      playbackSpeed: 1.0,
      isLooping: false,
      isPaused: false,
      currentChannel: null,
      guildId: null
    };

    client.on('clientReady', () => {
      botData.status = 'online';
      botData.username = client.user.username;
      botData.avatar = client.user.displayAvatarURL();
      botManager.broadcastBotUpdate(botSlot, botData);
      botManager.addLog(botSlot, 'info', `Bot ${botSlot} logged in as ${client.user.username}`);
    });

    client.on('disconnect', () => {
      botData.status = 'offline';
      botManager.broadcastBotUpdate(botSlot, botData);
    });

    client.on('error', (error) => {
      botManager.addLog(botSlot, 'error', `Bot ${botSlot} error: ${error.message}`);
    });

    client.login(token).catch(err => {
      botManager.addLog(botSlot, 'error', `Bot ${botSlot} login failed: ${err.message}`);
      botData.status = 'offline';
    });

    botManager.bots.set(botSlot, botData);
    
    res.json({ success: true, botId: botSlot });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Socket.IO connection handling
io.use((socket, next) => {
  // Optional: Add socket authentication here
  next();
});

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Send current system stats
  socket.emit('systemStats', systemStats);

  // Send all bots status
  socket.emit('allBotsUpdate', botManager.getAllBots());

  socket.on('joinChannel', async (data) => {
    try {
      const result = await botManager.joinVoiceChannel(
        data.botId,
        data.guildId,
        data.channelId
      );
      socket.emit('operationResult', { success: true, message: 'Joined voice channel' });
    } catch (error) {
      socket.emit('operationResult', { success: false, message: error.message });
    }
  });

  socket.on('leaveChannel', async (data) => {
    try {
      const result = await botManager.leaveVoiceChannel(data.botId);
      socket.emit('operationResult', { success: true, message: 'Left voice channel' });
    } catch (error) {
      socket.emit('operationResult', { success: false, message: error.message });
    }
  });

  socket.on('playAudio', async (data) => {
    try {
      const result = await botManager.playAudioFile(data.botId, data.filename);
      socket.emit('operationResult', { success: true, message: 'Playing audio' });
    } catch (error) {
      socket.emit('operationResult', { success: false, message: error.message });
    }
  });

  socket.on('pausePlayback', (data) => {
    try {
      const result = botManager.pausePlayback(data.botId);
      socket.emit('operationResult', { success: true, message: 'Paused' });
    } catch (error) {
      socket.emit('operationResult', { success: false, message: error.message });
    }
  });

  socket.on('resumePlayback', (data) => {
    try {
      const result = botManager.resumePlayback(data.botId);
      socket.emit('operationResult', { success: true, message: 'Resumed' });
    } catch (error) {
      socket.emit('operationResult', { success: false, message: error.message });
    }
  });

  socket.on('stopPlayback', (data) => {
    try {
      const result = botManager.stopPlayback(data.botId);
      socket.emit('operationResult', { success: true, message: 'Stopped' });
    } catch (error) {
      socket.emit('operationResult', { success: false, message: error.message });
    }
  });

  socket.on('setVolume', (data) => {
    try {
      const result = botManager.setVolume(data.botId, data.volume);
      socket.emit('operationResult', { success: true, volume: result.volume });
    } catch (error) {
      socket.emit('operationResult', { success: false, message: error.message });
    }
  });

  socket.on('setBassBoost', (data) => {
    try {
      const result = botManager.setBassBoost(data.botId, data.level);
      socket.emit('operationResult', { success: true, bassBoost: result.bassBoost });
    } catch (error) {
      socket.emit('operationResult', { success: false, message: error.message });
    }
  });

  socket.on('setPlaybackSpeed', (data) => {
    try {
      const result = botManager.setPlaybackSpeed(data.botId, data.speed);
      socket.emit('operationResult', { success: true, speed: result.speed });
    } catch (error) {
      socket.emit('operationResult', { success: false, message: error.message });
    }
  });

  socket.on('toggleLoop', (data) => {
    try {
      const result = botManager.toggleLoop(data.botId);
      socket.emit('operationResult', { success: true, isLooping: result.isLooping });
    } catch (error) {
      socket.emit('operationResult', { success: false, message: error.message });
    }
  });

  // Global Controls
  socket.on('joinAllChannels', async (data) => {
    let successCount = 0;
    const errors = [];
    const promises = [];
    for (const [botId, bot] of botManager.bots.entries()) {
      if (bot.status === 'online') {
        promises.push(botManager.joinVoiceChannel(botId, data.guildId, data.channelId, bot.token)
          .then(() => successCount++)
          .catch((err) => { errors.push(`Bot ${botId}: ${err.message}`); }));
      }
    }
    await Promise.all(promises);
    let message = `Joined ${successCount} bots to channel.`;
    if (errors.length > 0) {
        message += `\n${errors.length} failed. First error: ${errors[0]}`;
    }
    socket.emit('operationResult', { success: true, message });
  });

  socket.on('leaveAllChannels', async () => {
    let successCount = 0;
    const promises = [];
    for (const [botId, bot] of botManager.bots.entries()) {
      if (bot.status === 'in-voice') {
        promises.push(botManager.leaveVoiceChannel(botId)
          .then(() => successCount++)
          .catch(() => {}));
      }
    }
    await Promise.all(promises);
    socket.emit('operationResult', { success: true, message: `Disconnected ${successCount} bots` });
  });

  socket.on('playAudioGlobal', async (data) => {
    let successCount = 0;
    const promises = [];
    for (const [botId, bot] of botManager.bots.entries()) {
      if (bot.status === 'in-voice') {
        promises.push(botManager.playAudioFile(botId, data.filename)
          .then(() => successCount++)
          .catch(() => {}));
      }
    }
    await Promise.all(promises);
    socket.emit('operationResult', { success: true, message: `Started playback on ${successCount} bots` });
  });

  socket.on('stopAudioGlobal', () => {
    let successCount = 0;
    for (const [botId, bot] of botManager.bots.entries()) {
      if (bot.status === 'in-voice' && bot.currentAudio) {
        try {
          botManager.stopPlayback(botId);
          successCount++;
        } catch(e) {}
      }
    }
    socket.emit('operationResult', { success: true, message: `Stopped playback on ${successCount} bots` });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Serve login page
app.get('/', (req, res) => {
  if (req.session && req.session.authenticated) {
    res.sendFile(join(__dirname, 'public', 'index.html'));
  } else {
    res.sendFile(join(__dirname, 'public', 'login.html'));
  }
});

server.listen(PORT, () => {
  console.log(`Multi-Bot Audio Control System running on http://localhost:${PORT}`);
  console.log(`Managing ${botManager.botTokens.length} bot(s)`);
});