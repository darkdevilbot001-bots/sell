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

class BotManager {
    constructor(io) {
        this.io = io;
        this.bots = [];
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

        // noSubscriberAction: Play → keeps playing even while bots are still connecting
        this.masterPlayer = createAudioPlayer({
            behaviors: { noSubscriberAction: NoSubscriberBehavior.Play }
        });

        this.masterPlayer.on(AudioPlayerStatus.Idle, () => {
            if (this.globalConfig.loop && this.globalConfig.currentAudio) {
                setTimeout(() => this.playAll(this.globalConfig.currentAudio), 500);
            } else {
                this.globalConfig.currentAudio = null;
                this.broadcastStatus();
            }
        });

        this.masterPlayer.on('error', (err) => {
            console.error(`[Player] Error: ${err.message}`);
            this.globalConfig.currentAudio = null;
            this.broadcastStatus();
        });

        this.loadConfig();
    }

    loadTokens() {
        const tokens = [];
        if (process.env.BOT_TOKENS) {
            process.env.BOT_TOKENS.split(',').forEach(t => { if (t.trim()) tokens.push(t.trim()); });
        } else {
            for (let i = 0; i < 30; i++) {
                const t = process.env[`BOT_TOKEN_${i}`];
                if (t) tokens.push(t.trim());
            }
        }
        console.log(`[System] Loaded ${tokens.length} bot tokens`);
        return tokens;
    }

    loadConfig() {
        const p = path.join(this.dataDir, 'config.json');
        if (fs.existsSync(p)) {
            try { this.globalConfig = { ...this.globalConfig, ...JSON.parse(fs.readFileSync(p, 'utf8')) }; } catch {}
        }
    }

    saveConfig() {
        try { fs.writeFileSync(path.join(this.dataDir, 'config.json'), JSON.stringify(this.globalConfig, null, 2)); } catch {}
    }

