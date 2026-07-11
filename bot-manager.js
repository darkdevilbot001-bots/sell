const { Client, GatewayIntentBits, Events } = require('discord.js');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    StreamType,
    NoSubscriberBehavior,
    entersState
} = require('@discordjs/voice');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const { PassThrough } = require('stream');

class BotManager {
    constructor(io) {
        this.io = io;
        this.bots = [];
        this.numBots = 30;
        this.tokens = this.loadTokens();
        this.audioDir = path.join(__dirname, 'uploads');
        this.dataDir = path.join(__dirname, 'data');
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

        // ─── MASTER PLAYER ──────────────────────────────────────────────────────
        // noSubscriberAction: 'play' → keeps playing even while bots are still connecting
        // This ensures latecomers get audio immediately on subscribe
        this.masterPlayer = createAudioPlayer({
            behaviors: {
                noSubscriberAction: NoSubscriberBehavior.Play
            }
        });

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
        if (process.env.BOT_TOKENS) {
            const parsed = process.env.BOT_TOKENS.split(',').map(t => t.trim()).filter(t => t);
            tokens.push(...parsed);
        } else {
            for (let i = 0; i < 30; i++) {
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
                console.error('Error loading config:', e);
            }
        }
    }

    saveConfig() {
        const configPath = path.join(this.dataDir, 'config.json');
        try {
            fs.writeFileSync(configPath, JSON.stringify(this.globalConfig, null, 2));
        } catch (e) {}
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
            const botData = {
                id: botId,
                client,
                connection: null,
                isOnline: false,
                tag: `Bot ${botId + 1}`
            };
            this.setupEvents(botData);
            this.bots.push(botData);
            try {
                await client.login(this.tokens[i]);
                // Discord requires at least 5s between IDENTIFY payloads (login)
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
            console.error(`[Bot ${bot.id + 1}] Client Error: ${err.message}`);
        });
    }

    broadcastStatus() {
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
            usage: { mem }
        });
    }

    // ─── JOIN VOICE CHANNEL ──────────────────────────────────────────────────────
    // KEY RULES:
    // 1. group: bot.client.user.id  → MUST be set. When multiple Discord clients run
    //    in the same Node.js process, without a unique group each bot's joinVoiceChannel
    //    call OVERWRITES the previous one in @discordjs/voice's internal connection map
    //    (keyed by guildId). Only the last bot would actually be connected.
    //    Setting group = each bot's userId gives each bot its own slot.
    // 2. All connections still subscribe to the SAME masterPlayer — subscriptions are
    //    independent of group. Audio reaches all 30 bots.
    // 3. Bots join in batches of 5 every 300ms to avoid flooding Discord's voice server.
    async joinVC(input) {
        const channelId = String(input).replace(/\D/g, '');
        if (!channelId) return;
        this.globalConfig.currentVC = channelId;
        this.saveConfig();

        const onlineBots = this.bots.filter(b => b.isOnline);
        console.log(`[System] Joining ${onlineBots.length} bots to channel ${channelId}...`);

        // Batch join: 5 bots simultaneously, 300ms between batches
        const BATCH_SIZE = 5;
        const BATCH_DELAY = 300; // ms between batches
        let joined = 0;
        let failed = 0;

        for (let i = 0; i < onlineBots.length; i += BATCH_SIZE) {
            const batch = onlineBots.slice(i, i + BATCH_SIZE);

            const batchResults = await Promise.allSettled(batch.map(async (bot) => {
                try {
                    const channel = await bot.client.channels.fetch(channelId);
                    if (!channel) throw new Error('Channel not found');

                    // Destroy old connection if exists
                    if (bot.connection && bot.connection.state.status !== VoiceConnectionStatus.Destroyed) {
                        bot.connection.destroy();
                        bot.connection = null;
                    }

                    // ← group: bot.client.user.id is REQUIRED here
                    bot.connection = joinVoiceChannel({
                        channelId: channel.id,
                        guildId: channel.guild.id,
                        adapterCreator: channel.guild.voiceAdapterCreator,
                        selfDeaf: true,
                        group: bot.client.user.id  // ← CRITICAL: unique slot per bot
                    });

                    // Wait for connection to become Ready (max 10s)
                    await entersState(bot.connection, VoiceConnectionStatus.Ready, 10_000);

                    // Subscribe this connection to the shared master player
                    bot.connection.subscribe(this.masterPlayer);

                    // Auto-reconnect if connection is dropped
                    bot.connection.on(VoiceConnectionStatus.Disconnected, async () => {
                        try {
                            // Try to reconnect within 5 seconds
                            await Promise.race([
                                entersState(bot.connection, VoiceConnectionStatus.Signalling, 5_000),
                                entersState(bot.connection, VoiceConnectionStatus.Connecting, 5_000),
                            ]);
                        } catch {
                            // Reconnect failed — destroy and clean up
                            if (bot.connection) {
                                try { bot.connection.destroy(); } catch {}
                                bot.connection = null;
                                this.broadcastStatus();
                            }
                        }
                    });

                    console.log(`[Bot ${bot.id + 1}] Joined VC ✓`);
                } catch (err) {
                    console.error(`[Bot ${bot.id + 1}] Failed to join: ${err.message}`);
                    throw err;
                }
            }));

            joined += batchResults.filter(r => r.status === 'fulfilled').length;
            failed += batchResults.filter(r => r.status === 'rejected').length;
            this.broadcastStatus();

            // Wait before next batch (skip wait after last batch)
            if (i + BATCH_SIZE < onlineBots.length) {
                await new Promise(r => setTimeout(r, BATCH_DELAY));
            }
        }

        console.log(`[System] Join complete — ${joined} joined, ${failed} failed.`);
        this.broadcastStatus();
    }

    async disconnectAll() {
        this.globalConfig.currentVC = null;
        this.saveConfig();
        this.stopAll();
        for (const bot of this.bots) {
            if (bot.connection) {
                try { bot.connection.destroy(); } catch {}
                bot.connection = null;
            }
        }
        this.broadcastStatus();
    }

    // ─── FFMPEG ARGS ─────────────────────────────────────────────────────────────
    // Clean, correct raw-PCM args for Discord voice (48kHz stereo s16le)
    // No -re (that throttles and causes dropouts), no video encoder flags
    getFFmpegArgs(filePath, startTime = 0) {
        const args = [];
        if (startTime > 0) args.push('-ss', String(startTime));
        args.push('-i', filePath);

        const filters = [];
        if (this.globalConfig.bass > 0) filters.push(`bass=g=${this.globalConfig.bass}:f=60:w=0.5`);
        if (this.globalConfig.speed !== 1.0) filters.push(`atempo=${this.globalConfig.speed}`);
        filters.push(`volume=${this.globalConfig.volume / 100}`);
        if (filters.length > 0) args.push('-af', filters.join(','));

        args.push(
            '-vn',         // Discard any video streams (saves CPU)
            '-f', 's16le', // Raw signed 16-bit little-endian PCM
            '-ar', '48000',// Discord requires 48kHz sample rate
            '-ac', '2',    // Stereo
            'pipe:1'       // Output to stdout
        );
        return args;
    }

    // ─── PLAY AUDIO ──────────────────────────────────────────────────────────────
    playAll(audioFileName, startTime = 0) {
        const filePath = path.join(this.audioDir, audioFileName);
        if (!fs.existsSync(filePath)) {
            console.error(`[System] File not found: ${audioFileName}`);
            return;
        }

        this.globalConfig.currentAudio = audioFileName;
        this.saveConfig();

        // Kill any existing FFmpeg process
        if (this.centralFFmpeg) {
            try { this.centralFFmpeg.kill('SIGKILL'); } catch {}
            this.centralFFmpeg = null;
        }
        this.masterPlayer.stop(true);

        const args = this.getFFmpegArgs(filePath, startTime);

        // Prefer ffmpeg-static if available, fall back to system ffmpeg
        let ffmpegCmd = 'ffmpeg';
        try {
            const staticPath = require('ffmpeg-static');
            if (staticPath && fs.existsSync(staticPath)) ffmpegCmd = staticPath;
        } catch {}

        console.log(`[FFmpeg] Starting playback: ${audioFileName}`);
        this.centralFFmpeg = spawn(ffmpegCmd, args);

        this.centralFFmpeg.on('error', (err) => {
            console.error(`[FFmpeg] Spawn error: ${err.message}`);
        });

        let stderrData = '';
        this.centralFFmpeg.stderr.on('data', (chunk) => {
            stderrData += chunk.toString();
        });

        this.centralFFmpeg.on('close', (code) => {
            if (code !== 0 && code !== null) {
                console.error(`[FFmpeg] Exited with code ${code}`);
                if (stderrData) console.error(`[FFmpeg] stderr: ${stderrData.slice(-500)}`);
            }
        });

        // PassThrough buffer decouples FFmpeg's write speed from 30 bots reading
        // simultaneously. Without this, one slow bot causes backpressure that
        // starves all other bots → audio stutter/dropout.
        // 4MB = ~10 seconds of pre-buffered audio at 48kHz stereo s16le
        const audioBuffer = new PassThrough({ highWaterMark: 1024 * 1024 * 4 });
        this.centralFFmpeg.stdout.pipe(audioBuffer, { end: true });

        const resource = createAudioResource(audioBuffer, {
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
            try { this.centralFFmpeg.kill('SIGKILL'); } catch {}
            this.centralFFmpeg = null;
        }
        try { this.masterPlayer.stop(true); } catch {}
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
