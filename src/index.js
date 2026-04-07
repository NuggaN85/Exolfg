'use strict';

import dotenv from 'dotenv';
import {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
  Events,
  ActivityType,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ActionRowBuilder,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  SeparatorBuilder,
} from 'discord.js';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

// ─── ESM __dirname ───────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── Environment ─────────────────────────────────────────────────────────────
dotenv.config();

if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID) {
  throw new Error("⚠️ Les variables d'environnement DISCORD_TOKEN et CLIENT_ID sont obligatoires.");
}

// ─── Discord client ───────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// ─── Database ─────────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'lfgData.db'), {
  verbose: process.env.NODE_ENV === 'development' ? console.log : null,
  fileMustExist: false,
  timeout: 5000,
  readonly: false,
});

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -64000');
db.pragma('temp_store = MEMORY');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS lfgSessions (
    id TEXT PRIMARY KEY,
    userId TEXT,
    user TEXT,
    game TEXT,
    platform TEXT,
    activity TEXT,
    gametag TEXT,
    description TEXT,
    date TEXT,
    players INTEGER,
    categoryId TEXT,
    voiceChannelId TEXT,
    textChannelId TEXT,
    infoTextChannelId TEXT,
    infoMessageId TEXT,
    commandChannelId TEXT,
    commandChannelMessageId TEXT,
    guildId TEXT
  );

  CREATE TABLE IF NOT EXISTS lfgJoinedUsers (
    sessionId TEXT,
    userId TEXT,
    PRIMARY KEY (sessionId, userId),
    FOREIGN KEY (sessionId) REFERENCES lfgSessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS lfgStats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    totalSessions INTEGER DEFAULT 0,
    totalPlayers INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS webhookChannels (
    guildId TEXT,
    game TEXT NOT NULL DEFAULT '*',
    channelId TEXT,
    PRIMARY KEY (guildId, game)
  );

  CREATE TABLE IF NOT EXISTS guildGameFilters (
    guildId TEXT PRIMARY KEY,
    games TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS guildCooldowns (
    guildId TEXT PRIMARY KEY,
    maxSessions INTEGER NOT NULL DEFAULT 3,
    windowSeconds INTEGER NOT NULL DEFAULT 3600
  );
`);

// ─── In-memory caches ─────────────────────────────────────────────────────────
const lfgSessions           = new Map();
const lfgJoinedUsers        = new Map();
const webhookChannels       = new Map(); // key: "guildId:game"
const guildGameFilters      = new Map();
const guildCooldowns        = new Map(); // key: guildId
const userSessionTimestamps = new Map(); // key: "guildId:userId" → number[]
const lfgStats              = { totalSessions: 0, totalPlayers: 0 };
const rateLimiter           = {};

const SESSION_EXPIRY = 24 * 60 * 60 * 1000;
const CACHE_TTL      = 60 * 60 * 1000;
const WEBHOOK_TTL    = 30 * 60 * 1000;
const FILTER_TTL     = 60 * 60 * 1000;
const COOLDOWN_TTL   = 60 * 60 * 1000;
const ITEMS_PER_PAGE = 10;

// ─── Game list ────────────────────────────────────────────────────────────────
const gameChoices = [
  { name: 'League of Legends',        value: 'League of Legends' },
  { name: 'Valorant',                  value: 'Valorant' },
  { name: 'Counter-Strike 2',          value: 'Counter-Strike 2' },
  { name: 'Dota 2',                    value: 'Dota 2' },
  { name: 'Apex Legends',              value: 'Apex Legends' },
  { name: 'Rainbow Six: Siege',        value: 'Rainbow Six: Siege' },
  { name: 'Overwatch 2',               value: 'Overwatch 2' },
  { name: 'Fortnite',                  value: 'Fortnite' },
  { name: 'Rocket League',             value: 'Rocket League' },
  { name: 'Call of Duty: Warzone',     value: 'COD: Warzone' },
  { name: 'PUBG: Battlegrounds',       value: 'PUBG: Battlegrounds' },
  { name: 'Hearthstone',               value: 'Hearthstone' },
  { name: 'Teamfight Tactics',         value: 'Teamfight Tactics' },
  { name: 'Street Fighter 6',          value: 'Street Fighter 6' },
  { name: 'Tekken 8',                  value: 'Tekken 8' },
  { name: 'EA Sports FC 24',           value: 'EA Sports FC 24' },
  { name: 'StarCraft II',              value: 'StarCraft II' },
  { name: 'Smite',                     value: 'Smite' },
  { name: 'Paladins',                  value: 'Paladins' },
  { name: 'World of Warcraft',         value: 'World of Warcraft' },
  { name: 'Brawlhalla',                value: 'Brawlhalla' },
  { name: 'Albion Online',             value: 'Albion Online' },
  { name: 'The Finals',                value: 'The Finals' },
  { name: 'Halo Infinite',             value: 'Halo Infinite' },
  { name: 'Mobile Legends: Bang Bang', value: 'Mobile Legends: Bang Bang' },
];

// ─── Utility helpers ──────────────────────────────────────────────────────────

function setWithTTL(map, key, value, ttl) {
  map.set(key, { value, expiresAt: Date.now() + ttl });
}

function getGuildGameFilter(guildId) {
  const cached = guildGameFilters.get(guildId);
  if (cached) return cached.value;
  const row   = db.prepare('SELECT games FROM guildGameFilters WHERE guildId = ?').get(guildId);
  const games = row ? JSON.parse(row.games) : [];
  setWithTTL(guildGameFilters, guildId, games, FILTER_TTL);
  return games;
}

function isGameAllowedForGuild(guildId, game) {
  const filter = getGuildGameFilter(guildId);
  return filter.length === 0 || filter.includes(game);
}

function getWebhookChannelId(guildId, game) {
  const specific = webhookChannels.get(`${guildId}:${game}`);
  if (specific) return specific.value;
  const fallback = webhookChannels.get(`${guildId}:*`);
  return fallback?.value ?? null;
}

function getWebhookEntriesForGuild(guildId) {
  const entries = [];
  for (const [key, data] of webhookChannels) {
    if (key.startsWith(`${guildId}:`)) {
      entries.push({ game: key.slice(guildId.length + 1), channelId: data.value });
    }
  }
  return entries;
}

// ─── Cooldown helpers ─────────────────────────────────────────────────────────

function getGuildCooldownConfig(guildId) {
  const cached = guildCooldowns.get(guildId);
  if (cached) return cached.value;
  const row    = db.prepare('SELECT maxSessions, windowSeconds FROM guildCooldowns WHERE guildId = ?').get(guildId);
  const config = row ?? { maxSessions: 3, windowSeconds: 3600 };
  setWithTTL(guildCooldowns, guildId, config, COOLDOWN_TTL);
  return config;
}

function checkUserSessionCooldown(guildId, userId) {
  const { maxSessions, windowSeconds } = getGuildCooldownConfig(guildId);
  const key      = `${guildId}:${userId}`;
  const now      = Date.now();
  const windowMs = windowSeconds * 1000;
  const existing = userSessionTimestamps.get(key) ?? [];
  const recent   = existing.filter(ts => now - ts < windowMs);
  if (recent.length >= maxSessions) return false;
  recent.push(now);
  userSessionTimestamps.set(key, recent);
  return true;
}

async function safeDeleteChannel(channel) {
  if (!channel?.deletable) return;
  try {
    await channel.delete();
    console.log(`✅ Canal ${channel.id} supprimé.`);
  } catch (err) {
    console.error(`⚠️ Erreur suppression canal ${channel.id}:`, err.message);
  }
}

// ─── Game image map ───────────────────────────────────────────────────────────
const gameImages = {
  'League of Legends': 'https://i.imgur.com/mm0hV5B.jpeg', 'Valorant': 'https://i.imgur.com/mm0hV5B.jpeg',
  'Counter-Strike 2': 'https://i.imgur.com/mm0hV5B.jpeg', 'Dota 2': 'https://i.imgur.com/mm0hV5B.jpeg',
  'Apex Legends': 'https://i.imgur.com/mm0hV5B.jpeg', 'Rainbow Six: Siege': 'https://i.imgur.com/mm0hV5B.jpeg',
  'Overwatch 2': 'https://i.imgur.com/mm0hV5B.jpeg', 'Fortnite': 'https://i.imgur.com/mm0hV5B.jpeg',
  'Rocket League': 'https://i.imgur.com/mm0hV5B.jpeg', 'COD: Warzone': 'https://i.imgur.com/mm0hV5B.jpeg',
  'PUBG: Battlegrounds': 'https://i.imgur.com/mm0hV5B.jpeg', 'Hearthstone': 'https://i.imgur.com/mm0hV5B.jpeg',
  'Teamfight Tactics': 'https://i.imgur.com/mm0hV5B.jpeg', 'Street Fighter 6': 'https://i.imgur.com/mm0hV5B.jpeg',
  'Tekken 8': 'https://i.imgur.com/mm0hV5B.jpeg', 'EA Sports FC 24': 'https://i.imgur.com/mm0hV5B.jpeg',
  'StarCraft II': 'https://i.imgur.com/mm0hV5B.jpeg', 'Smite': 'https://i.imgur.com/mm0hV5B.jpeg',
  'Paladins': 'https://i.imgur.com/mm0hV5B.jpeg', 'World of Warcraft': 'https://i.imgur.com/mm0hV5B.jpeg',
  'Brawlhalla': 'https://i.imgur.com/mm0hV5B.jpeg', 'Albion Online': 'https://i.imgur.com/mm0hV5B.jpeg',
  'The Finals': 'https://i.imgur.com/mm0hV5B.jpeg', 'Halo Infinite': 'https://i.imgur.com/mm0hV5B.jpeg',
  'Mobile Legends: Bang Bang': 'https://i.imgur.com/mm0hV5B.jpeg',
};

function getGameImageUrl(game) {
  const url = gameImages[game];
  return url && url.trim() !== '' ? url.trim() : null;
}

// ─── Emoji helpers ────────────────────────────────────────────────────────────

function getPlatformEmoji(platform) {
  const map = {
    'PC': '🖥️', 'PlayStation 5': '🎮', 'PlayStation 4': '🎮',
    'Xbox Series X|S': '🟩', 'Xbox One': '🟩', 'Nintendo Switch': '🔴',
    'Mobile': '📱', 'iOS': '📱', 'Android': '📱',
    'Crossplay': '🌐', 'VR': '🥽', 'Mac': '🍎', 'Linux': '🐧',
  };
  return map[platform] ?? '🕹️';
}

function getActivityEmoji(activity) {
  const map = {
    'Normale': '🎲', 'Classé': '🏆', 'Compétitif': '⚔️', 'Tournoi': '🏅',
    'Scrim': '🎯', 'Entraînement': '📚', 'Fun': '😄', 'Découverte': '🔭',
    'Arcade': '🕹️', 'Coopération': '🤝', 'Speedrun': '⚡',
    'PvE': '🐉', 'PvP': '⚔️', 'Raids': '🗡️', 'Dungeons': '🏰',
  };
  return map[activity] ?? '🎮';
}

// ─── Container builders ───────────────────────────────────────────────────────

function buildGameImageGallery(game) {
  const url = getGameImageUrl(game);
  if (!url) return null;
  return new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(url));
}

function buildNavButtons(sessionId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`vocal_${sessionId}`).setLabel('🔊 Vocal').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`texte_${sessionId}`).setLabel('💬 Discussion').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`info_${sessionId}`).setLabel('📢 Infos').setStyle(ButtonStyle.Secondary),
  );
}

function buildJoinLeaveButtons(sessionId, isFull) {
  const row = new ActionRowBuilder();
  if (!isFull) {
    row.addComponents(
      new ButtonBuilder().setCustomId(`join_${sessionId}`).setLabel('✅ Rejoindre').setStyle(ButtonStyle.Success),
    );
  }
  row.addComponents(
    new ButtonBuilder().setCustomId(`leave_${sessionId}`).setLabel('🚪 Se retirer').setStyle(ButtonStyle.Danger),
  );
  return row;
}

function buildSessionContainer({
  sessionId, label, guildName, organizerMention,
  game, platform, activity, joinedCount, maxPlayers,
  gametag, description, twitchUrl = null, participantsMention,
  includeJoinLeaveButtons = true, includeNavButtons = true, isModified = false,
}) {
  const isFull      = joinedCount >= maxPlayers;
  const statusEmoji = isModified ? '🔄' : '🟢';
  const slotDisplay = isFull ? `~~${joinedCount}/${maxPlayers}~~ **COMPLET**` : `${joinedCount}/${maxPlayers}`;
  const gameGallery = buildGameImageGallery(game);

  const container = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${statusEmoji} **${label}**`))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`\`🆔 Session #${sessionId}\``))
    .addSeparatorComponents(new SeparatorBuilder());

  if (gameGallery) container.addMediaGalleryComponents(gameGallery);

  container
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`👑 **Organisateur :** ${organizerMention}`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`🎮 **${game}**  ·  ${getPlatformEmoji(platform)} ${platform}`))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${getActivityEmoji(activity)} **${activity}**  ·  👥 **Joueurs :** ${slotDisplay}`))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`🎯 **Gametag :** \`${gametag}\``))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`> 📝 ${description}`))
    .setAccentColor(0x1E90FF);

  if (participantsMention !== undefined) {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`👥 **Participants :** ${participantsMention}`));
  }

  if (twitchUrl) {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `🟣 **Live Twitch :** [${twitchUrl.replace('https://twitch.tv/', '')}](${twitchUrl})`
      ));
  }

  if (includeNavButtons) {
    container.addSeparatorComponents(new SeparatorBuilder()).addActionRowComponents(buildNavButtons(sessionId));
  }

  if (includeJoinLeaveButtons) {
    container.addActionRowComponents(buildJoinLeaveButtons(sessionId, isFull));
  }

  container
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `-# ⏱️ Salon supprimé après 5 min si vide  ·  ${guildName}  ·  /lfg  /stats  /history`
    ));

  return container;
}

