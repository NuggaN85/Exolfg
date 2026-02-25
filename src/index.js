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

// ─── ESM __dirname ──────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── Environment ────────────────────────────────────────────────────────────
dotenv.config();

if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID) {
  throw new Error("⚠️ Les variables d'environnement DISCORD_TOKEN et CLIENT_ID sont obligatoires.");
}

// ─── Discord client ──────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// ─── Database ────────────────────────────────────────────────────────────────
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
    guildId TEXT PRIMARY KEY,
    channelId TEXT
  );

  CREATE TABLE IF NOT EXISTS guildGameFilters (
    guildId TEXT PRIMARY KEY,
    games TEXT NOT NULL DEFAULT '[]'
  );
`);

// ─── In-memory caches ─────────────────────────────────────────────────────────
const lfgSessions     = new Map();
const lfgJoinedUsers  = new Map();
const webhookChannels = new Map();
const guildGameFilters = new Map();
const lfgStats        = { totalSessions: 0, totalPlayers: 0 };
const rateLimiter     = {};

const SESSION_EXPIRY = 24 * 60 * 60 * 1000;
const CACHE_TTL      = 60 * 60 * 1000;
const WEBHOOK_TTL    = 30 * 60 * 1000;
const FILTER_TTL     = 60 * 60 * 1000;
const ITEMS_PER_PAGE = 10;

// ─── Game list ───────────────────────────────────────────────────────────────
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

  const row = db.prepare('SELECT games FROM guildGameFilters WHERE guildId = ?').get(guildId);
  const games = row ? JSON.parse(row.games) : [];
  setWithTTL(guildGameFilters, guildId, games, FILTER_TTL);
  return games;
}

function isGameAllowedForGuild(guildId, game) {
  const filter = getGuildGameFilter(guildId);
  return filter.length === 0 || filter.includes(game);
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
// Remplis les URLs avec tes propres liens (imgur, CDN, hébergement perso…).
// L'image sera affichée en grand via MediaGalleryBuilder juste après le header.
// Si une URL est vide ('') ou absente, aucune image ne sera affichée.

const gameImages = {
  'League of Legends':        'https://i.imgur.com/mm0hV5B.jpeg',
  'Valorant':                 'https://i.imgur.com/mm0hV5B.jpeg',
  'Counter-Strike 2':         'https://i.imgur.com/mm0hV5B.jpeg',
  'Dota 2':                   'https://i.imgur.com/mm0hV5B.jpeg',
  'Apex Legends':             'https://i.imgur.com/mm0hV5B.jpeg',
  'Rainbow Six: Siege':       'https://i.imgur.com/mm0hV5B.jpeg',
  'Overwatch 2':              'https://i.imgur.com/mm0hV5B.jpeg',
  'Fortnite':                 'https://i.imgur.com/mm0hV5B.jpeg',
  'Rocket League':            'https://i.imgur.com/mm0hV5B.jpeg',
  'COD: Warzone':             'https://i.imgur.com/mm0hV5B.jpeg',
  'PUBG: Battlegrounds':      'https://i.imgur.com/mm0hV5B.jpeg',
  'Hearthstone':              'https://i.imgur.com/mm0hV5B.jpeg',
  'Teamfight Tactics':        'https://i.imgur.com/mm0hV5B.jpeg',
  'Street Fighter 6':         'https://i.imgur.com/mm0hV5B.jpeg',
  'Tekken 8':                 'https://i.imgur.com/mm0hV5B.jpeg',
  'EA Sports FC 24':          'https://i.imgur.com/mm0hV5B.jpeg',
  'StarCraft II':             'https://i.imgur.com/mm0hV5B.jpeg',
  'Smite':                    'https://i.imgur.com/mm0hV5B.jpeg',
  'Paladins':                 'https://i.imgur.com/mm0hV5B.jpeg',
  'World of Warcraft':        'https://i.imgur.com/mm0hV5B.jpeg',
  'Brawlhalla':               'https://i.imgur.com/mm0hV5B.jpeg',
  'Albion Online':            'https://i.imgur.com/mm0hV5B.jpeg',
  'The Finals':               'https://i.imgur.com/mm0hV5B.jpeg',
  'Halo Infinite':            'https://i.imgur.com/mm0hV5B.jpeg',
  'Mobile Legends: Bang Bang':'https://i.imgur.com/mm0hV5B.jpeg',
};

/**
 * Retourne l'URL de l'image pour un jeu donné, ou null si non définie.
 * @param {string} game
 * @returns {string|null}
 */
function getGameImageUrl(game) {
  const url = gameImages[game];
  return url && url.trim() !== '' ? url.trim() : null;
}

// ─── Improved embed builders ──────────────────────────────────────────────────

/**
 * Returns a platform emoji for a given platform string.
 */
function getPlatformEmoji(platform) {
  const map = {
    'PC': '🖥️', 'PlayStation 5': '🎮', 'PlayStation 4': '🎮',
    'Xbox Series X|S': '🟩', 'Xbox One': '🟩', 'Nintendo Switch': '🔴',
    'Mobile': '📱', 'iOS': '📱', 'Android': '📱',
    'Crossplay': '🌐', 'VR': '🥽', 'Mac': '🍎', 'Linux': '🐧',
  };
  return map[platform] ?? '🕹️';
}

/**
 * Returns an activity emoji.
 */
function getActivityEmoji(activity) {
  const map = {
    'Normale': '🎲', 'Classé': '🏆', 'Compétitif': '⚔️',
    'Tournoi': '🏅', 'Scrim': '🎯', 'Entraînement': '📚',
    'Fun': '😄', 'Découverte': '🔭', 'Arcade': '🕹️',
    'Coopération': '🤝', 'Speedrun': '⚡', 'PvE': '🐉',
    'PvP': '⚔️', 'Raids': '🗡️', 'Dungeons': '🏰',
  };
  return map[activity] ?? '🎮';
}

/**
 * Build the header section — sans thumbnail (image gérée via MediaGallery).
 * @param {string} label
 * @param {string} sessionId
 * @param {string} statusEmoji
 */
function buildHeaderSection(label, sessionId, statusEmoji = '🟢') {
  // SectionBuilder exige un accessoire (Thumbnail ou Button) — on utilise
  // de simples TextDisplayBuilder ajoutés directement au ContainerBuilder.
  return [
    new TextDisplayBuilder().setContent(`${statusEmoji} **${label}**`),
    new TextDisplayBuilder().setContent(`\`🆔 Session #${sessionId}\``),
  ];
}

/**
 * Build a MediaGalleryBuilder with a single game image.
 * Returns null if no image URL is defined for this game.
 * @param {string} game
 * @returns {MediaGalleryBuilder|null}
 */
function buildGameImageGallery(game) {
  const url = getGameImageUrl(game);
  if (!url) return null;
  return new MediaGalleryBuilder().addItems(
    new MediaGalleryItemBuilder().setURL(url)
  );
}