    async init() {
        console.log(`[System] Initializing ${this.tokens.length} bots...`);
        for (let i = 0; i < this.tokens.length; i++) {
            const botId = i;
            const client = new Client({
                intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
                makeCache: () => new Map(),
                rest: { retries: 3, timeout: 15000 }
            });
            const bot = { id: botId, client, connection: null, isOnline: false, tag: `Bot ${botId + 1}` };
            this.setupEvents(bot);
            this.bots.push(bot);
            try {
                await client.login(this.tokens[i]);
                await new Promise(r => setTimeout(r, 5500)); // Discord: 1 identify per 5s
            } catch (err) {
                console.error(`[Bot ${botId + 1}] Login failed: ${err.message}`);
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
        bot.client.on(Events.Error, (err) => console.error(`[Bot ${bot.id + 1}] ${err.message}`));
    }

    broadcastStatus() {
        const mem = process.memoryUsage();
        this.io.emit('botStatus', {
            bots: this.bots.map(b => ({
                id: b.id,
                tag: b.tag || `Bot ${b.id + 1}`,
                isOnline: b.isOnline,
                isJoined: !!b.connection && b.connection.state.status !== VoiceConnectionStatus.Destroyed,
                status: this.masterPlayer.state.status
            })),
            config: this.globalConfig,
            usage: { mem }
        });
    }

    async joinVC(input) {
        const channelId = String(input).replace(/\D/g, '');
        if (!channelId) return;
        this.globalConfig.currentVC = channelId;
        this.saveConfig();

        const onlineBots = this.bots.filter(b => b.isOnline);
        console.log(`[System] Joining ${onlineBots.length} bots to channel ${channelId}...`);

        // ALL bots join simultaneously — no batching, no waiting for Ready.
        // @discordjs/voice queues subscriptions internally; audio starts as soon
        // as each connection transitions to Ready on its own.
        const results = await Promise.allSettled(onlineBots.map(async (bot) => {
            try {
                const channel = await bot.client.channels.fetch(channelId);
                if (!channel) throw new Error('Channel not found');

                if (bot.connection && bot.connection.state.status !== VoiceConnectionStatus.Destroyed) {
                    bot.connection.destroy();
                    bot.connection = null;
                }

                // group: bot.client.user.id is REQUIRED.
                // Without it, all bots share one connection slot (keyed by guildId)
                // and overwrite each other → only the last bot stays connected.
                bot.connection = joinVoiceChannel({
                    channelId: channel.id,
                    guildId: channel.guild.id,
                    adapterCreator: channel.guild.voiceAdapterCreator,
                    selfDeaf: true,
                    group: bot.client.user.id
                });

                // Subscribe IMMEDIATELY — no need to wait for Ready.
                // The subscription is queued and activates once the connection is ready.
                bot.connection.subscribe(this.masterPlayer);

                // Auto-reconnect on disconnect
                bot.connection.on(VoiceConnectionStatus.Disconnected, async () => {
                    try {
                        await Promise.race([
                            entersState(bot.connection, VoiceConnectionStatus.Signalling, 5_000),
                            entersState(bot.connection, VoiceConnectionStatus.Connecting, 5_000),
                        ]);
                    } catch {
                        if (bot.connection) {
                            try { bot.connection.destroy(); } catch {}
                            bot.connection = null;
                            this.broadcastStatus();
                        }
                    }
                });

                console.log(`[Bot ${bot.id + 1}] Joined VC ✓`);
            } catch (err) {
                console.error(`[Bot ${bot.id + 1}] Failed: ${err.message}`);
                throw err;
            }
        }));

        const joined = results.filter(r => r.status === 'fulfilled').length;
        const failed = results.filter(r => r.status === 'rejected').length;
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

    getFFmpegArgs(filePath, startTime = 0) {
        const args = ['-loglevel', 'warning'];
        if (startTime > 0) args.push('-ss', String(startTime));
        args.push('-i', filePath);

        const filters = [];
        if (this.globalConfig.bass > 0) filters.push(`bass=g=${this.globalConfig.bass}:f=60:w=0.5`);
        if (this.globalConfig.speed !== 1.0) filters.push(`atempo=${this.globalConfig.speed}`);
        filters.push(`volume=${this.globalConfig.volume / 100}`);
        if (filters.length > 0) args.push('-af', filters.join(','));

        // Output as Ogg/Opus — FFmpeg encodes using libopus (C library, very fast).
        // @discordjs/voice uses StreamType.OggOpus to demux and forward Opus packets
        // DIRECTLY to Discord UDP — zero re-encoding in Node.js, no opusscript needed.
        // This is why audio was stuck before: opusscript (pure JS) was re-encoding
        // every 20ms frame and couldn't keep up on the Render free tier.
        args.push(
            '-vn',
            '-c:a', 'libopus',
            '-f', 'ogg',
            '-ar', '48000',
            '-ac', '2',
            '-b:a', '128k',
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

        if (this.centralFFmpeg) {
            try { this.centralFFmpeg.kill('SIGKILL'); } catch {}
            this.centralFFmpeg = null;
        }
        this.masterPlayer.stop(true);

        const args = this.getFFmpegArgs(filePath, startTime);

        let ffmpegCmd = 'ffmpeg';
        try {
            const s = require('ffmpeg-static');
            if (s && fs.existsSync(s)) ffmpegCmd = s;
        } catch {}

        console.log(`[FFmpeg] Starting: ${audioFileName}`);
        this.centralFFmpeg = spawn(ffmpegCmd, args);

        this.centralFFmpeg.on('error', (err) => console.error(`[FFmpeg] Error: ${err.message}`));

        let stderr = '';
        this.centralFFmpeg.stderr.on('data', d => { stderr += d.toString(); });
        this.centralFFmpeg.on('close', (code) => {
            if (code !== 0 && code !== null) {
                console.error(`[FFmpeg] Exit ${code}: ${stderr.slice(-300)}`);
            }
        });

        // OggOpus stream piped directly — no PassThrough needed.
        // @discordjs/voice's OggOpus demuxer reads the Ogg container and extracts
        // Opus frames to send directly to Discord. Clean, stutter-free.
        const resource = createAudioResource(this.centralFFmpeg.stdout, {
            inputType: StreamType.OggOpus,
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