function buildCrossServerContainer({
  sessionId, sourceGuildName, sourceGuildId, voiceChannelId, textChannelId, infoTextChannelId,
  organizerMention, game, platform, activity, joinedCount, maxPlayers, gametag, description, twitchUrl,
}) {
  const gameGallery = buildGameImageGallery(game);
  const container   = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`📡 **Session LFG — Annonce externe**`))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`\`🆔 Session #${sessionId}\``))
    .addSeparatorComponents(new SeparatorBuilder());

  if (gameGallery) container.addMediaGalleryComponents(gameGallery);

  container
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`👑 **Organisateur :** ${organizerMention}`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`🎮 **${game}**  ·  ${getPlatformEmoji(platform)} ${platform}`))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${getActivityEmoji(activity)} **${activity}**  ·  👥 **Joueurs :** ${joinedCount}/${maxPlayers}`))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`🎯 **Gametag :** \`${gametag}\``))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`> 📝 ${description}`));

  if (twitchUrl) {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `🟣 **Live Twitch :** [${twitchUrl.replace('https://twitch.tv/', '')}](${twitchUrl})`
      ));
  }

  container
    .addSeparatorComponents(new SeparatorBuilder())
    .addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`xvocal_${sourceGuildId}_${voiceChannelId}`).setLabel('🔊 Vocal').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`xtexte_${sourceGuildId}_${textChannelId}`).setLabel('💬 Discussion').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`xinfo_${sourceGuildId}_${infoTextChannelId}`).setLabel('📢 Infos').setStyle(ButtonStyle.Secondary),
    ))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# 🌐 Session hébergée sur **${sourceGuildName}**`))
    .setAccentColor(0x1E90FF);

  return container;
}

// ─── Presence ─────────────────────────────────────────────────────────────────
async function updateRichPresence() {
  try {
    const totalSessions = lfgSessions.size;
    const totalPlayers  = Array.from(lfgJoinedUsers.values()).reduce((acc, d) => acc + (d.value?.length ?? 0), 0);
    client.user?.setPresence({
      activities: [{ name: `Sessions: ${totalSessions} | Joueurs: ${totalPlayers}`, type: ActivityType.Playing }],
      status: 'online',
    });
  } catch (err) {
    console.error('⚠️ Erreur Rich Presence:', err.message);
  }
}

// ─── Rate limiter ─────────────────────────────────────────────────────────────
function checkRateLimit(userId) {
  const now = Date.now();
  rateLimiter[userId] = (rateLimiter[userId] ?? []).filter(ts => now - ts < 60_000);
  if (rateLimiter[userId].length >= 5) return false;
  rateLimiter[userId].push(now);
  return true;
}