/**
 * Build navigation buttons row (vocal, texte, info).
 */
function buildNavButtons(sessionId) {
  const vocalButton = new ButtonBuilder().setCustomId(`vocal_${sessionId}`).setLabel('🔊 Vocal').setStyle(ButtonStyle.Secondary);
  const texteButton = new ButtonBuilder().setCustomId(`texte_${sessionId}`).setLabel('💬 Discussion').setStyle(ButtonStyle.Secondary);
  const infoButton  = new ButtonBuilder().setCustomId(`info_${sessionId}`).setLabel('📢 Infos').setStyle(ButtonStyle.Secondary);
  return new ActionRowBuilder().addComponents(vocalButton, texteButton, infoButton);
}

/**
 * Build the main join button row.
 */
function buildJoinButton(sessionId) {
  const joinButton = new ButtonBuilder()
    .setCustomId(`join_${sessionId}`)
    .setLabel('✅ Rejoindre la session')
    .setStyle(ButtonStyle.Success);
  return new ActionRowBuilder().addComponents(joinButton);
}

/**
 * Build the full session ContainerBuilder — improved layout.
 *
 * Layout structure:
 * ┌─────────────────────────────────────────┐
 * │ [HEADER] Label + Session ID             │
 * ├─────────────────────────────────────────┤
 * │ [IMAGE DU JEU — MediaGallery]           │
 * ├─────────────────────────────────────────┤
 * │ 👑 Organisateur                         │
 * ├── jeu & plateforme ─────────────────────┤
 * │ 🎮 Jeu          💻 Plateforme           │
 * │ 🏆 Activité     👥 Joueurs X/Y          │
 * │ 🎯 Gametag                              │
 * ├── description ──────────────────────────┤
 * │ 📝 Description                          │
 * ├── participants ─────────────────────────┤
 * │ 👥 Participants                         │
 * ├── twitch (optionnel) ───────────────────┤
 * │ 🟣 Stream Twitch                        │
 * ├── boutons navigation ───────────────────┤
 * │ [🔊 Vocal] [💬 Discussion] [📢 Infos]  │
 * ├── bouton rejoindre ─────────────────────┤
 * │ [✅ Rejoindre la session]               │
 * ├── footer ───────────────────────────────┤
 * │ ⏱️ Expire si vide · Serveur · cmds      │
 * └─────────────────────────────────────────┘
 */
function buildSessionContainer({
  sessionId,
  label,
  guildName,
  organizerMention,
  game,
  platform,
  activity,
  joinedCount,
  maxPlayers,
  gametag,
  description,
  twitchUrl = null,
  participantsMention,
  includeJoinButton = true,
  includeNavButtons = true,
  isModified = false,
}) {
  const hexColor    = 0x1E90FF;
  const statusEmoji = isModified ? '🔄' : '🟢';
  const isFull      = joinedCount >= maxPlayers;
  const slotDisplay = isFull ? `~~${joinedCount}/${maxPlayers}~~ **COMPLET**` : `${joinedCount}/${maxPlayers}`;
  const platEmoji   = getPlatformEmoji(platform);
  const actEmoji    = getActivityEmoji(activity);
  const gameGallery = buildGameImageGallery(game);

  const [headerTitle, headerId] = buildHeaderSection(label, sessionId, statusEmoji);
  const container = new ContainerBuilder()
    // ── Header ───────────────────────────────────────────────────────────────
    .addTextDisplayComponents(headerTitle)
    .addTextDisplayComponents(headerId)
    .addSeparatorComponents(new SeparatorBuilder());

  // ── Image du jeu (MediaGallery, juste après le header) ───────────────────
  if (gameGallery) container.addMediaGalleryComponents(gameGallery);

  container

    // ── Organisateur ─────────────────────────────────────────────────────────
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`👑 **Organisateur :** ${organizerMention}`)
    )
    .addSeparatorComponents(new SeparatorBuilder())

    // ── Infos jeu (regroupées sur 2 lignes compactes) ─────────────────────────
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `🎮 **${game}**  ·  ${platEmoji} ${platform}`
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `${actEmoji} **${activity}**  ·  👥 **Joueurs :** ${slotDisplay}`
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`🎯 **Gametag :** \`${gametag}\``)
    )
    .addSeparatorComponents(new SeparatorBuilder())

    // ── Description ───────────────────────────────────────────────────────────
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`> 📝 ${description}`)
    )

    .setAccentColor(hexColor);

  // ── Participants (optionnel, affiché dans le salon info) ──────────────────
  if (participantsMention !== undefined) {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`👥 **Participants :** ${participantsMention}`)
      );
  }

  // ── Stream Twitch (optionnel) ─────────────────────────────────────────────
  if (twitchUrl) {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `🟣 **Live Twitch :** [${twitchUrl.replace('https://twitch.tv/', '')}](${twitchUrl})`
        )
      );
  }

  // ── Boutons de navigation ─────────────────────────────────────────────────
  if (includeNavButtons) {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addActionRowComponents(buildNavButtons(sessionId));
  }

  // ── Bouton rejoindre ──────────────────────────────────────────────────────
  if (includeJoinButton) {
    container.addActionRowComponents(buildJoinButton(sessionId));
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  container
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `-# ⏱️ Salon supprimé après 5 min si vide  ·  ${guildName}  ·  /lfg  /stats  /history`
    )
  );

  return container;
}

// ─── Cross-server container ───────────────────────────────────────────────────

/**
 * Build a cross-server announcement container — improved layout showing
 * origin server clearly and without join button (read-only announcement).
 */
function buildCrossServerContainer({
  sessionId,
  sourceGuildName,
  organizerTag,
  game,
  platform,
  activity,
  joinedCount,
  maxPlayers,
  gametag,
  description,
  twitchUrl,
}) {
  const platEmoji   = getPlatformEmoji(platform);
  const actEmoji    = getActivityEmoji(activity);
  const gameGallery = buildGameImageGallery(game);

  const container = new ContainerBuilder()
    // ── Header (TextDisplay, pas de SectionBuilder sans accessoire) ───────────
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`📡 **Session LFG — Annonce externe**`))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`\`🆔 Session #${sessionId}\``))
    .addSeparatorComponents(new SeparatorBuilder());

  // ── Image du jeu (MediaGallery, juste après le header) ───────────────────
  if (gameGallery) container.addMediaGalleryComponents(gameGallery);

  container

    // ── Serveur source bien mis en avant ─────────────────────────────────────
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`🌐 **Serveur d'origine :** ${sourceGuildName}`)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`👑 **Organisateur :** ${organizerTag}`)
    )
    .addSeparatorComponents(new SeparatorBuilder())

    // ── Infos jeu ─────────────────────────────────────────────────────────────
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`🎮 **${game}**  ·  ${platEmoji} ${platform}`)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`${actEmoji} **${activity}**  ·  👥 **Joueurs :** ${joinedCount}/${maxPlayers}`)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`🎯 **Gametag :** \`${gametag}\``)
    )
    .addSeparatorComponents(new SeparatorBuilder())

    // ── Description ───────────────────────────────────────────────────────────
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`> 📝 ${description}`)
    );

  if (twitchUrl) {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `🟣 **Live Twitch :** [${twitchUrl.replace('https://twitch.tv/', '')}](${twitchUrl})`
        )
      );
  }

  container
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `> ⚠️ *Cette session est hébergée sur **${sourceGuildName}**.\nRejoignez ce serveur pour y participer.*`
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# ${sourceGuildName}  ·  /lfg  /stats  /history`
      )
    )
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
  const now      = Date.now();
  const limit    = 5;
  const interval = 60_000;
  rateLimiter[userId] = (rateLimiter[userId] ?? []).filter(ts => now - ts < interval);
  if (rateLimiter[userId].length >= limit) return false;
  rateLimiter[userId].push(now);
  return true;
}

