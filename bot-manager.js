const { Client, GatewayIntentBits, Events } = require('discord.js');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    StreamType
} = require('@discordjs/voice');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
// stream module no longer needed (PassThrough removed for direct FFmpeg piping)

class BotManager {
    constructor(io) {
        this.io = io;
        this.bots = [];
        this.numBots = 30;
        this.tokens = this.loadTokens();
        this.audioDir = path.join(__dirname, 'uploads');
        this.dataDir = path.join(__dirname, 'data');

        // MASTER PLAYER: One engine for the whole fleet
        this.masterPlayer = createAudioPlayer();
        this.centralFFmpeg = null;

        if (!fs.existsSync(this.audioDir)) fs.mkdirSync(this.audioDir, { recursive: true });
        if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });

        this.globalConfig = {
            volume: 100,
            bass: 0,
            speed: 1.0,
            loop: false,
            currentAudio: null,
            currentVC: null,
        };

        // Master player event handlers
        this.masterPlayer.on(AudioPlayerStatus.Idle, () => {
            if (this.globalConfig.loop && this.globalConfig.currentAudio) {
                setTimeout(() => this.playAll(this.globalConfig.currentAudio), 500);
            } else {
                this.globalConfig.currentAudio = null;
                this.broadcastStatus();
            }
        });

        this.masterPlayer.on('error', (error) => {
            console.error(`[Audio Player] Error: ${error.message}`);
            this.globalConfig.currentAudio = null;
            this.broadcastStatus();
        });

        this.loadConfig();
    }

    loadTokens() {
        const tokens = [];
        // Support both BOT_TOKEN_0..29 (original format) and BOT_TOKENS (comma-separated)
        if (process.env.BOT_TOKENS) {
            const parsed = process.env.BOT_TOKENS.split(',').map(t => t.trim()).filter(t => t);
            tokens.push(...parsed);
        } else {
            for (let i = 0; i < this.numBots; i++) {
                const token = process.env[`BOT_TOKEN_${i}`];
                if (token) tokens.push(token.trim());
            }
        }
        console.log(`[System] Loaded ${tokens.length} bot tokens`);
        return tokens;
    }

    loadConfig() {
        const configPath = path.join(this.dataDir, 'config.json');
        if (fs.existsSync(configPath)) {
            try {
                const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                this.globalConfig = { ...this.globalConfig, ...saved };
            } catch (e) {
                console.error("Error loading config:", e);
            }
        }
    }

    saveConfig() {
        const configPath = path.join(this.dataDir, 'config.json');
        try {
            fs.writeFileSync(configPath, JSON.stringify(this.globalConfig, null, 2));
        } catch (e) { }
    }

    async init() {
        console.log(`[System] Initializing fleet of ${this.tokens.length} bots...`);
        for (let i = 0; i < this.tokens.length; i++) {
            const botId = i;
            const client = new Client({
                intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
                makeCache: () => new Map(),
                rest: { retries: 3, timeout: 15000 }
            });
            const botData = { id: botId, client, connection: null, isOnline: false, tag: `Bot ${botId + 1}` };
            this.setupEvents(botData);
            this.bots.push(botData);
            try {
                await client.login(this.tokens[i]);
                // Stagger logins to avoid Discord rate limits (1 identify per 5s)
                await new Promise(r => setTimeout(r, 5500));
            } catch (err) {
                console.error(`[Bot ${botId + 1}] Login Failed: ${err.message}`);
            }
        }
        console.log('[System] All bots initialized.');
    }

    setupEvents(bot) {
        bot.client.on(Events.ClientReady, () => {
            bot.isOnline = true;
            bot.tag = bot.client.user.tag;
            console.log(`[Bot ${bot.id + 1}] ONLINE as ${bot.tag}`);
            this.broadcastStatus();
        });

        bot.client.on(Events.Error, (err) => {
            console.error(`[Bot ${bot.id + 1}] Error: ${err.message}`);
        });
    }

    broadcastStatus() {
        const usage = process.cpuUsage();
        const mem = process.memoryUsage();
        const stats = this.bots.map(b => ({
            id: b.id,
            tag: b.tag || `Bot ${b.id + 1}`,
            isOnline: b.isOnline,
            isJoined: !!b.connection && b.connection.state.status !== VoiceConnectionStatus.Destroyed,
            status: this.masterPlayer.state.status
        }));
        this.io.emit('botStatus', {
            bots: stats,
            config: this.globalConfig,
            usage: { cpu: usage, mem }
        });
    }

    async joinVC(input) {
        const channelId = String(input).replace(/\D/g, '');
        if (!channelId) return;
        this.globalConfig.currentVC = channelId;
        this.saveConfig();

        const onlineBots = this.bots.filter(b => b.isOnline);
        console.log(`[System] Joining ${onlineBots.length} bots to channel ${channelId} simultaneously...`);

        // Join ALL bots in parallel — no sequential delay!
        const results = await Promise.allSettled(onlineBots.map(async (bot) => {
            try {
                const channel = await bot.client.channels.fetch(channelId);
                if (!channel) throw new Error('Channel not found');

                if (bot.connection && bot.connection.state.status !== VoiceConnectionStatus.Destroyed) {
                    bot.connection.destroy();
                }

                bot.connection = joinVoiceChannel({
                    channelId: channel.id,
                    guildId: channel.guild.id,
                    adapterCreator: channel.guild.voiceAdapterCreator,
                    selfDeaf: true,
                    group: bot.client.user.id
                });

                // Wait for the connection to become Ready before subscribing
                await new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000);
                    bot.connection.once(VoiceConnectionStatus.Ready, () => {
                        clearTimeout(timeout);
                        resolve();
                    });
                    bot.connection.once(VoiceConnectionStatus.Destroyed, () => {
                        clearTimeout(timeout);
                        reject(new Error('Connection destroyed'));
                    });
                    // Also resolve immediately if already ready
                    if (bot.connection.state.status === VoiceConnectionStatus.Ready) {
                        clearTimeout(timeout);
                        resolve();
                    }
                });

                bot.connection.subscribe(this.masterPlayer);
                console.log(`[Bot ${bot.id + 1}] Joined VC ✓`);
            } catch (err) {
                console.error(`[Bot ${bot.id + 1}] Failed to join: ${err.message}`);
                throw err;
            }
        }));

        const joined = results.filter(r => r.status === 'fulfilled').length;
        const failed = results.filter(r => r.status === 'rejected').length;
        console.log(`[System] Join complete: ${joined} joined, ${failed} failed.`);
        this.broadcastStatus();
    }

    async disconnectAll() {
        this.globalConfig.currentVC = null;
        this.saveConfig();
        this.stopAll();
        for (const bot of this.bots) {
            if (bot.connection) {
                try { bot.connection.destroy(); } catch (e) { }
                bot.connection = null;
            }
        }
        this.broadcastStatus();
    }

    getFFmpegArgs(filePath, startTime = 0) {
        const args = [];
        // Low-latency flags: avoid buffering at the input side
        args.push('-re');           // Read input at native frame rate (prevents buffer starvation)
        if (startTime > 0) args.push('-ss', String(startTime));
        args.push('-i', filePath);

        const filters = [];
        if (this.globalConfig.bass > 0) filters.push(`bass=g=${this.globalConfig.bass}:f=60:w=0.5`);
        if (this.globalConfig.speed !== 1.0) filters.push(`atempo=${this.globalConfig.speed}`);
        filters.push(`volume=${this.globalConfig.volume / 100}`);
        if (filters.length > 0) args.push('-af', filters.join(','));

        args.push(
            '-f', 's16le',
            '-ar', '48000',
            '-ac', '2',
            '-threads', '2',        // 2 threads is optimal for audio encode
            '-flush_packets', '1',  // Flush output immediately — no output buffering
            '-bufsize', '64k',      // Small encode buffer for tight latency
            'pipe:1'
        );
        return args;
    }

    playAll(audioFileName, startTime = 0) {
        const filePath = path.join(this.audioDir, audioFileName);
        if (!fs.existsSync(filePath)) {
            console.error(`[System] File not found: ${audioFileName}`);
            return;
        }

        this.globalConfig.currentAudio = audioFileName;
        this.saveConfig();

        // Kill any existing ffmpeg process
        if (this.centralFFmpeg) {
            try { this.centralFFmpeg.kill('SIGKILL'); } catch (e) { }
            this.centralFFmpeg = null;
        }
        this.masterPlayer.stop(true);

        const args = this.getFFmpegArgs(filePath, startTime);

        // Use system ffmpeg directly (Render has it pre-installed)
        // Fall back to ffmpeg-static only if needed
        let ffmpegCmd = 'ffmpeg';
        try {
            const staticPath = require('ffmpeg-static');
            if (staticPath && fs.existsSync(staticPath)) {
                ffmpegCmd = staticPath;
            }
        } catch (e) { }

        console.log(`[FFmpeg] Starting: ${ffmpegCmd} with ${args.length} args for ${audioFileName}`);
        this.centralFFmpeg = spawn(ffmpegCmd, args);

        this.centralFFmpeg.on('error', (err) => {
            console.error(`[FFmpeg] Spawn error: ${err.message}`);
        });

        // Log ffmpeg stderr for debugging (shows encoding info and errors)
        let stderrData = '';
        this.centralFFmpeg.stderr.on('data', (chunk) => {
            stderrData += chunk.toString();
        });

        this.centralFFmpeg.on('close', (code) => {
            if (code !== 0 && code !== null) {
                console.error(`[FFmpeg] Exited with code ${code}`);
                // Log last 500 chars of stderr for debugging
                if (stderrData) {
                    console.error(`[FFmpeg] stderr: ${stderrData.slice(-500)}`);
                }
            }
        });

        // Pipe FFmpeg stdout DIRECTLY — no extra PassThrough hop to avoid backpressure stuttering
        // Set a generous highWaterMark on stdout itself for smooth multi-subscriber streaming
        this.centralFFmpeg.stdout.setEncoding(null); // ensure binary mode
        const resource = createAudioResource(this.centralFFmpeg.stdout, {
            inputType: StreamType.Raw,
            inlineVolume: false
        });

        this.masterPlayer.play(resource);
        console.log(`[System] Now playing: ${audioFileName}`);
        this.broadcastStatus();
    }

    stopAll() {
        this.globalConfig.currentAudio = null;
        if (this.centralFFmpeg) {
            try { this.centralFFmpeg.kill('SIGKILL'); } catch (e) { }
            this.centralFFmpeg = null;
        }
        try { this.masterPlayer.stop(true); } catch (e) { }
        this.broadcastStatus();
    }

    seek(seconds) {
        if (!this.globalConfig.currentAudio) return;
        const current = this.globalConfig.currentTime || 0;
        this.globalConfig.currentTime = Math.max(0, current + seconds);
        this.playAll(this.globalConfig.currentAudio, this.globalConfig.currentTime);
    }

    updateConfig(newConfig) {
        this.globalConfig = { ...this.globalConfig, ...newConfig };
        this.saveConfig();
        if (this.globalConfig.currentAudio) {
            this.playAll(this.globalConfig.currentAudio);
        } else {
            this.broadcastStatus();
        }
    }
}

module.exports = BotManager;