// ─── Database persistence ─────────────────────────────────────────────────────
async function saveData() {
  try {
    const insertSession  = db.prepare(`INSERT OR REPLACE INTO lfgSessions (id,userId,user,game,platform,activity,gametag,description,date,players,categoryId,voiceChannelId,textChannelId,infoTextChannelId,infoMessageId,commandChannelId,commandChannelMessageId,guildId) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertUser     = db.prepare('INSERT OR REPLACE INTO lfgJoinedUsers (sessionId, userId) VALUES (?, ?)');
    const deleteUsers    = db.prepare('DELETE FROM lfgJoinedUsers WHERE sessionId = ?');
    const updateStats    = db.prepare('INSERT OR REPLACE INTO lfgStats (id, totalSessions, totalPlayers) VALUES (1, ?, ?)');
    const insertWebhook  = db.prepare('INSERT OR REPLACE INTO webhookChannels (guildId, game, channelId) VALUES (?, ?, ?)');
    const insertFilter   = db.prepare('INSERT OR REPLACE INTO guildGameFilters (guildId, games) VALUES (?, ?)');
    const insertCooldown = db.prepare('INSERT OR REPLACE INTO guildCooldowns (guildId, maxSessions, windowSeconds) VALUES (?, ?, ?)');

    db.transaction(() => {
      for (const [id, data] of lfgSessions) {
        const { timeoutId, ...s } = data.value;
        insertSession.run(id, s.userId, s.user, s.game, s.platform, s.activity, s.gametag,
          s.description, s.date, s.players, s.categoryId, s.voiceChannelId, s.textChannelId,
          s.infoTextChannelId, s.infoMessageId, s.commandChannelId, s.commandChannelMessageId, s.guildId);
      }
      for (const [sessionId, data] of lfgJoinedUsers) {
        deleteUsers.run(sessionId);
        for (const userId of data.value ?? []) insertUser.run(sessionId, userId);
      }
      updateStats.run(lfgStats.totalSessions, lfgStats.totalPlayers);
      for (const [key, data] of webhookChannels) {
        const ci = key.indexOf(':');
        insertWebhook.run(key.slice(0, ci), key.slice(ci + 1), data.value);
      }
      for (const [guildId, data] of guildGameFilters) insertFilter.run(guildId, JSON.stringify(data.value));
      for (const [guildId, data] of guildCooldowns) insertCooldown.run(guildId, data.value.maxSessions, data.value.windowSeconds);
    })();

    console.log('✅ Données sauvegardées.');
  } catch (err) {
    console.error('⚠️ Erreur sauvegarde:', err.message);
  }
}

// ─── Session timeout ──────────────────────────────────────────────────────────
function resetTimeout(sessionId, guild) {
  const sessionData = lfgSessions.get(sessionId);
  if (!sessionData) return;
  const session = sessionData.value;
  if (session.timeoutId) { clearTimeout(session.timeoutId); session.timeoutId = null; }

  session.timeoutId = setTimeout(async () => {
    const vc = guild.channels.cache.get(session.voiceChannelId);
    if (!vc || vc.members.size === 0) {
      console.log(`🔄 Salon vide pour ${sessionId}. Suppression…`);
      await deleteLFGSession(sessionId, guild);
    }
  }, 5 * 60 * 1000);

  setWithTTL(lfgSessions, sessionId, session, CACHE_TTL);
}

// ─── Delete a LFG session ─────────────────────────────────────────────────────
async function deleteLFGSession(sessionId, guild) {
  const sessionData = lfgSessions.get(sessionId);
  if (!sessionData) return;
  const session = sessionData.value;
  try {
    if (session.timeoutId) clearTimeout(session.timeoutId);
    for (const chanId of [session.voiceChannelId, session.textChannelId, session.infoTextChannelId, session.categoryId]) {
      await safeDeleteChannel(guild.channels.cache.get(chanId));
    }
    db.transaction(() => {
      db.prepare('DELETE FROM lfgSessions    WHERE id        = ?').run(sessionId);
      db.prepare('DELETE FROM lfgJoinedUsers WHERE sessionId = ?').run(sessionId);
    })();
    lfgSessions.delete(sessionId);
    lfgJoinedUsers.delete(sessionId);
    await saveData();
    console.log(`✅ Session ${sessionId} supprimée.`);
  } catch (err) {
    console.error(`⚠️ Erreur suppression session ${sessionId}:`, err.message);
  }
}

// ─── Shared: refresh info + command messages ──────────────────────────────────
async function refreshSessionMessages(sessionId, guild, label = 'Session LFG') {
  const sessionData = lfgSessions.get(sessionId);
  if (!sessionData) return;
  const session     = sessionData.value;
  const joinedUsers = lfgJoinedUsers.get(sessionId)?.value ?? [];

  const commonOpts = {
    sessionId, guildName: guild.name, organizerMention: `<@${session.userId}>`,
    game: session.game, platform: session.platform, activity: session.activity,
    joinedCount: joinedUsers.length, maxPlayers: session.players,
    gametag: session.gametag, description: session.description, twitchUrl: session.twitchUrl ?? null,
  };

  const infoTextChannel = guild.channels.cache.get(session.infoTextChannelId);
  if (infoTextChannel && session.infoMessageId) {
    try {
      const msg = await infoTextChannel.messages.fetch(session.infoMessageId);
      await msg.edit({
        flags: MessageFlags.IsComponentsV2,
        components: [buildSessionContainer({
          ...commonOpts, label,
          participantsMention: joinedUsers.length ? joinedUsers.map(id => `<@${id}>`).join(', ') : 'Aucun',
          includeJoinLeaveButtons: true, includeNavButtons: true,
        })],
        allowedMentions: { parse: [] },
      });
    } catch (err) { console.warn('⚠️ MAJ message info impossible:', err.message); }
  }

  const commandChannel = guild.channels.cache.get(session.commandChannelId);
  if (commandChannel && session.commandChannelMessageId) {
    try {
      const msg = await commandChannel.messages.fetch(session.commandChannelMessageId);
      await msg.edit({
        flags: MessageFlags.IsComponentsV2,
        components: [buildSessionContainer({
          ...commonOpts, label,
          includeJoinLeaveButtons: false, includeNavButtons: true,
        })],
        allowedMentions: { parse: [] },
      });
    } catch (err) { console.warn('⚠️ MAJ message commande impossible:', err.message); }
  }
}

// ─── Load data from DB ────────────────────────────────────────────────────────
async function loadData() {
  try {
    const sessions = db.prepare('SELECT * FROM lfgSessions').all();
    for (const s of sessions) setWithTTL(lfgSessions, s.id, { ...s, timeoutId: null }, CACHE_TTL);
    console.log(`✅ ${sessions.length} session(s) chargée(s).`);

    const users = db.prepare('SELECT sessionId, userId FROM lfgJoinedUsers').all();
    for (const u of users) {
      const ex = lfgJoinedUsers.get(u.sessionId);
      if (!ex) setWithTTL(lfgJoinedUsers, u.sessionId, [u.userId], CACHE_TTL);
      else ex.value.push(u.userId);
    }

    const stats = db.prepare('SELECT totalSessions, totalPlayers FROM lfgStats LIMIT 1').get() ?? { totalSessions: 0, totalPlayers: 0 };
    Object.assign(lfgStats, stats);

    const webhooks = db.prepare('SELECT guildId, game, channelId FROM webhookChannels').all();
    for (const w of webhooks) setWithTTL(webhookChannels, `${w.guildId}:${w.game}`, w.channelId, WEBHOOK_TTL);

    const filters = db.prepare('SELECT guildId, games FROM guildGameFilters').all();
    for (const f of filters) setWithTTL(guildGameFilters, f.guildId, JSON.parse(f.games), FILTER_TTL);

    const cooldowns = db.prepare('SELECT guildId, maxSessions, windowSeconds FROM guildCooldowns').all();
    for (const c of cooldowns) setWithTTL(guildCooldowns, c.guildId, { maxSessions: c.maxSessions, windowSeconds: c.windowSeconds }, COOLDOWN_TTL);
  } catch (err) {
    console.error('⚠️ Erreur chargement données:', err.message);
  }
}

// ─── Slash command registration ───────────────────────────────────────────────
async function registerCommands() {
  const platformChoices = [
    { name: 'PC', value: 'PC' }, { name: 'PlayStation 5', value: 'PlayStation 5' },
    { name: 'PlayStation 4', value: 'PlayStation 4' }, { name: 'Xbox Series X|S', value: 'Xbox Series X|S' },
    { name: 'Xbox One', value: 'Xbox One' }, { name: 'Nintendo Switch', value: 'Nintendo Switch' },
    { name: 'Mobile', value: 'Mobile' }, { name: 'iOS', value: 'iOS' }, { name: 'Android', value: 'Android' },
    { name: 'Crossplay', value: 'Crossplay' }, { name: 'VR', value: 'VR' }, { name: 'Mac', value: 'Mac' }, { name: 'Linux', value: 'Linux' },
  ];

  const activityChoices = [
    { name: 'Normale', value: 'Normale' }, { name: 'Classé', value: 'Classé' }, { name: 'Compétitif', value: 'Compétitif' },
    { name: 'Tournoi', value: 'Tournoi' }, { name: 'Scrim', value: 'Scrim' }, { name: 'Entraînement', value: 'Entraînement' },
    { name: 'Fun', value: 'Fun' }, { name: 'Découverte', value: 'Découverte' }, { name: 'Arcade', value: 'Arcade' },
    { name: 'Coopération', value: 'Coopération' }, { name: 'Speedrun', value: 'Speedrun' },
    { name: 'PvE', value: 'PvE' }, { name: 'PvP', value: 'PvP' }, { name: 'Raids', value: 'Raids' }, { name: 'Dungeons', value: 'Dungeons' },
  ];

  // Reusable session_id option with autocomplete
  const sessionIdOpt = { name: 'session_id', description: 'ID de la session', type: 3, required: true, autocomplete: true };

  const commands = [
    {
      name: 'lfg',
      description: 'Créer une session LFG',
      options: [
        { name: 'jeux',        description: 'Jeu',                                    type: 3, required: true,  choices: gameChoices },
        { name: 'plateforme',  description: 'Plate-forme',                             type: 3, required: true,  choices: platformChoices },
        { name: 'joueurs',     description: 'Nombre de joueurs',                       type: 4, required: true,  min_value: 1, max_value: 10 },
        { name: 'gametag',     description: 'Gametag',                                 type: 3, required: true },
        { name: 'activite',    description: 'Activité',                                type: 3, required: true,  choices: activityChoices },
        { name: 'description', description: 'Description (optionnel)',                 type: 3, required: false },
        { name: 'twitch',      description: 'Pseudo Twitch (optionnel, ex: nuggan85)', type: 3, required: false },
      ],
    },
    {
      name: 'duplicate_lfg',
      description: 'Recréer une session identique à une session existante',
      options: [sessionIdOpt],
    },
    {
      name: 'modify_lfg',
      description: 'Modifier une session LFG',
      options: [
        sessionIdOpt,
        { name: 'joueurs',     description: 'Nombre de joueurs', type: 4, required: false, min_value: 1, max_value: 10 },
        { name: 'description', description: 'Description',       type: 3, required: false },
      ],
    },
    {
      name: 'list_members',
      description: "Lister les membres d'une session LFG",
      options: [sessionIdOpt, { name: 'page', description: 'Page', type: 4, required: false, min_value: 1 }],
    },
    {
      name: 'kick_member',
      description: "Retirer un membre d'une session LFG",
      options: [sessionIdOpt, { name: 'member', description: 'Membre à retirer', type: 6, required: true }],
    },
    {
      name: 'ban_member',
      description: "Bannir un membre d'une session LFG",
      options: [sessionIdOpt, { name: 'member', description: 'Membre à bannir', type: 6, required: true }],
    },
    { name: 'stats',   description: 'Afficher les statistiques des sessions LFG' },
    { name: 'history', description: "Afficher l'historique des sessions LFG" },
    {
      name: 'set_lfg_channel',
      description: 'Définir le salon pour les annonces LFG (par jeu ou par défaut)',
      options: [
        { name: 'channel', description: 'Salon pour les annonces', type: 7, required: true, channel_types: [ChannelType.GuildText] },
        { name: 'jeu', description: 'Jeu spécifique (optionnel — laisser vide pour le salon par défaut)', type: 3, required: false, choices: gameChoices },
      ],
    },
    {
      name: 'remove_lfg_channel',
      description: 'Supprimer un salon LFG configuré (par jeu ou par défaut)',
      options: [
        { name: 'cible', description: 'Entrée à supprimer', type: 3, required: true, autocomplete: true },
      ],
    },
    { name: 'list_lfg_channels', description: 'Afficher la configuration complète des salons LFG par jeu' },
    {
      name: 'set_cooldown',
      description: 'Configurer le cooldown de création de sessions LFG par utilisateur',
      options: [
        { name: 'max_sessions', description: 'Nombre maximum de sessions par fenêtre de temps', type: 4, required: true, min_value: 1, max_value: 20 },
        { name: 'fenetre',      description: 'Fenêtre de temps en minutes',                     type: 4, required: true, min_value: 1, max_value: 1440 },
      ],
    },
    {
      name: 'config',
      description: 'Configurer les jeux acceptés sur ce serveur',
      options: [
        {
          name: 'action', description: 'Action à effectuer', type: 3, required: true,
          choices: [
            { name: 'Ajouter un jeu au filtre',      value: 'add' },
            { name: 'Retirer un jeu du filtre',      value: 'remove' },
            { name: 'Voir la configuration',         value: 'view' },
            { name: 'Réinitialiser (tout accepter)', value: 'reset' },
          ],
        },
        { name: 'jeu', description: 'Jeu à ajouter ou retirer du filtre', type: 3, required: false, choices: gameChoices },
      ],
    },
  ];

  try {
    await client.application.commands.set(commands);
    console.log('✅ Commandes enregistrées.');
  } catch (err) {
    console.error('⚠️ Erreur enregistrement commandes:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Autocomplete
// ─────────────────────────────────────────────────────────────────────────────

async function handleAutocomplete(interaction) {
  const { commandName, options, guild } = interaction;
  const focused = options.getFocused(true);

  if (focused.name === 'session_id') {
    const input   = focused.value.toLowerCase();
    const choices = [];
    for (const [id, data] of lfgSessions) {
      if (data.value.guildId !== guild.id) continue;
      const { game, user } = data.value;
      const label = `#${id} — ${game} (${user})`;
      if (!input || id.includes(input) || label.toLowerCase().includes(input)) {
        choices.push({ name: label.slice(0, 100), value: id });
      }
      if (choices.length >= 25) break;
    }
    return interaction.respond(choices);
  }

  if (focused.name === 'cible' && commandName === 'remove_lfg_channel') {
    const input   = focused.value.toLowerCase();
    const entries = getWebhookEntriesForGuild(guild.id);
    const choices = entries
      .filter(e => {
        const lbl = e.game === '*' ? 'salon par défaut (*)' : e.game.toLowerCase();
        return !input || lbl.includes(input);
      })
      .slice(0, 25)
      .map(e => ({ name: e.game === '*' ? 'Salon par défaut (*)' : e.game, value: e.game }));
    return interaction.respond(choices);
  }

  return interaction.respond([]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Core session creation helper (shared by /lfg and /duplicate_lfg)
// ─────────────────────────────────────────────────────────────────────────────

async function createLFGSession({ interaction, guild, channel, user, game, platform, players, gametag, activity, description, twitchUrl, sessionLabel }) {
  const sessionId = Math.floor(1000 + Math.random() * 9000).toString();

  const category = await guild.channels.create({
    name: `🎮-${sessionId}-LFG`, type: ChannelType.GuildCategory,
    permissionOverwrites: [
      { id: guild.id,       allow: [PermissionFlagsBits.ViewChannel] },
      { id: client.user.id, allow: [PermissionFlagsBits.ManageChannels] },
    ],
  });

  const textChannel = await guild.channels.create({
    name: `📝-${sessionId}-discussion`, type: ChannelType.GuildText, parent: category.id,
    permissionOverwrites: [
      { id: guild.id,       allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
      { id: client.user.id, allow: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages] },
    ],
  });

  await textChannel.send({
    content: `👋 Bienvenue dans le salon de discussion de la session **#${sessionId}** !\n> Organisateur : <@${user.id}>`,
    allowedMentions: { parse: [] },
  });

  const voiceChannel = await guild.channels.create({
    name: `🔊-${sessionId}-LFG`, type: ChannelType.GuildVoice, parent: category.id, userLimit: players + 1,
    permissionOverwrites: [
      { id: guild.id,       allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
      { id: client.user.id, allow: [PermissionFlagsBits.ManageChannels] },
    ],
  });

  const infoTextChannel = await guild.channels.create({
    name: `📢-${sessionId}-info`, type: ChannelType.GuildText, parent: category.id,
    permissionOverwrites: [
      { id: guild.id,       allow: [PermissionFlagsBits.ViewChannel] },
      { id: client.user.id, allow: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages] },
    ],
  });

  const commonOpts = {
    sessionId, guildName: guild.name, organizerMention: `<@${user.id}>`,
    game, platform, activity, joinedCount: 1, maxPlayers: players, gametag, description, twitchUrl,
  };

  const infoMessage = await infoTextChannel.send({
    flags: MessageFlags.IsComponentsV2,
    components: [buildSessionContainer({
      ...commonOpts, label: sessionLabel,
      participantsMention: `<@${user.id}>`,
      includeJoinLeaveButtons: true, includeNavButtons: true,
    })],
    allowedMentions: { parse: [] },
  });

  try { await infoMessage.pin(); } catch {}

  await infoTextChannel.send({
    content: `📢 Salon d'information pour la session **#${sessionId}** — utilisez les boutons ci-dessus.`,
    allowedMentions: { parse: [] },
  });

  const commandChannelMessage = await channel.send({
    flags: MessageFlags.IsComponentsV2,
    components: [buildSessionContainer({
      ...commonOpts, label: sessionLabel,
      includeJoinLeaveButtons: false, includeNavButtons: true,
    })],
    allowedMentions: { parse: [] },
  });

  // Cross-server announcements
  const seenGuildIds = new Set([...webhookChannels.keys()].map(k => k.split(':')[0]));
  for (const gId of seenGuildIds) {
    if (gId === guild.id) continue;
    if (!isGameAllowedForGuild(gId, game)) continue;
    const chId = getWebhookChannelId(gId, game);
    if (!chId) continue;
    try {
      const tg = client.guilds.cache.get(gId);
      const tc = tg?.channels.cache.get(chId);
      if (!tc?.isTextBased()) continue;
      const cc = buildCrossServerContainer({
        sessionId, sourceGuildName: guild.name, sourceGuildId: guild.id,
        voiceChannelId: voiceChannel.id, textChannelId: textChannel.id, infoTextChannelId: infoTextChannel.id,
        organizerMention: `<@${user.id}>`, game, platform, activity,
        joinedCount: 1, maxPlayers: players, gametag, description, twitchUrl,
      });
      const wh = await tc.createWebhook({ name: 'LFG Annonce', avatar: client.user.avatarURL() });
      await wh.send({ components: [cc], flags: MessageFlags.IsComponentsV2, username: client.user.username, avatarURL: client.user.avatarURL(), allowedMentions: { parse: ['users'] } });
      await wh.delete();
    } catch (err) { console.error(`⚠️ Erreur annonce vers ${gId}:`, err.message); }
  }

  const sessionData = {
    userId: user.id, user: user.tag, game, platform, activity, gametag, description, twitchUrl,
    date: new Date().toISOString(), players, categoryId: category.id,
    voiceChannelId: voiceChannel.id, textChannelId: textChannel.id,
    infoTextChannelId: infoTextChannel.id, infoMessageId: infoMessage.id,
    commandChannelId: channel.id, commandChannelMessageId: commandChannelMessage.id,
    timeoutId: null, guildId: guild.id,
  };

  setWithTTL(lfgSessions, sessionId, sessionData, CACHE_TTL);
  setWithTTL(lfgJoinedUsers, sessionId, [user.id], CACHE_TTL);
  lfgStats.totalSessions++;
  lfgStats.totalPlayers += players;
  await saveData();
  if (!voiceChannel.members.size) resetTimeout(sessionId, guild);
  updateRichPresence();

  return { sessionId, textChannel, infoTextChannel };
}

// ─────────────────────────────────────────────────────────────────────────────
// Command handlers
// ─────────────────────────────────────────────────────────────────────────────

async function handleLFGCommand(interaction) {
  const { options, guild, channel, user } = interaction;

  const game        = options.getString('jeux');
  const platform    = options.getString('plateforme');
  const players     = options.getInteger('joueurs');
  const gametag     = options.getString('gametag');
  const activity    = options.getString('activite');
  const description = options.getString('description') ?? 'Pas de description';
  const twitchPseudo = options.getString('twitch');

  let twitchUrl = null;
  if (twitchPseudo) {
    const clean = twitchPseudo.trim().replace(/^@/, '');
    if (!/^[a-zA-Z0-9_]{1,25}$/.test(clean)) {
      return interaction.reply({
        content: '❌ Pseudo Twitch invalide.\n✅ Format attendu : `nuggan85` (lettres, chiffres, underscores, 1-25 caractères)',
        flags: [MessageFlags.Ephemeral],
      });
    }
    twitchUrl = `https://twitch.tv/${clean}`;
  }

  if (!isGameAllowedForGuild(guild.id, game)) {
    const filter = getGuildGameFilter(guild.id);
    return interaction.reply({
      content: `❌ Ce serveur n'accepte pas **${game}**.\n📋 Jeux autorisés : ${filter.map(g => `\`${g}\``).join(', ')}`,
      flags: [MessageFlags.Ephemeral],
    });
  }

  if (!checkUserSessionCooldown(guild.id, user.id)) {
    const { maxSessions, windowSeconds } = getGuildCooldownConfig(guild.id);
    return interaction.reply({
      content: `❌ Limite de **${maxSessions} session(s)** par ${Math.round(windowSeconds / 60)} minute(s) atteinte.`,
      flags: [MessageFlags.Ephemeral],
    });
  }

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  try {
    const { sessionId, textChannel, infoTextChannel } = await createLFGSession({
      interaction, guild, channel, user,
      game, platform, players, gametag, activity, description, twitchUrl,
      sessionLabel: 'Nouvelle session LFG',
    });
    await interaction.followUp({
      content: `✅ Session **#${sessionId}** créée !\n> 💬 ${textChannel} · 📢 ${infoTextChannel}`,
      flags: [MessageFlags.Ephemeral],
    });
  } catch (err) {
    console.error('⚠️ Erreur création LFG:', err);
    const msg = '❌ Erreur lors de la création de la session.';
    if (interaction.deferred || interaction.replied) await interaction.followUp({ content: msg, flags: [MessageFlags.Ephemeral] });
    else await interaction.reply({ content: msg, flags: [MessageFlags.Ephemeral] });
  }
}