// ─── Database persistence ─────────────────────────────────────────────────────
async function saveData() {
  try {
    const insertSession = db.prepare(`
      INSERT OR REPLACE INTO lfgSessions (
        id, userId, user, game, platform, activity, gametag, description, date,
        players, categoryId, voiceChannelId, textChannelId, infoTextChannelId,
        infoMessageId, commandChannelId, commandChannelMessageId, guildId
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertUser   = db.prepare('INSERT OR REPLACE INTO lfgJoinedUsers (sessionId, userId) VALUES (?, ?)');
    const deleteUsers  = db.prepare('DELETE FROM lfgJoinedUsers WHERE sessionId = ?');
    const updateStats  = db.prepare('INSERT OR REPLACE INTO lfgStats (id, totalSessions, totalPlayers) VALUES (1, ?, ?)');
    const insertWebhook = db.prepare('INSERT OR REPLACE INTO webhookChannels (guildId, channelId) VALUES (?, ?)');
    const insertFilter  = db.prepare('INSERT OR REPLACE INTO guildGameFilters (guildId, games) VALUES (?, ?)');

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
      for (const [guildId, data] of webhookChannels) insertWebhook.run(guildId, data.value);
      for (const [guildId, data] of guildGameFilters) insertFilter.run(guildId, JSON.stringify(data.value));
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
  if (session.timeoutId) {
    clearTimeout(session.timeoutId);
    session.timeoutId = null;
  }

  session.timeoutId = setTimeout(async () => {
    const voiceChannel = guild.channels.cache.get(session.voiceChannelId);
    if (!voiceChannel || voiceChannel.members.size === 0) {
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

// ─── Load data from DB on startup ─────────────────────────────────────────────
async function loadData() {
  try {
    const sessions = db.prepare('SELECT * FROM lfgSessions').all();
    for (const s of sessions) {
      setWithTTL(lfgSessions, s.id, { ...s, timeoutId: null }, CACHE_TTL);
    }
    console.log(`✅ ${sessions.length} session(s) chargée(s).`);

    const users = db.prepare('SELECT sessionId, userId FROM lfgJoinedUsers').all();
    for (const u of users) {
      const existing = lfgJoinedUsers.get(u.sessionId);
      if (!existing) {
        setWithTTL(lfgJoinedUsers, u.sessionId, [u.userId], CACHE_TTL);
      } else {
        existing.value.push(u.userId);
      }
    }

    const stats = db.prepare('SELECT totalSessions, totalPlayers FROM lfgStats LIMIT 1').get() ?? { totalSessions: 0, totalPlayers: 0 };
    Object.assign(lfgStats, stats);

    const webhooks = db.prepare('SELECT guildId, channelId FROM webhookChannels').all();
    for (const w of webhooks) setWithTTL(webhookChannels, w.guildId, w.channelId, WEBHOOK_TTL);

    const filters = db.prepare('SELECT guildId, games FROM guildGameFilters').all();
    for (const f of filters) setWithTTL(guildGameFilters, f.guildId, JSON.parse(f.games), FILTER_TTL);
  } catch (err) {
    console.error('⚠️ Erreur chargement données:', err.message);
  }
}

// ─── Slash command registration ───────────────────────────────────────────────
async function registerCommands() {
  const platformChoices = [
    { name: 'PC',              value: 'PC' },
    { name: 'PlayStation 5',   value: 'PlayStation 5' },
    { name: 'PlayStation 4',   value: 'PlayStation 4' },
    { name: 'Xbox Series X|S', value: 'Xbox Series X|S' },
    { name: 'Xbox One',        value: 'Xbox One' },
    { name: 'Nintendo Switch', value: 'Nintendo Switch' },
    { name: 'Mobile',          value: 'Mobile' },
    { name: 'iOS',             value: 'iOS' },
    { name: 'Android',         value: 'Android' },
    { name: 'Crossplay',       value: 'Crossplay' },
    { name: 'VR',              value: 'VR' },
    { name: 'Mac',             value: 'Mac' },
    { name: 'Linux',           value: 'Linux' },
  ];

  const activityChoices = [
    { name: 'Normale',       value: 'Normale' },
    { name: 'Classé',        value: 'Classé' },
    { name: 'Compétitif',    value: 'Compétitif' },
    { name: 'Tournoi',       value: 'Tournoi' },
    { name: 'Scrim',         value: 'Scrim' },
    { name: 'Entraînement',  value: 'Entraînement' },
    { name: 'Fun',           value: 'Fun' },
    { name: 'Découverte',    value: 'Découverte' },
    { name: 'Arcade',        value: 'Arcade' },
    { name: 'Coopération',   value: 'Coopération' },
    { name: 'Speedrun',      value: 'Speedrun' },
    { name: 'PvE',           value: 'PvE' },
    { name: 'PvP',           value: 'PvP' },
    { name: 'Raids',         value: 'Raids' },
    { name: 'Dungeons',      value: 'Dungeons' },
  ];

  const commands = [
    {
      name: 'lfg',
      description: 'Créer une session LFG',
      options: [
        { name: 'jeux',        description: 'Jeu',                  type: 3, required: true, choices: gameChoices },
        { name: 'plateforme',  description: 'Plate-forme',           type: 3, required: true, choices: platformChoices },
        { name: 'joueurs',     description: 'Nombre de joueurs',     type: 4, required: true, min_value: 1, max_value: 10 },
        { name: 'gametag',     description: 'Gametag',               type: 3, required: true },
        { name: 'activite',    description: 'Activité',              type: 3, required: true, choices: activityChoices },
        { name: 'description', description: 'Description (optionnel)',           type: 3, required: false },
        { name: 'twitch',      description: 'Lien Twitch (optionnel)',           type: 3, required: false },
      ],
    },
    {
      name: 'modify_lfg',
      description: 'Modifier une session LFG',
      options: [
        { name: 'session_id',  description: 'ID de la session',      type: 3, required: true },
        { name: 'joueurs',     description: 'Nombre de joueurs',      type: 4, required: false, min_value: 1, max_value: 10 },
        { name: 'description', description: 'Description',            type: 3, required: false },
      ],
    },
    {
      name: 'list_members',
      description: "Lister les membres d'une session LFG",
      options: [
        { name: 'session_id', description: 'ID de la session',       type: 3, required: true },
        { name: 'page',       description: 'Page',                   type: 4, required: false, min_value: 1 },
      ],
    },
    {
      name: 'kick_member',
      description: "Retirer un membre d'une session LFG",
      options: [
        { name: 'session_id', description: 'ID de la session',       type: 3, required: true },
        { name: 'member',     description: 'Membre à retirer',        type: 6, required: true },
      ],
    },
    {
      name: 'ban_member',
      description: "Bannir un membre d'une session LFG",
      options: [
        { name: 'session_id', description: 'ID de la session',       type: 3, required: true },
        { name: 'member',     description: 'Membre à bannir',         type: 6, required: true },
      ],
    },
    { name: 'stats',   description: 'Afficher les statistiques des sessions LFG' },
    { name: 'history', description: "Afficher l'historique des sessions LFG" },
    {
      name: 'set_lfg_channel',
      description: 'Définir le salon pour les annonces LFG',
      options: [
        { name: 'channel', description: 'Salon pour les annonces', type: 7, required: true, channel_types: [ChannelType.GuildText] },
      ],
    },
    {
      name: 'config',
      description: 'Configurer les jeux acceptés sur ce serveur',
      options: [
        {
          name: 'action',
          description: 'Action à effectuer',
          type: 3,
          required: true,
          choices: [
            { name: 'Ajouter un jeu au filtre',    value: 'add' },
            { name: 'Retirer un jeu du filtre',    value: 'remove' },
            { name: 'Voir la configuration',       value: 'view' },
            { name: 'Réinitialiser (tout accepter)', value: 'reset' },
          ],
        },
        {
          name: 'jeu',
          description: 'Jeu à ajouter ou retirer du filtre',
          type: 3,
          required: false,
          choices: gameChoices,
        },
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
// Command handlers
// ─────────────────────────────────────────────────────────────────────────────

async function handleLFGCommand(interaction) {
  const { options, member, guild, channel, user } = interaction;

  if (!member.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return interaction.reply({ content: '❌ Permission insuffisante.', flags: [MessageFlags.Ephemeral] });
  }

  const game        = options.getString('jeux');
  const platform    = options.getString('plateforme');
  const players     = options.getInteger('joueurs');
  const gametag     = options.getString('gametag');
  const activity    = options.getString('activite');
  const description = options.getString('description') ?? 'Pas de description';
  const twitchRaw   = options.getString('twitch');
  const sessionId   = Math.floor(1000 + Math.random() * 9000).toString();

  const TWITCH_REGEX = /^https?:\/\/(www\.)?twitch\.tv\/[a-zA-Z0-9_]{1,25}\/?$/;
  if (twitchRaw && !TWITCH_REGEX.test(twitchRaw.trim())) {
    return interaction.reply({
      content: '❌ Le lien Twitch est invalide.\n✅ Format attendu : `https://twitch.tv/nomduchaine`',
      flags: [MessageFlags.Ephemeral],
    });
  }
  const twitchUrl = twitchRaw ? twitchRaw.trim().replace(/\/$/, '') : null;

  if (!isGameAllowedForGuild(guild.id, game)) {
    const filter = getGuildGameFilter(guild.id);
    return interaction.reply({
      content: `❌ Ce serveur n'accepte pas les sessions LFG pour **${game}**.\n📋 Jeux autorisés : ${filter.map(g => `\`${g}\``).join(', ')}`,
      flags: [MessageFlags.Ephemeral],
    });
  }

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  try {
    const category = await guild.channels.create({
      name: `🎮-${sessionId}-LFG`,
      type: ChannelType.GuildCategory,
      permissionOverwrites: [
        { id: guild.id,       allow: [PermissionFlagsBits.ViewChannel] },
        { id: client.user.id, allow: [PermissionFlagsBits.ManageChannels] },
      ],
    });

    const textChannel = await guild.channels.create({
      name: `📝-${sessionId}-discussion`,
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: [
        { id: guild.id,       allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
        { id: client.user.id, allow: [PermissionFlagsBits.ManageChannels] },
      ],
    });

    await textChannel.send({
      content: `👋 Bienvenue dans le salon de discussion de la session **#${sessionId}** !\n> Organisateur : <@${user.id}>`,
      allowedMentions: { parse: [] },
    });

    const voiceChannel = await guild.channels.create({
      name: `🔊-${sessionId}-LFG`,
      type: ChannelType.GuildVoice,
      parent: category.id,
      userLimit: players + 1,
      permissionOverwrites: [
        { id: guild.id,       allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
        { id: client.user.id, allow: [PermissionFlagsBits.ManageChannels] },
      ],
    });

    const infoTextChannel = await guild.channels.create({
      name: `📢-${sessionId}-info`,
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: [
        { id: guild.id,       allow: [PermissionFlagsBits.ViewChannel] },
        { id: client.user.id, allow: [PermissionFlagsBits.ManageChannels] },
      ],
    });

    const commonOpts = {
      sessionId,
      guildName: guild.name,
      organizerMention: `<@${user.id}>`,
      game,
      platform,
      activity,
      joinedCount: 1,
      maxPlayers: players,
      gametag,
      description,
      twitchUrl,
    };

    // ── Salon info : avec participants + bouton rejoindre + nav ───────────────
    const infoContainer = buildSessionContainer({
      ...commonOpts,
      label: 'Nouvelle session LFG',
      participantsMention: `<@${user.id}>`,
      includeJoinButton: true,
      includeNavButtons: true,
    });

    // ── Salon commande : sans bouton rejoindre (lecture seule) ────────────────
    const commandContainer = buildSessionContainer({
      ...commonOpts,
      label: 'Nouvelle session LFG',
      includeJoinButton: false,
      includeNavButtons: true,
    });

    const infoMessage = await infoTextChannel.send({
      flags: MessageFlags.IsComponentsV2,
      components: [infoContainer],
      allowedMentions: { parse: [] },
    });
    await infoMessage.pin();

    await infoTextChannel.send({
      content: `📢 Salon d'information pour la session **#${sessionId}** — utilisez les boutons ci-dessus.`,
      allowedMentions: { parse: [] },
    });

    const commandChannelMessage = await channel.send({
      flags: MessageFlags.IsComponentsV2,
      components: [commandContainer],
      allowedMentions: { parse: [] },
    });

    // ── Cross-server announcements ───────────────────────────────────────────
    const initialJoinedUsers = [user.id];

    for (const [guildId, webhookData] of webhookChannels) {
      if (guildId === guild.id) continue;
      if (!isGameAllowedForGuild(guildId, game)) {
        console.log(`⏭️ Annonce filtrée pour ${guildId} (jeu "${game}" non autorisé).`);
        continue;
      }

      try {
        const targetGuild   = client.guilds.cache.get(guildId);
        const targetChannel = targetGuild?.channels.cache.get(webhookData.value);
        if (!targetChannel?.isTextBased()) continue;

        const crossContainer = buildCrossServerContainer({
          sessionId,
          sourceGuildName: guild.name,
          organizerTag: user.tag,
          game,
          platform,
          activity,
          joinedCount: initialJoinedUsers.length,
          maxPlayers: players,
          gametag,
          description,
          twitchUrl,
        });

        const webhook = await targetChannel.createWebhook({ name: 'LFG Annonce', avatar: client.user.avatarURL() });
        await webhook.send({
          components: [crossContainer],
          flags: MessageFlags.IsComponentsV2,
          username: client.user.username,
          avatarURL: client.user.avatarURL(),
          allowedMentions: { parse: [] },
        });
        await webhook.delete();
        console.log(`✅ Annonce envoyée à ${targetChannel.name} sur ${targetGuild.name}`);
      } catch (err) {
        console.error(`⚠️ Erreur annonce vers ${guildId}:`, err.message);
      }
    }

    const sessionData = {
      userId: user.id,
      user: user.tag,
      game, platform, activity, gametag, description, twitchUrl,
      date: new Date().toISOString(),
      players,
      categoryId: category.id,
      voiceChannelId: voiceChannel.id,
      textChannelId: textChannel.id,
      infoTextChannelId: infoTextChannel.id,
      infoMessageId: infoMessage.id,
      commandChannelId: channel.id,
      commandChannelMessageId: commandChannelMessage.id,
      timeoutId: null,
      guildId: guild.id,
    };

    setWithTTL(lfgSessions, sessionId, sessionData, CACHE_TTL);
    setWithTTL(lfgJoinedUsers, sessionId, initialJoinedUsers, CACHE_TTL);
    lfgStats.totalSessions++;
    lfgStats.totalPlayers += players;
    await saveData();

    if (!voiceChannel.members.size) resetTimeout(sessionId, guild);
    updateRichPresence();

    await interaction.followUp({
      content: `✅ Session **#${sessionId}** créée avec succès !\n> 💬 ${textChannel} · 📢 ${infoTextChannel}`,
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

async function handleModifyLFGCommand(interaction) {
  const { options, member, guild } = interaction;
  const sessionId   = options.getString('session_id');
  const newPlayers  = options.getInteger('joueurs');
  const newDesc     = options.getString('description');

  if (!member.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return interaction.reply({ content: '❌ Permission insuffisante.', flags: [MessageFlags.Ephemeral] });
  }
  if (!newPlayers && !newDesc) {
    return interaction.reply({ content: '❌ Fournissez au moins un champ à modifier.', flags: [MessageFlags.Ephemeral] });
  }

  const sessionData = lfgSessions.get(sessionId);
  if (!sessionData) return interaction.reply({ content: `❌ Session ${sessionId} introuvable.`, flags: [MessageFlags.Ephemeral] });

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  try {
    const session = { ...sessionData.value };
    if (newPlayers) {
      const voiceChannel = guild.channels.cache.get(session.voiceChannelId);
      if (voiceChannel) await voiceChannel.edit({ userLimit: newPlayers + 1 });
      lfgStats.totalPlayers = lfgStats.totalPlayers - session.players + newPlayers;
      session.players = newPlayers;
    }
    if (newDesc) session.description = newDesc;
    setWithTTL(lfgSessions, sessionId, session, CACHE_TTL);

    const joinedUsers = lfgJoinedUsers.get(sessionId)?.value ?? [];
    const participantsMention = joinedUsers.length ? joinedUsers.map(id => `<@${id}>`).join(', ') : 'Aucun';

    const commonOpts = {
      sessionId,
      guildName: guild.name,
      organizerMention: `<@${session.userId}>`,
      game: session.game,
      platform: session.platform,
      activity: session.activity,
      joinedCount: joinedUsers.length,
      maxPlayers: session.players,
      gametag: session.gametag,
      description: session.description,
      isModified: true,
    };

    const infoTextChannel = guild.channels.cache.get(session.infoTextChannelId);
    if (infoTextChannel && session.infoMessageId) {
      try {
        const infoMessage = await infoTextChannel.messages.fetch(session.infoMessageId);
        await infoMessage.edit({
          flags: MessageFlags.IsComponentsV2,
          components: [buildSessionContainer({
            ...commonOpts,
            label: 'Session LFG modifiée',
            participantsMention,
            includeJoinButton: true,
            includeNavButtons: true,
          })],
          allowedMentions: { parse: [] },
        });
      } catch (err) {
        console.warn(`⚠️ Impossible MAJ message info:`, err.message);
      }
    }

    const commandChannel = guild.channels.cache.get(session.commandChannelId);
    if (commandChannel && session.commandChannelMessageId) {
      try {
        const commandMessage = await commandChannel.messages.fetch(session.commandChannelMessageId);
        await commandMessage.edit({
          flags: MessageFlags.IsComponentsV2,
          components: [buildSessionContainer({
            ...commonOpts,
            label: 'Session LFG modifiée',
            includeJoinButton: false,
            includeNavButtons: true,
          })],
          allowedMentions: { parse: [] },
        });
      } catch (err) {
        console.warn(`⚠️ Impossible MAJ message commande:`, err.message);
      }
    }

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
  if (!sessionData) return interaction.reply({ content: `❌ Session ${sessionId} introuvable.`, flags: [MessageFlags.Ephemeral] });

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  try {
    const session      = sessionData.value;
    const voiceChannel = interaction.guild.channels.cache.get(session.voiceChannelId);
    const members      = voiceChannel?.members.map(m => m.user.tag) ?? [];
    const start        = (page - 1) * ITEMS_PER_PAGE;
    const pageItems    = members.slice(start, start + ITEMS_PER_PAGE);
    const totalPages   = Math.max(1, Math.ceil(members.length / ITEMS_PER_PAGE));
    const joinedData   = lfgJoinedUsers.get(sessionId)?.value ?? [];

    const thumbnail = new ThumbnailBuilder({
      media: { url: interaction.guild.iconURL({ dynamic: true }) ?? 'https://i.imgur.com/Xo1BHdr.png' },
    });

    const headerSection = new SectionBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`👥 **Membres de la session**`))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`\`🆔 Session #${sessionId}\``))
      .setThumbnailAccessory(thumbnail);

    const memberList = pageItems.length
      ? pageItems.map((tag, i) => `\`${start + i + 1}.\` ${tag}`).join('\n')
      : '_Aucun membre dans le salon vocal_';

    const container = new ContainerBuilder()
      .addSectionComponents(headerSection)
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`🔊 **Dans le vocal :**\n${memberList}`)
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `📋 **Inscrits :** ${joinedData.length}/${session.players}  ·  🔊 **En vocal :** ${members.length}`
        )
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `-# Page ${page}/${totalPages}  ·  ${interaction.guild.name}  ·  /lfg  /stats  /history`
        )
      )
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

  const sessionData = lfgSessions.get(sessionId);
  if (!sessionData) return interaction.reply({ content: `❌ Session ${sessionId} introuvable.`, flags: [MessageFlags.Ephemeral] });

  const session = sessionData.value;
  if (user.id !== session.userId) {
    return interaction.reply({ content: '❌ Seuls les organisateurs peuvent retirer des membres.', flags: [MessageFlags.Ephemeral] });
  }

  try {
    const voiceChannel = guild.channels.cache.get(session.voiceChannelId);
    if (!voiceChannel || targetMember.voice.channelId !== voiceChannel.id) {
      return interaction.reply({ content: `❌ ${targetMember.user.tag} n'est pas dans le salon vocal.`, flags: [MessageFlags.Ephemeral] });
    }
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

  const sessionData = lfgSessions.get(sessionId);
  if (!sessionData) return interaction.reply({ content: `❌ Session ${sessionId} introuvable.`, flags: [MessageFlags.Ephemeral] });

  const session = sessionData.value;
  if (user.id !== session.userId) {
    return interaction.reply({ content: '❌ Seuls les organisateurs peuvent bannir des membres.', flags: [MessageFlags.Ephemeral] });
  }

  try {
    const voiceChannel = guild.channels.cache.get(session.voiceChannelId);
    if (!voiceChannel || targetMember.voice.channelId !== voiceChannel.id) {
      return interaction.reply({ content: `❌ ${targetMember.user.tag} n'est pas dans le salon vocal.`, flags: [MessageFlags.Ephemeral] });
    }
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

    const thumbnail = new ThumbnailBuilder({
      media: { url: interaction.guild.iconURL({ dynamic: true }) ?? 'https://i.imgur.com/Xo1BHdr.png' },
    });

    const headerSection = new SectionBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`📊 **Statistiques LFG**`))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(interaction.guild.name))
      .setThumbnailAccessory(thumbnail);

    const container = new ContainerBuilder()
      .addSectionComponents(headerSection)
      .addSeparatorComponents(new SeparatorBuilder())

      // ── Stats globales ──────────────────────────────────────────────────────
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`🗂️ **Sessions créées :** ${lfgStats.totalSessions}`)
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`👥 **Joueurs totaux :** ${lfgStats.totalPlayers}`)
      )
      .addSeparatorComponents(new SeparatorBuilder())

      // ── Stats en temps réel ─────────────────────────────────────────────────
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`🟢 **Sessions actives :** ${lfgSessions.size}`)
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`🎮 **Joueurs en session :** ${activePlayers}`)
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `-# ${interaction.guild.name}  ·  /lfg  /stats  /history`
        )
      )
      .setAccentColor(0x1E90FF);

    await interaction.followUp({ components: [container], flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral] });
  } catch (err) {
    console.error('⚠️ Erreur stats:', err);
    await interaction.followUp({ content: '❌ Erreur affichage stats.', flags: [MessageFlags.Ephemeral] });
  }
}

// ──────────────────────────────────────────────────────────────────────────────

// Pages d'historique en cours par utilisateur (userId → page courante)
const historyPages = new Map();

/**
 * Construit et envoie (ou met à jour) l'embed historique pour une page donnée.
 */
async function sendHistoryEmbed(interaction, page, isUpdate = false) {
  const sessions   = Array.from(lfgSessions.entries()).map(([id, d]) => ({ id, ...d.value }));
  const totalPages = Math.max(1, Math.ceil(sessions.length / ITEMS_PER_PAGE));
  const safePage   = Math.min(Math.max(1, page), totalPages);
  const start      = (safePage - 1) * ITEMS_PER_PAGE;
  const pageItems  = sessions.slice(start, start + ITEMS_PER_PAGE);

  const thumbnail = new ThumbnailBuilder({
    media: { url: client.user.avatarURL({ dynamic: true }) ?? 'https://i.imgur.com/Xo1BHdr.png' },
  });

  const headerSection = new SectionBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`📜 **Historique des sessions**`))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(interaction.guild.name))
    .setThumbnailAccessory(thumbnail);

  const historyLines = pageItems.length
    ? pageItems.map(({ id, game, user, date }) => {
        const ts = Math.floor(new Date(date).getTime() / 1000);
        return `\`#${id}\` **${game}** · ${user} · <t:${ts}:R>`;
      }).join('\n')
    : '_Aucune session dans l\'historique._';

  // ── Boutons de pagination ──────────────────────────────────────────────────
  const prevBtn = new ButtonBuilder()
    .setCustomId(`history_prev_${interaction.user.id}`)
    .setLabel('◀ Retour')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(safePage <= 1);

  const pageBtn = new ButtonBuilder()
    .setCustomId('history_page_noop')
    .setLabel(`Page ${safePage} / ${totalPages}`)
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(true);

  const nextBtn = new ButtonBuilder()
    .setCustomId(`history_next_${interaction.user.id}`)
    .setLabel('Suivant ▶')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(safePage >= totalPages);

  const paginationRow = new ActionRowBuilder().addComponents(prevBtn, pageBtn, nextBtn);

  const container = new ContainerBuilder()
    .addSectionComponents(headerSection)
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(historyLines))
    .addSeparatorComponents(new SeparatorBuilder())
    .addActionRowComponents(paginationRow)
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# ${sessions.length} session(s) au total  ·  ${interaction.guild.name}  ·  /lfg  /stats  /history`
      )
    )
    .setAccentColor(0x1E90FF);

  const payload = { components: [container], flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral] };

  if (isUpdate) {
    await interaction.update(payload);
  } else {
    await interaction.followUp(payload);
  }
}