// ──────────────────────────────────────────────────────────────────────────────

async function handleDuplicateLFGCommand(interaction) {
  const { options, guild, channel, user } = interaction;
  const sourceId   = options.getString('session_id');
  const sourceData = lfgSessions.get(sourceId);

  if (!sourceData) return interaction.reply({ content: `❌ Session **#${sourceId}** introuvable.`, flags: [MessageFlags.Ephemeral] });

  if (!checkUserSessionCooldown(guild.id, user.id)) {
    const { maxSessions, windowSeconds } = getGuildCooldownConfig(guild.id);
    return interaction.reply({
      content: `❌ Limite de **${maxSessions} session(s)** par ${Math.round(windowSeconds / 60)} minute(s) atteinte.`,
      flags: [MessageFlags.Ephemeral],
    });
  }

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  try {
    const s = sourceData.value;
    const { sessionId, textChannel, infoTextChannel } = await createLFGSession({
      interaction, guild, channel, user,
      game: s.game, platform: s.platform, players: s.players,
      gametag: s.gametag, activity: s.activity, description: s.description,
      twitchUrl: s.twitchUrl ?? null,
      sessionLabel: '🔁 Session dupliquée',
    });
    await interaction.followUp({
      content: `✅ Session **#${sessionId}** créée *(dupliquée depuis #${sourceId})* !\n> 💬 ${textChannel} · 📢 ${infoTextChannel}`,
      flags: [MessageFlags.Ephemeral],
    });
  } catch (err) {
    console.error('⚠️ Erreur duplication LFG:', err);
    const msg = '❌ Erreur lors de la duplication de la session.';
    if (interaction.deferred || interaction.replied) await interaction.followUp({ content: msg, flags: [MessageFlags.Ephemeral] });
    else await interaction.reply({ content: msg, flags: [MessageFlags.Ephemeral] });
  }
}