async function handleHistoryCommand(interaction) {
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  try {
    historyPages.set(interaction.user.id, 1);
    await sendHistoryEmbed(interaction, 1, false);
  } catch (err) {
    console.error('⚠️ Erreur historique:', err);
    await interaction.followUp({ content: "❌ Erreur affichage historique.", flags: [MessageFlags.Ephemeral] });
  }
}

// ──────────────────────────────────────────────────────────────────────────────

async function handleSetLFGChannelCommand(interaction) {
  const { options, guild, member } = interaction;
  if (!member.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return interaction.reply({ content: '❌ Permission insuffisante.', flags: [MessageFlags.Ephemeral] });
  }
  const channel = options.getChannel('channel');
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  try {
    setWithTTL(webhookChannels, guild.id, channel.id, WEBHOOK_TTL);
    await saveData();
    await interaction.followUp({ content: `✅ Salon ${channel} défini pour les annonces LFG cross-serveur.`, flags: [MessageFlags.Ephemeral] });
  } catch (err) {
    console.error('⚠️ Erreur définition salon LFG:', err);
    await interaction.followUp({ content: '❌ Erreur définition salon.', flags: [MessageFlags.Ephemeral] });
  }
}

// ──────────────────────────────────────────────────────────────────────────────

async function handleConfigCommand(interaction) {
  const { options, member, guild } = interaction;

  if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply({ content: '❌ Vous devez avoir la permission **Gérer le serveur** pour configurer le bot.', flags: [MessageFlags.Ephemeral] });
  }

  const action = options.getString('action');
  const game   = options.getString('jeu');

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  try {
    let currentFilter = [...getGuildGameFilter(guild.id)];

    switch (action) {
      case 'add': {
        if (!game) return interaction.followUp({ content: '❌ Veuillez spécifier un jeu à ajouter.', flags: [MessageFlags.Ephemeral] });
        if (currentFilter.includes(game)) return interaction.followUp({ content: `⚠️ **${game}** est déjà dans le filtre.`, flags: [MessageFlags.Ephemeral] });
        currentFilter.push(game);
        setWithTTL(guildGameFilters, guild.id, currentFilter, FILTER_TTL);
        db.prepare('INSERT OR REPLACE INTO guildGameFilters (guildId, games) VALUES (?, ?)').run(guild.id, JSON.stringify(currentFilter));
        return interaction.followUp({ components: [buildConfigContainer(guild, currentFilter, `✅ **${game}** ajouté au filtre.`)], flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral] });
      }

      case 'remove': {
        if (!game) return interaction.followUp({ content: '❌ Veuillez spécifier un jeu à retirer.', flags: [MessageFlags.Ephemeral] });
        if (!currentFilter.includes(game)) return interaction.followUp({ content: `⚠️ **${game}** n'est pas dans le filtre.`, flags: [MessageFlags.Ephemeral] });
        currentFilter = currentFilter.filter(g => g !== game);
        setWithTTL(guildGameFilters, guild.id, currentFilter, FILTER_TTL);
        db.prepare('INSERT OR REPLACE INTO guildGameFilters (guildId, games) VALUES (?, ?)').run(guild.id, JSON.stringify(currentFilter));
        return interaction.followUp({ components: [buildConfigContainer(guild, currentFilter, `✅ **${game}** retiré du filtre.`)], flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral] });
      }

      case 'reset': {
        setWithTTL(guildGameFilters, guild.id, [], FILTER_TTL);
        db.prepare('INSERT OR REPLACE INTO guildGameFilters (guildId, games) VALUES (?, ?)').run(guild.id, '[]');
        return interaction.followUp({ components: [buildConfigContainer(guild, [], '✅ Filtre réinitialisé — tous les jeux sont acceptés.')], flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral] });
      }

      case 'view':
      default: {
        return interaction.followUp({ components: [buildConfigContainer(guild, currentFilter, null)], flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral] });
      }
    }
  } catch (err) {
    console.error('⚠️ Erreur config:', err);
    await interaction.followUp({ content: '❌ Erreur lors de la configuration.', flags: [MessageFlags.Ephemeral] });
  }
}