// ──────────────────────────────────────────────────────────────────────────────

async function handleModifyLFGCommand(interaction) {
  const { options, member, guild } = interaction;
  const sessionId  = options.getString('session_id');
  const newPlayers = options.getInteger('joueurs');
  const newDesc    = options.getString('description');

  if (!member.permissions.has(PermissionFlagsBits.ManageChannels))
    return interaction.reply({ content: '❌ Permission insuffisante.', flags: [MessageFlags.Ephemeral] });
  if (!newPlayers && !newDesc)
    return interaction.reply({ content: '❌ Fournissez au moins un champ à modifier.', flags: [MessageFlags.Ephemeral] });

  const sessionData = lfgSessions.get(sessionId);
  if (!sessionData) return interaction.reply({ content: `❌ Session **#${sessionId}** introuvable.`, flags: [MessageFlags.Ephemeral] });

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  try {
    const session = { ...sessionData.value };
    if (newPlayers) {
      const vc = guild.channels.cache.get(session.voiceChannelId);
      if (vc) await vc.edit({ userLimit: newPlayers + 1 });
      lfgStats.totalPlayers = lfgStats.totalPlayers - session.players + newPlayers;
      session.players = newPlayers;
    }
    if (newDesc) session.description = newDesc;
    setWithTTL(lfgSessions, sessionId, session, CACHE_TTL);
    await refreshSessionMessages(sessionId, guild, 'Session LFG modifiée');
    await saveData();
    await interaction.followUp({ content: `✅ Session **#${sessionId}** modifiée.`, flags: [MessageFlags.Ephemeral] });
    updateRichPresence();
  } catch (err) {
    console.error('⚠️ Erreur modification LFG:', err);
    const msg = '❌ Erreur modification session.';
    if (interaction.deferred || interaction.replied) await interaction.followUp({ content: msg, flags: [MessageFlags.Ephemeral] });
    else await interaction.reply({ content: msg, flags: [MessageFlags.Ephemeral] });
  }
}

// ──────────────────────────────────────────────────────────────────────────────

async function handleListMembersCommand(interaction) {
  const sessionId = interaction.options.getString('session_id');
  const page      = interaction.options.getInteger('page') ?? 1;
  const sessionData = lfgSessions.get(sessionId);
  if (!sessionData) return interaction.reply({ content: `❌ Session **#${sessionId}** introuvable.`, flags: [MessageFlags.Ephemeral] });

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  try {
    const session    = sessionData.value;
    const vc         = interaction.guild.channels.cache.get(session.voiceChannelId);
    const members    = vc?.members.map(m => m.user.tag) ?? [];
    const start      = (page - 1) * ITEMS_PER_PAGE;
    const pageItems  = members.slice(start, start + ITEMS_PER_PAGE);
    const totalPages = Math.max(1, Math.ceil(members.length / ITEMS_PER_PAGE));
    const joinedData = lfgJoinedUsers.get(sessionId)?.value ?? [];

    const thumbnail = new ThumbnailBuilder({ media: { url: interaction.guild.iconURL({ dynamic: true }) ?? 'https://i.imgur.com/Xo1BHdr.png' } });
    const headerSection = new SectionBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`👥 **Membres de la session**`))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`\`🆔 Session #${sessionId}\``))
      .setThumbnailAccessory(thumbnail);

    const memberList = pageItems.length ? pageItems.map((tag, i) => `\`${start + i + 1}.\` ${tag}`).join('\n') : '_Aucun membre dans le salon vocal_';

    const container = new ContainerBuilder()
      .addSectionComponents(headerSection)
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`🔊 **Dans le vocal :**\n${memberList}`))
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`📋 **Inscrits :** ${joinedData.length}/${session.players}  ·  🔊 **En vocal :** ${members.length}`))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# Page ${page}/${totalPages}  ·  ${interaction.guild.name}  ·  /lfg  /stats  /history`))
      .setAccentColor(0x1E90FF);

    await interaction.followUp({ components: [container], flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral] });
  } catch (err) {
    console.error('⚠️ Erreur liste membres:', err);
    await interaction.followUp({ content: '❌ Erreur affichage membres.', flags: [MessageFlags.Ephemeral] });
  }
}

// ──────────────────────────────────────────────────────────────────────────────

async function handleKickMemberCommand(interaction) {
  const { options, guild, user } = interaction;
  const sessionId    = options.getString('session_id');
  const targetMember = options.getMember('member');
  const sessionData  = lfgSessions.get(sessionId);
  if (!sessionData) return interaction.reply({ content: `❌ Session **#${sessionId}** introuvable.`, flags: [MessageFlags.Ephemeral] });
  const session = sessionData.value;
  if (user.id !== session.userId) return interaction.reply({ content: '❌ Seuls les organisateurs peuvent retirer des membres.', flags: [MessageFlags.Ephemeral] });

  try {
    const vc = guild.channels.cache.get(session.voiceChannelId);
    if (!vc || targetMember.voice.channelId !== vc.id) return interaction.reply({ content: `❌ ${targetMember.user.tag} n'est pas dans le salon vocal.`, flags: [MessageFlags.Ephemeral] });
    await targetMember.voice.disconnect();
    db.prepare('DELETE FROM lfgJoinedUsers WHERE sessionId = ? AND userId = ?').run(sessionId, targetMember.id);
    const jud = lfgJoinedUsers.get(sessionId);
    if (jud) setWithTTL(lfgJoinedUsers, sessionId, jud.value.filter(id => id !== targetMember.id), CACHE_TTL);
    await saveData();
    await interaction.reply({ content: `✅ **${targetMember.user.tag}** retiré de la session **#${sessionId}**.`, flags: [MessageFlags.Ephemeral] });
    updateRichPresence();
  } catch (err) {
    console.error('⚠️ Erreur kick membre:', err);
    const msg = '❌ Erreur retrait membre.';
    if (interaction.replied || interaction.deferred) await interaction.followUp({ content: msg, flags: [MessageFlags.Ephemeral] });
    else await interaction.reply({ content: msg, flags: [MessageFlags.Ephemeral] });
  }
}

// ──────────────────────────────────────────────────────────────────────────────

async function handleBanMemberCommand(interaction) {
  const { options, guild, user } = interaction;
  const sessionId    = options.getString('session_id');
  const targetMember = options.getMember('member');
  const sessionData  = lfgSessions.get(sessionId);
  if (!sessionData) return interaction.reply({ content: `❌ Session **#${sessionId}** introuvable.`, flags: [MessageFlags.Ephemeral] });
  const session = sessionData.value;
  if (user.id !== session.userId) return interaction.reply({ content: '❌ Seuls les organisateurs peuvent bannir des membres.', flags: [MessageFlags.Ephemeral] });

  try {
    const vc = guild.channels.cache.get(session.voiceChannelId);
    if (!vc || targetMember.voice.channelId !== vc.id) return interaction.reply({ content: `❌ ${targetMember.user.tag} n'est pas dans le salon vocal.`, flags: [MessageFlags.Ephemeral] });
    await targetMember.voice.disconnect();
    await guild.members.ban(targetMember, { reason: `Banni de la session LFG ${sessionId}` });
    db.prepare('DELETE FROM lfgJoinedUsers WHERE sessionId = ? AND userId = ?').run(sessionId, targetMember.id);
    const jud = lfgJoinedUsers.get(sessionId);
    if (jud) setWithTTL(lfgJoinedUsers, sessionId, jud.value.filter(id => id !== targetMember.id), CACHE_TTL);
    await saveData();
    await interaction.reply({ content: `✅ **${targetMember.user.tag}** banni de la session **#${sessionId}**.`, flags: [MessageFlags.Ephemeral] });
    updateRichPresence();
  } catch (err) {
    console.error('⚠️ Erreur ban membre:', err);
    const msg = '❌ Erreur bannissement membre.';
    if (interaction.replied || interaction.deferred) await interaction.followUp({ content: msg, flags: [MessageFlags.Ephemeral] });
    else await interaction.reply({ content: msg, flags: [MessageFlags.Ephemeral] });
  }
}