/**
 * Build the config ContainerBuilder — improved layout.
 */
function buildConfigContainer(guild, filter, statusMessage) {
  const thumbnail = new ThumbnailBuilder({
    media: { url: guild.iconURL({ dynamic: true }) ?? 'https://i.imgur.com/Xo1BHdr.png' },
  });

  const headerSection = new SectionBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`⚙️ **Configuration LFG**`))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(guild.name))
    .setThumbnailAccessory(thumbnail);

  const modeLabel = filter.length === 0
    ? '🌐 **Mode :** Tous les jeux acceptés *(aucun filtre)*'
    : `🔒 **Mode :** Filtre actif — **${filter.length}** jeu(x) autorisé(s)`;

  const gameList = filter.length === 0
    ? '_Aucun filtre configuré. Toutes les sessions LFG sont acceptées._'
    : filter.map(g => `• ${g}`).join('\n');

  const container = new ContainerBuilder().addSectionComponents(headerSection);

  if (statusMessage) {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(statusMessage));
  }

  container
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(modeLabel))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`📋 **Jeux autorisés :**\n${gameList}`)
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '💡 **Commandes rapides :**\n' +
        '`/config action:Ajouter jeu:Valorant` — ajouter un jeu\n' +
        '`/config action:Retirer jeu:Valorant` — retirer un jeu\n' +
        '`/config action:Réinitialiser` — tout accepter'
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# ${guild.name}  ·  /config  /lfg  /stats`)
    )
    .setAccentColor(0x1E90FF);

  return container;
}