// ──────────────────────────────────────────────────────────────────────────────

async function handleStatsCommand(interaction) {
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  try {
    const activePlayers = Array.from(lfgJoinedUsers.values()).reduce((acc, d) => acc + (d.value?.length ?? 0), 0);
    const { maxSessions, windowSeconds } = getGuildCooldownConfig(interaction.guild.id);

    const thumbnail = new ThumbnailBuilder({ media: { url: interaction.guild.iconURL({ dynamic: true }) ?? 'https://i.imgur.com/Xo1BHdr.png' } });
    const headerSection = new SectionBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`📊 **Statistiques LFG**`))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(interaction.guild.name))
      .setThumbnailAccessory(thumbnail);

    const container = new ContainerBuilder()
      .addSectionComponents(headerSection)
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`🗂️ **Sessions créées :** ${lfgStats.totalSessions}`))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`👥 **Joueurs totaux :** ${lfgStats.totalPlayers}`))
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`🟢 **Sessions actives :** ${lfgSessions.size}`))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`🎮 **Joueurs en session :** ${activePlayers}`))
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`⏱️ **Cooldown :** ${maxSessions} session(s) par ${Math.round(windowSeconds / 60)} min`))
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${interaction.guild.name}  ·  /lfg  /stats  /history`))
      .setAccentColor(0x1E90FF);

    await interaction.followUp({ components: [container], flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral] });
  } catch (err) {
    console.error('⚠️ Erreur stats:', err);
    await interaction.followUp({ content: '❌ Erreur affichage stats.', flags: [MessageFlags.Ephemeral] });
  }
}

// ──────────────────────────────────────────────────────────────────────────────

const historyPages = new Map();

async function sendHistoryEmbed(interaction, page, isUpdate = false) {
  const sessions   = Array.from(lfgSessions.entries()).map(([id, d]) => ({ id, ...d.value }));
  const totalPages = Math.max(1, Math.ceil(sessions.length / ITEMS_PER_PAGE));
  const safePage   = Math.min(Math.max(1, page), totalPages);
  const start      = (safePage - 1) * ITEMS_PER_PAGE;
  const pageItems  = sessions.slice(start, start + ITEMS_PER_PAGE);

  const thumbnail = new ThumbnailBuilder({ media: { url: client.user.avatarURL({ dynamic: true }) ?? 'https://i.imgur.com/Xo1BHdr.png' } });
  const headerSection = new SectionBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`📜 **Historique des sessions**`))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(interaction.guild.name))
    .setThumbnailAccessory(thumbnail);

  const historyLines = pageItems.length
    ? pageItems.map(({ id, game, user, date }) => `\`#${id}\` **${game}** · ${user} · <t:${Math.floor(new Date(date).getTime() / 1000)}:R>`).join('\n')
    : "_Aucune session dans l'historique._";

  const prevBtn = new ButtonBuilder().setCustomId(`history_prev_${interaction.user.id}`).setLabel('◀ Retour').setStyle(ButtonStyle.Secondary).setDisabled(safePage <= 1);
  const pageBtn = new ButtonBuilder().setCustomId('history_page_noop').setLabel(`Page ${safePage} / ${totalPages}`).setStyle(ButtonStyle.Secondary).setDisabled(true);
  const nextBtn = new ButtonBuilder().setCustomId(`history_next_${interaction.user.id}`).setLabel('Suivant ▶').setStyle(ButtonStyle.Secondary).setDisabled(safePage >= totalPages);

  const container = new ContainerBuilder()
    .addSectionComponents(headerSection)
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(historyLines))
    .addSeparatorComponents(new SeparatorBuilder())
    .addActionRowComponents(new ActionRowBuilder().addComponents(prevBtn, pageBtn, nextBtn))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${sessions.length} session(s) au total  ·  ${interaction.guild.name}  ·  /lfg  /stats  /history`))
    .setAccentColor(0x1E90FF);

  const payload = { components: [container], flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral] };
  if (isUpdate) await interaction.update(payload);
  else await interaction.followUp(payload);
}

async function handleHistoryCommand(interaction) {
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  try {
    historyPages.set(interaction.user.id, 1);
    await sendHistoryEmbed(interaction, 1, false);
  } catch (err) {
    console.error('⚠️ Erreur historique:', err);
    await interaction.followUp({ content: '❌ Erreur affichage historique.', flags: [MessageFlags.Ephemeral] });
  }
}

// ──────────────────────────────────────────────────────────────────────────────

async function handleSetLFGChannelCommand(interaction) {
  const { options, guild, member } = interaction;
  if (!member.permissions.has(PermissionFlagsBits.ManageChannels))
    return interaction.reply({ content: '❌ Permission insuffisante.', flags: [MessageFlags.Ephemeral] });

  const channel = options.getChannel('channel');
  const game    = options.getString('jeu') ?? '*';

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  try {
    setWithTTL(webhookChannels, `${guild.id}:${game}`, channel.id, WEBHOOK_TTL);
    db.prepare('INSERT OR REPLACE INTO webhookChannels (guildId, game, channelId) VALUES (?, ?, ?)').run(guild.id, game, channel.id);
    const label = game === '*' ? '**tous les jeux** *(salon par défaut)*' : `**${game}**`;
    await interaction.followUp({ content: `✅ Salon ${channel} défini pour ${label}.`, flags: [MessageFlags.Ephemeral] });
  } catch (err) {
    console.error('⚠️ Erreur set_lfg_channel:', err);
    await interaction.followUp({ content: '❌ Erreur définition salon.', flags: [MessageFlags.Ephemeral] });
  }
}

// ──────────────────────────────────────────────────────────────────────────────

async function handleRemoveLFGChannelCommand(interaction) {
  const { options, guild, member } = interaction;
  if (!member.permissions.has(PermissionFlagsBits.ManageChannels))
    return interaction.reply({ content: '❌ Permission insuffisante.', flags: [MessageFlags.Ephemeral] });

  const game = options.getString('cible');
  const key  = `${guild.id}:${game}`;

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  try {
    const inCache = webhookChannels.has(key);
    const inDB    = db.prepare('SELECT channelId FROM webhookChannels WHERE guildId = ? AND game = ?').get(guild.id, game);
    if (!inCache && !inDB) {
      return interaction.followUp({
        content: `❌ Aucun salon configuré pour **${game === '*' ? 'le défaut' : game}**.`,
        flags: [MessageFlags.Ephemeral],
      });
    }
    webhookChannels.delete(key);
    db.prepare('DELETE FROM webhookChannels WHERE guildId = ? AND game = ?').run(guild.id, game);
    const label = game === '*' ? '**le salon par défaut**' : `**${game}**`;
    await interaction.followUp({ content: `✅ Configuration supprimée pour ${label}.`, flags: [MessageFlags.Ephemeral] });
  } catch (err) {
    console.error('⚠️ Erreur remove_lfg_channel:', err);
    await interaction.followUp({ content: '❌ Erreur suppression salon.', flags: [MessageFlags.Ephemeral] });
  }
}

// ──────────────────────────────────────────────────────────────────────────────

async function handleListLFGChannelsCommand(interaction) {
  const { guild, member } = interaction;
  if (!member.permissions.has(PermissionFlagsBits.ManageChannels))
    return interaction.reply({ content: '❌ Permission insuffisante.', flags: [MessageFlags.Ephemeral] });

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  try {
    const entries = getWebhookEntriesForGuild(guild.id);
    const thumbnail = new ThumbnailBuilder({ media: { url: guild.iconURL({ dynamic: true }) ?? 'https://i.imgur.com/Xo1BHdr.png' } });
    const headerSection = new SectionBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`📡 **Salons LFG — Configuration cross-serveur**`))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(guild.name))
      .setThumbnailAccessory(thumbnail);

    const container = new ContainerBuilder().addSectionComponents(headerSection);

    if (entries.length === 0) {
      container
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          `_Aucun salon configuré._\n\n` +
          `• \`/set_lfg_channel #salon\` — salon par défaut\n` +
          `• \`/set_lfg_channel #salon jeu:Valorant\` — salon par jeu`
        ));
    } else {
      const defaultEntry = entries.find(e => e.game === '*');
      const gameEntries  = entries.filter(e => e.game !== '*').sort((a, b) => a.game.localeCompare(b.game));

      container.addSeparatorComponents(new SeparatorBuilder());

      const defCh = defaultEntry ? guild.channels.cache.get(defaultEntry.channelId) : null;
      if (defaultEntry) {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
          `🌐 **Salon par défaut** *(tous les jeux non configurés)*\n> ${defCh ? `<#${defaultEntry.channelId}>` : `\`${defaultEntry.channelId}\` *(introuvable)*`}`
        ));
      } else {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
          `🌐 **Salon par défaut** — _non configuré_\n> Les jeux sans salon spécifique ne seront pas annoncés.`
        ));
      }

      container.addSeparatorComponents(new SeparatorBuilder());
      if (gameEntries.length > 0) {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`🎮 **Salons par jeu** *(${gameEntries.length} configuré${gameEntries.length > 1 ? 's' : ''})*`));
        for (let i = 0; i < gameEntries.length; i += 10) {
          const lines = gameEntries.slice(i, i + 10).map(e => {
            const ch = guild.channels.cache.get(e.channelId);
            return `• **${e.game}** → ${ch ? `<#${e.channelId}>` : `\`${e.channelId}\` *(introuvable)*`}`;
          }).join('\n');
          container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines));
        }
      } else {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
          `🎮 **Salons par jeu** — _aucun salon spécifique_\n> Toutes les annonces utilisent le salon par défaut.`
        ));
      }

      container
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          `📋 **Récapitulatif :** ${entries.length} salon${entries.length > 1 ? 's' : ''} configuré${entries.length > 1 ? 's' : ''} ` +
          `(${gameEntries.length} par jeu + ${defaultEntry ? '1' : '0'} par défaut)`
        ));
    }

    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `💡 \`/set_lfg_channel\` · \`/remove_lfg_channel\` · \`/list_lfg_channels\``
      ))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${guild.name}  ·  /set_lfg_channel  /remove_lfg_channel  /config`))
      .setAccentColor(0x1E90FF);

    await interaction.followUp({ components: [container], flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral] });
  } catch (err) {
    console.error('⚠️ Erreur list_lfg_channels:', err);
    await interaction.followUp({ content: '❌ Erreur affichage configuration.', flags: [MessageFlags.Ephemeral] });
  }
}

// ──────────────────────────────────────────────────────────────────────────────

async function handleSetCooldownCommand(interaction) {
  const { options, guild, member } = interaction;
  if (!member.permissions.has(PermissionFlagsBits.ManageGuild))
    return interaction.reply({ content: '❌ Permission **Gérer le serveur** requise.', flags: [MessageFlags.Ephemeral] });

  const maxSessions   = options.getInteger('max_sessions');
  const fenetreMin    = options.getInteger('fenetre');
  const windowSeconds = fenetreMin * 60;

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  try {
    setWithTTL(guildCooldowns, guild.id, { maxSessions, windowSeconds }, COOLDOWN_TTL);
    db.prepare('INSERT OR REPLACE INTO guildCooldowns (guildId, maxSessions, windowSeconds) VALUES (?, ?, ?)').run(guild.id, maxSessions, windowSeconds);

    const thumbnail = new ThumbnailBuilder({ media: { url: guild.iconURL({ dynamic: true }) ?? 'https://i.imgur.com/Xo1BHdr.png' } });
    const headerSection = new SectionBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`⏱️ **Cooldown LFG configuré**`))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(guild.name))
      .setThumbnailAccessory(thumbnail);

    const container = new ContainerBuilder()
      .addSectionComponents(headerSection)
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`✅ Nouveau cooldown appliqué :`))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`• **${maxSessions}** session(s) maximum par utilisateur`))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`• Fenêtre de **${fenetreMin}** minute(s)`))
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${guild.name}  ·  /set_cooldown  /stats`))
      .setAccentColor(0x1E90FF);

    await interaction.followUp({ components: [container], flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral] });
  } catch (err) {
    console.error('⚠️ Erreur set_cooldown:', err);
    await interaction.followUp({ content: '❌ Erreur configuration cooldown.', flags: [MessageFlags.Ephemeral] });
  }
}

// ──────────────────────────────────────────────────────────────────────────────

async function handleConfigCommand(interaction) {
  const { options, member, guild } = interaction;
  if (!member.permissions.has(PermissionFlagsBits.ManageGuild))
    return interaction.reply({ content: '❌ Permission **Gérer le serveur** requise.', flags: [MessageFlags.Ephemeral] });

  const action = options.getString('action');
  const game   = options.getString('jeu');
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  try {
    let currentFilter = [...getGuildGameFilter(guild.id)];

    switch (action) {
      case 'add': {
        if (!game) return interaction.followUp({ content: '❌ Spécifiez un jeu à ajouter.', flags: [MessageFlags.Ephemeral] });
        if (currentFilter.includes(game)) return interaction.followUp({ content: `⚠️ **${game}** est déjà dans le filtre.`, flags: [MessageFlags.Ephemeral] });
        currentFilter.push(game);
        setWithTTL(guildGameFilters, guild.id, currentFilter, FILTER_TTL);
        db.prepare('INSERT OR REPLACE INTO guildGameFilters (guildId, games) VALUES (?, ?)').run(guild.id, JSON.stringify(currentFilter));
        return interaction.followUp({ components: [buildConfigContainer(guild, currentFilter, `✅ **${game}** ajouté.`)], flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral] });
      }
      case 'remove': {
        if (!game) return interaction.followUp({ content: '❌ Spécifiez un jeu à retirer.', flags: [MessageFlags.Ephemeral] });
        if (!currentFilter.includes(game)) return interaction.followUp({ content: `⚠️ **${game}** n'est pas dans le filtre.`, flags: [MessageFlags.Ephemeral] });
        currentFilter = currentFilter.filter(g => g !== game);
        setWithTTL(guildGameFilters, guild.id, currentFilter, FILTER_TTL);
        db.prepare('INSERT OR REPLACE INTO guildGameFilters (guildId, games) VALUES (?, ?)').run(guild.id, JSON.stringify(currentFilter));
        return interaction.followUp({ components: [buildConfigContainer(guild, currentFilter, `✅ **${game}** retiré.`)], flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral] });
      }
      case 'reset': {
        setWithTTL(guildGameFilters, guild.id, [], FILTER_TTL);
        db.prepare('INSERT OR REPLACE INTO guildGameFilters (guildId, games) VALUES (?, ?)').run(guild.id, '[]');
        return interaction.followUp({ components: [buildConfigContainer(guild, [], '✅ Filtre réinitialisé — tous les jeux acceptés.')], flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral] });
      }
      default:
        return interaction.followUp({ components: [buildConfigContainer(guild, currentFilter, null)], flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral] });
    }
  } catch (err) {
    console.error('⚠️ Erreur config:', err);
    await interaction.followUp({ content: '❌ Erreur configuration.', flags: [MessageFlags.Ephemeral] });
  }
}

function buildConfigContainer(guild, filter, statusMessage) {
  const thumbnail = new ThumbnailBuilder({ media: { url: guild.iconURL({ dynamic: true }) ?? 'https://i.imgur.com/Xo1BHdr.png' } });
  const headerSection = new SectionBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`⚙️ **Configuration LFG**`))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(guild.name))
    .setThumbnailAccessory(thumbnail);

  const container = new ContainerBuilder().addSectionComponents(headerSection);
  if (statusMessage) container.addSeparatorComponents(new SeparatorBuilder()).addTextDisplayComponents(new TextDisplayBuilder().setContent(statusMessage));

  container
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      filter.length === 0 ? '🌐 **Mode :** Tous les jeux acceptés *(aucun filtre)*' : `🔒 **Mode :** Filtre actif — **${filter.length}** jeu(x) autorisé(s)`
    ))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`📋 **Jeux autorisés :**\n${filter.length === 0 ? '_Aucun filtre. Toutes les sessions sont acceptées._' : filter.map(g => `• ${g}`).join('\n')}`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      '💡 `/config action:Ajouter jeu:X` · `/config action:Retirer jeu:X` · `/config action:Réinitialiser`'
    ))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${guild.name}  ·  /config  /lfg  /stats`))
    .setAccentColor(0x1E90FF);

  return container;
}

// ─────────────────────────────────────────────────────────────────────────────
// Button handlers
// ─────────────────────────────────────────────────────────────────────────────

async function handleJoinButton(interaction, sessionId) {
  const sessionData = lfgSessions.get(sessionId);
  if (!sessionData) return interaction.reply({ content: `❌ Session **#${sessionId}** introuvable.`, flags: [MessageFlags.Ephemeral] });

  const session     = sessionData.value;
  const jud         = lfgJoinedUsers.get(sessionId);
  const joinedUsers = jud ? [...jud.value] : [];

  if (joinedUsers.includes(interaction.user.id)) return interaction.reply({ content: '❌ Vous avez déjà rejoint cette session.', flags: [MessageFlags.Ephemeral] });
  if (joinedUsers.length >= session.players) return interaction.reply({ content: '❌ Cette session est complète.', flags: [MessageFlags.Ephemeral] });

  const vc = interaction.guild.channels.cache.get(session.voiceChannelId);
  if (!vc) return interaction.reply({ content: '❌ Salon vocal introuvable.', flags: [MessageFlags.Ephemeral] });

  try {
    joinedUsers.push(interaction.user.id);
    setWithTTL(lfgJoinedUsers, sessionId, joinedUsers, CACHE_TTL);
    db.prepare('INSERT OR REPLACE INTO lfgJoinedUsers (sessionId, userId) VALUES (?, ?)').run(sessionId, interaction.user.id);
    await saveData();
    await refreshSessionMessages(sessionId, interaction.guild, 'Nouvelle session LFG');
    await interaction.reply({ content: `✅ Session **#${sessionId}** rejointe ! Rejoignez : ${vc}`, flags: [MessageFlags.Ephemeral] });
    updateRichPresence();
  } catch (err) {
    console.error('⚠️ Erreur rejoindre LFG:', err);
    const msg = '❌ Erreur lors de la tentative de rejoindre la session.';
    if (interaction.replied || interaction.deferred) await interaction.followUp({ content: msg, flags: [MessageFlags.Ephemeral] });
    else await interaction.reply({ content: msg, flags: [MessageFlags.Ephemeral] });
  }
}