// ─────────────────────────────────────────────────────────────────────────────
// Button handlers
// ─────────────────────────────────────────────────────────────────────────────

async function handleJoinButton(interaction) {
  const sessionId   = interaction.customId.split('_')[1];
  const sessionData = lfgSessions.get(sessionId);

  if (!sessionData) {
    return interaction.reply({ content: `❌ Session **#${sessionId}** introuvable.`, flags: [MessageFlags.Ephemeral] });
  }

  const session     = sessionData.value;
  const jud         = lfgJoinedUsers.get(sessionId);
  const joinedUsers = jud ? [...jud.value] : [];

  if (joinedUsers.includes(interaction.user.id)) {
    return interaction.reply({ content: '❌ Vous avez déjà rejoint cette session.', flags: [MessageFlags.Ephemeral] });
  }
  if (joinedUsers.length >= session.players) {
    return interaction.reply({ content: '❌ Cette session est complète.', flags: [MessageFlags.Ephemeral] });
  }

  const voiceChannel = interaction.guild.channels.cache.get(session.voiceChannelId);
  if (!voiceChannel) {
    return interaction.reply({ content: '❌ Salon vocal introuvable.', flags: [MessageFlags.Ephemeral] });
  }

  try {
    joinedUsers.push(interaction.user.id);
    setWithTTL(lfgJoinedUsers, sessionId, joinedUsers, CACHE_TTL);
    db.prepare('INSERT OR REPLACE INTO lfgJoinedUsers (sessionId, userId) VALUES (?, ?)').run(sessionId, interaction.user.id);
    await saveData();

    const infoTextChannel = interaction.guild.channels.cache.get(session.infoTextChannelId);
    if (infoTextChannel && session.infoMessageId) {
      try {
        const infoMessage = await infoTextChannel.messages.fetch(session.infoMessageId);
        await infoMessage.edit({
          flags: MessageFlags.IsComponentsV2,
          components: [buildSessionContainer({
            sessionId,
            label: 'Nouvelle session LFG',
            guildName: interaction.guild.name,
            organizerMention: `<@${session.userId}>`,
            game: session.game,
            platform: session.platform,
            activity: session.activity,
            joinedCount: joinedUsers.length,
            maxPlayers: session.players,
            gametag: session.gametag,
            description: session.description,
            twitchUrl: session.twitchUrl,
            participantsMention: joinedUsers.map(id => `<@${id}>`).join(', '),
            includeJoinButton: joinedUsers.length < session.players,
            includeNavButtons: true,
          })],
          allowedMentions: { parse: [] },
        });
      } catch (err) {
        console.warn('⚠️ MAJ message info impossible:', err.message);
      }
    }

    await interaction.reply({
      content: `✅ Session **#${sessionId}** rejointe ! Rendez-vous dans : ${voiceChannel}`,
      flags: [MessageFlags.Ephemeral],
    });
    updateRichPresence();
  } catch (err) {
    console.error('⚠️ Erreur rejoindre LFG:', err);
    const msg = '❌ Erreur lors de la tentative de rejoindre la session.';
    if (interaction.replied || interaction.deferred) await interaction.followUp({ content: msg, flags: [MessageFlags.Ephemeral] });
    else await interaction.reply({ content: msg, flags: [MessageFlags.Ephemeral] });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isCommand() && !interaction.isButton()) return;

  if (!checkRateLimit(interaction.user.id)) {
    if (!interaction.replied && !interaction.deferred) {
      return interaction.reply({ content: '❌ Limite de débit atteinte. Attendez un moment.', flags: [MessageFlags.Ephemeral] });
    }
    return;
  }

  if (interaction.isCommand()) {
    switch (interaction.commandName) {
      case 'lfg':             return handleLFGCommand(interaction);
      case 'modify_lfg':      return handleModifyLFGCommand(interaction);
      case 'list_members':    return handleListMembersCommand(interaction);
      case 'kick_member':     return handleKickMemberCommand(interaction);
      case 'ban_member':      return handleBanMemberCommand(interaction);
      case 'stats':           return handleStatsCommand(interaction);
      case 'history':         return handleHistoryCommand(interaction);
      case 'set_lfg_channel': return handleSetLFGChannelCommand(interaction);
      case 'config':          return handleConfigCommand(interaction);
      default:
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '❌ Commande inconnue.', flags: [MessageFlags.Ephemeral] });
        }
    }
    return;
  }

  if (interaction.isButton()) {
    // ── Pagination de l'historique ─────────────────────────────────────────
    if (interaction.customId.startsWith('history_prev_') || interaction.customId.startsWith('history_next_')) {
      const parts     = interaction.customId.split('_');   // ['history','prev'/'next', userId]
      const direction = parts[1];                          // 'prev' | 'next'
      const ownerId   = parts[2];

      // Seul l'utilisateur qui a ouvert l'historique peut naviguer
      if (interaction.user.id !== ownerId) {
        return interaction.reply({ content: '❌ Cet historique ne vous appartient pas.', flags: [MessageFlags.Ephemeral] });
      }

      const currentPage = historyPages.get(ownerId) ?? 1;
      const newPage     = direction === 'prev' ? currentPage - 1 : currentPage + 1;
      historyPages.set(ownerId, newPage);

      try {
        await sendHistoryEmbed(interaction, newPage, true);
      } catch (err) {
        console.error('⚠️ Erreur pagination historique:', err);
        if (!interaction.replied && !interaction.deferred)
          await interaction.reply({ content: '❌ Erreur pagination.', flags: [MessageFlags.Ephemeral] });
      }
      return;
    }

    // ── Bouton page (non-cliquable, ne devrait jamais déclencher) ──────────
    if (interaction.customId === 'history_page_noop') {
      return interaction.reply({ content: '​', flags: [MessageFlags.Ephemeral] });
    }

    const [type, sessionId] = interaction.customId.split('_');

    const sessionData = lfgSessions.get(sessionId);
    if (!sessionData) {
      if (!interaction.replied && !interaction.deferred) {
        return interaction.reply({
          content: `❌ Session **#${sessionId}** introuvable. Elle a peut-être expiré.`,
          flags: [MessageFlags.Ephemeral],
        });
      }
      return;
    }

    const session = sessionData.value;

    switch (type) {
      case 'join': return handleJoinButton(interaction);

      case 'vocal': {
        const vc = client.guilds.cache.get(session.guildId)?.channels.cache.get(session.voiceChannelId);
        return interaction.reply({
          content: vc
            ? `🔊 Rejoignez le vocal → **[${vc.name}](https://discord.com/channels/${session.guildId}/${vc.id})**`
            : '❌ Salon vocal introuvable.',
          flags: [MessageFlags.Ephemeral],
        });
      }

      case 'texte': {
        const tc = client.guilds.cache.get(session.guildId)?.channels.cache.get(session.textChannelId);
        return interaction.reply({
          content: tc
            ? `💬 Salon discussion → **[${tc.name}](https://discord.com/channels/${session.guildId}/${tc.id})**`
            : '❌ Salon discussion introuvable.',
          flags: [MessageFlags.Ephemeral],
        });
      }

      case 'info': {
        const ic = client.guilds.cache.get(session.guildId)?.channels.cache.get(session.infoTextChannelId);
        return interaction.reply({
          content: ic
            ? `📢 Salon d'information → **[${ic.name}](https://discord.com/channels/${session.guildId}/${ic.id})**`
            : "❌ Salon d'information introuvable.",
          flags: [MessageFlags.Ephemeral],
        });
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
    if (!guild) {
      console.log(`⚠️ Serveur ${session.guildId} introuvable, suppression session ${sessionId}`);
      lfgSessions.delete(sessionId);
      lfgJoinedUsers.delete(sessionId);
      continue;
    }
    const vc = guild.channels.cache.get(session.voiceChannelId);
    if (!vc) {
      console.log(`⚠️ Canal vocal introuvable pour ${sessionId}, suppression`);
      await deleteLFGSession(sessionId, guild);
      continue;
    }
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

  for (const [sessionId, data] of lfgSessions) {
    if (data.expiresAt && now > data.expiresAt) {
      const guild = client.guilds.cache.get(data.value.guildId);
      if (guild) await deleteLFGSession(sessionId, guild);
    }
    if (now - new Date(data.value.date).getTime() > SESSION_EXPIRY) {
      const guild = client.guilds.cache.get(data.value.guildId);
      if (guild) await deleteLFGSession(sessionId, guild);
    }
  }

  for (const [key, data] of lfgJoinedUsers) {
    if (data.expiresAt && now > data.expiresAt) {
      lfgJoinedUsers.delete(key);
      db.prepare('DELETE FROM lfgJoinedUsers WHERE sessionId = ?').run(key);
    }
  }

  for (const [key, data] of webhookChannels) {
    if (data.expiresAt && now > data.expiresAt) webhookChannels.delete(key);
  }

  for (const [key, data] of guildGameFilters) {
    if (data.expiresAt && now > data.expiresAt) guildGameFilters.delete(key);
  }
}, 60_000);

setInterval(() => {
  const m = process.memoryUsage();
  console.log(`📊 Mémoire — RSS: ${(m.rss / 1024 / 1024).toFixed(1)}MB | Heap: ${(m.heapUsed / 1024 / 1024).toFixed(1)}/${(m.heapTotal / 1024 / 1024).toFixed(1)}MB`);
  console.log(`📈 Caches — sessions: ${lfgSessions.size} | users: ${lfgJoinedUsers.size} | webhooks: ${webhookChannels.size} | filtres: ${guildGameFilters.size}`);
}, 300_000);

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