async function handleLeaveButton(interaction, sessionId) {
  const sessionData = lfgSessions.get(sessionId);
  if (!sessionData) return interaction.reply({ content: `❌ Session **#${sessionId}** introuvable.`, flags: [MessageFlags.Ephemeral] });

  const session     = sessionData.value;
  const jud         = lfgJoinedUsers.get(sessionId);
  const joinedUsers = jud ? [...jud.value] : [];

  if (!joinedUsers.includes(interaction.user.id)) return interaction.reply({ content: "❌ Vous n'êtes pas inscrit à cette session.", flags: [MessageFlags.Ephemeral] });
  if (interaction.user.id === session.userId) return interaction.reply({ content: "❌ L'organisateur ne peut pas se retirer. Supprimez la session si nécessaire.", flags: [MessageFlags.Ephemeral] });

  try {
    const updated = joinedUsers.filter(id => id !== interaction.user.id);
    setWithTTL(lfgJoinedUsers, sessionId, updated, CACHE_TTL);
    db.prepare('DELETE FROM lfgJoinedUsers WHERE sessionId = ? AND userId = ?').run(sessionId, interaction.user.id);

    // Disconnect from voice if in the session's channel
    const member = interaction.guild.members.cache.get(interaction.user.id);
    const vc     = interaction.guild.channels.cache.get(session.voiceChannelId);
    if (member?.voice.channelId === vc?.id) { try { await member.voice.disconnect(); } catch {} }

    await saveData();
    await refreshSessionMessages(sessionId, interaction.guild, 'Nouvelle session LFG');
    await interaction.reply({ content: `✅ Vous vous êtes retiré de la session **#${sessionId}**.`, flags: [MessageFlags.Ephemeral] });
    updateRichPresence();
  } catch (err) {
    console.error('⚠️ Erreur retrait LFG:', err);
    const msg = '❌ Erreur lors du retrait de la session.';
    if (interaction.replied || interaction.deferred) await interaction.followUp({ content: msg, flags: [MessageFlags.Ephemeral] });
    else await interaction.reply({ content: msg, flags: [MessageFlags.Ephemeral] });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) return handleAutocomplete(interaction);
  if (!interaction.isCommand() && !interaction.isButton()) return;

  if (!checkRateLimit(interaction.user.id)) {
    if (!interaction.replied && !interaction.deferred)
      return interaction.reply({ content: '❌ Limite de débit atteinte. Attendez un moment.', flags: [MessageFlags.Ephemeral] });
    return;
  }

  if (interaction.isCommand()) {
    switch (interaction.commandName) {
      case 'lfg':                return handleLFGCommand(interaction);
      case 'duplicate_lfg':      return handleDuplicateLFGCommand(interaction);
      case 'modify_lfg':         return handleModifyLFGCommand(interaction);
      case 'list_members':       return handleListMembersCommand(interaction);
      case 'kick_member':        return handleKickMemberCommand(interaction);
      case 'ban_member':         return handleBanMemberCommand(interaction);
      case 'stats':              return handleStatsCommand(interaction);
      case 'history':            return handleHistoryCommand(interaction);
      case 'set_lfg_channel':    return handleSetLFGChannelCommand(interaction);
      case 'remove_lfg_channel': return handleRemoveLFGChannelCommand(interaction);
      case 'list_lfg_channels':  return handleListLFGChannelsCommand(interaction);
      case 'set_cooldown':       return handleSetCooldownCommand(interaction);
      case 'config':             return handleConfigCommand(interaction);
      default:
        if (!interaction.replied && !interaction.deferred)
          await interaction.reply({ content: '❌ Commande inconnue.', flags: [MessageFlags.Ephemeral] });
    }
    return;
  }

  if (interaction.isButton()) {
    // Cross-server nav
    if (interaction.customId.startsWith('xvocal_') || interaction.customId.startsWith('xtexte_') || interaction.customId.startsWith('xinfo_')) {
      const parts   = interaction.customId.split('_');
      const xtype   = parts[0], guildId = parts[1], channelId = parts[2];
      const sg      = client.guilds.cache.get(guildId);
      const sc      = sg?.channels.cache.get(channelId);
      if (!sg || !sc) return interaction.reply({ content: `❌ Session introuvable ou expirée.`, flags: [MessageFlags.Ephemeral] });
      const labelMap = { xvocal: { emoji: '🔊', label: 'Rejoignez le vocal' }, xtexte: { emoji: '💬', label: 'Salon discussion' }, xinfo: { emoji: '📢', label: "Salon d'information" } };
      const { emoji, label } = labelMap[xtype] ?? { emoji: '🔗', label: 'Salon' };
      return interaction.reply({ content: `${emoji} ${label} → **[${sc.name}](https://discord.com/channels/${guildId}/${channelId})**`, flags: [MessageFlags.Ephemeral] });
    }

    // History pagination
    if (interaction.customId.startsWith('history_prev_') || interaction.customId.startsWith('history_next_')) {
      const parts     = interaction.customId.split('_');
      const direction = parts[1], ownerId = parts[2];
      if (interaction.user.id !== ownerId) return interaction.reply({ content: '❌ Cet historique ne vous appartient pas.', flags: [MessageFlags.Ephemeral] });
      const currentPage = historyPages.get(ownerId) ?? 1;
      const newPage     = direction === 'prev' ? currentPage - 1 : currentPage + 1;
      historyPages.set(ownerId, newPage);
      try { await sendHistoryEmbed(interaction, newPage, true); } catch (err) {
        console.error('⚠️ Erreur pagination historique:', err);
        if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: '❌ Erreur pagination.', flags: [MessageFlags.Ephemeral] });
      }
      return;
    }

    if (interaction.customId === 'history_page_noop') return interaction.reply({ content: '​', flags: [MessageFlags.Ephemeral] });

    // Session buttons — parse type and sessionId robustly
    const underscoreIdx = interaction.customId.indexOf('_');
    const type          = interaction.customId.slice(0, underscoreIdx);
    const sessionId     = interaction.customId.slice(underscoreIdx + 1);

    if (type === 'join')  return handleJoinButton(interaction, sessionId);
    if (type === 'leave') return handleLeaveButton(interaction, sessionId);

    const sessionData = lfgSessions.get(sessionId);
    if (!sessionData) {
      if (!interaction.replied && !interaction.deferred)
        return interaction.reply({ content: `❌ Session **#${sessionId}** introuvable. Elle a peut-être expiré.`, flags: [MessageFlags.Ephemeral] });
      return;
    }
    const session = sessionData.value;

    switch (type) {
      case 'vocal': {
        const vc = client.guilds.cache.get(session.guildId)?.channels.cache.get(session.voiceChannelId);
        return interaction.reply({ content: vc ? `🔊 Vocal → **[${vc.name}](https://discord.com/channels/${session.guildId}/${vc.id})**` : '❌ Salon vocal introuvable.', flags: [MessageFlags.Ephemeral] });
      }
      case 'texte': {
        const tc = client.guilds.cache.get(session.guildId)?.channels.cache.get(session.textChannelId);
        return interaction.reply({ content: tc ? `💬 Discussion → **[${tc.name}](https://discord.com/channels/${session.guildId}/${tc.id})**` : '❌ Salon discussion introuvable.', flags: [MessageFlags.Ephemeral] });
      }
      case 'info': {
        const ic = client.guilds.cache.get(session.guildId)?.channels.cache.get(session.infoTextChannelId);
        return interaction.reply({ content: ic ? `📢 Infos → **[${ic.name}](https://discord.com/channels/${session.guildId}/${ic.id})**` : "❌ Salon d'information introuvable.", flags: [MessageFlags.Ephemeral] });
      }
      default:
        return interaction.reply({ content: '❌ Bouton inconnu.', flags: [MessageFlags.Ephemeral] });
    }
  }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const entry = Array.from(lfgSessions.entries()).find(([, d]) =>
    d.value.voiceChannelId === oldState.channelId || d.value.voiceChannelId === newState.channelId
  );
  if (entry) resetTimeout(entry[0], newState.guild);
});

client.once(Events.ClientReady, async () => {
  console.log(`✅ Connecté : ${client.user.tag}`);
  await loadData();

  for (const [sessionId, data] of lfgSessions) {
    const session = data.value;
    const guild   = client.guilds.cache.get(session.guildId);
    if (!guild) { console.log(`⚠️ Serveur ${session.guildId} introuvable, suppression ${sessionId}`); lfgSessions.delete(sessionId); lfgJoinedUsers.delete(sessionId); continue; }
    const vc = guild.channels.cache.get(session.voiceChannelId);
    if (!vc) { console.log(`⚠️ Canal vocal introuvable pour ${sessionId}, suppression`); await deleteLFGSession(sessionId, guild); continue; }
    if (!vc.members.size) resetTimeout(sessionId, guild);
  }

  await registerCommands();
  updateRichPresence();
});

// ─── Periodic cleanup ─────────────────────────────────────────────────────────
setInterval(async () => {
  const now = Date.now();

  for (const userId of Object.keys(rateLimiter)) {
    rateLimiter[userId] = rateLimiter[userId].filter(ts => now - ts < 60_000);
    if (!rateLimiter[userId].length) delete rateLimiter[userId];
  }

  for (const [key, timestamps] of userSessionTimestamps) {
    const guildId  = key.split(':')[0];
    const { windowSeconds } = getGuildCooldownConfig(guildId);
    const fresh = timestamps.filter(ts => now - ts < windowSeconds * 1000);
    if (fresh.length === 0) userSessionTimestamps.delete(key);
    else userSessionTimestamps.set(key, fresh);
  }

  for (const [sessionId, data] of lfgSessions) {
    if ((data.expiresAt && now > data.expiresAt) || (now - new Date(data.value.date).getTime() > SESSION_EXPIRY)) {
      const guild = client.guilds.cache.get(data.value.guildId);
      if (guild) await deleteLFGSession(sessionId, guild);
    }
  }

  for (const [key, data] of lfgJoinedUsers) {
    if (data.expiresAt && now > data.expiresAt) { lfgJoinedUsers.delete(key); db.prepare('DELETE FROM lfgJoinedUsers WHERE sessionId = ?').run(key); }
  }

  for (const [key, data] of webhookChannels)  { if (data.expiresAt && now > data.expiresAt) webhookChannels.delete(key); }
  for (const [key, data] of guildGameFilters) { if (data.expiresAt && now > data.expiresAt) guildGameFilters.delete(key); }
  for (const [key, data] of guildCooldowns)   { if (data.expiresAt && now > data.expiresAt) guildCooldowns.delete(key); }
}, 60_000);

// ─── Graceful shutdown ────────────────────────────────────────────────────────
async function shutdown(code = 0) {
  console.log('🛑 Arrêt en cours, sauvegarde des données…');
  await saveData();
  db.close();
  client.destroy();
  process.exit(code);
}

process.on('SIGINT',  () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('uncaughtException',   async err => { console.error('uncaughtException:', err);  await shutdown(1); });
process.on('unhandledRejection',  async err => { console.error('unhandledRejection:', err); await shutdown(1); });

// ─── Login ────────────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN)
  .then(() => console.log('✅ Connexion Discord établie.'))
  .catch(err => { console.error('⚠️ Connexion Discord échouée :', err.message); process.exit(1); });
