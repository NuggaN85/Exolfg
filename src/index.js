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
`);

// ─── In-memory caches ─────────────────────────────────────────────────────────
/** @type {Map<string, { value: object, expiresAt: number }>} */
const lfgSessions     = new Map();
/** @type {Map<string, { value: string[], expiresAt: number }>} */
const lfgJoinedUsers  = new Map();
/** @type {Map<string, { value: string, expiresAt: number }>} */
const webhookChannels = new Map();
/** @type {{ totalSessions: number, totalPlayers: number }} */
const lfgStats        = { totalSessions: 0, totalPlayers: 0 };
/** @type {Record<string, number[]>} */
const rateLimiter     = {};

const SESSION_EXPIRY = 24 * 60 * 60 * 1000; // 24 h
const CACHE_TTL      = 60 * 60 * 1000;       // 1 h
const WEBHOOK_TTL    = 30 * 60 * 1000;       // 30 min
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

/** Store a value in a Map with an expiry timestamp. */
function setWithTTL(map, key, value, ttl) {
  map.set(key, { value, expiresAt: Date.now() + ttl });
}

/**
 * Safely delete a Discord channel, ignoring errors.
 * @param {import('discord.js').GuildChannel|null|undefined} channel
 */
async function safeDeleteChannel(channel) {
  if (!channel?.deletable) return;
  try {
    await channel.delete();
    console.log(`✅ Canal ${channel.id} supprimé.`);
  } catch (err) {
    console.error(`⚠️ Erreur suppression canal ${channel.id}:`, err.message);
  }
}

/**
 * Build the standard session thumbnail section (shared across containers).
 * @param {string} label   - "Nouvelle session LFG" | "Session LFG modifiée" | …
 * @param {string} sessionId
 * @returns {SectionBuilder}
 */
function buildThumbnailSection(label, sessionId) {
  const thumbnail = new ThumbnailBuilder({
    media: { url: client.user.avatarURL({ dynamic: true }) ?? 'https://i.imgur.com/4AvpcjD.png' },
  });
  return new SectionBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(label))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`Session LFG ID-${sessionId}`))
    .setThumbnailAccessory(thumbnail);
}

/**
 * Build the standard set of navigation buttons for a session.
 * @param {string} sessionId
 * @returns {{ row: ActionRowBuilder, buttonRow: ActionRowBuilder }}
 */
function buildSessionButtons(sessionId) {
  const joinButton  = new ButtonBuilder().setCustomId(`join_${sessionId}`).setLabel('Rejoindre la Session').setStyle(ButtonStyle.Primary);
  const vocalButton = new ButtonBuilder().setCustomId(`vocal_${sessionId}`).setLabel('Rejoindre le Vocal').setStyle(ButtonStyle.Primary);
  const texteButton = new ButtonBuilder().setCustomId(`texte_${sessionId}`).setLabel('Salon Discussion').setStyle(ButtonStyle.Primary);
  const infoButton  = new ButtonBuilder().setCustomId(`info_${sessionId}`).setLabel("Salon d'information").setStyle(ButtonStyle.Primary);
  return {
    row:       new ActionRowBuilder().addComponents(joinButton),
    buttonRow: new ActionRowBuilder().addComponents(vocalButton, texteButton, infoButton),
  };
}

/**
 * Build the full session ContainerBuilder.
 * @param {object} opts
 * @returns {ContainerBuilder}
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
  participantsMention,
  includeJoinButton = true,
  includeNavButtons = true,
}) {
  const hexColor       = 0x1E90FF;
  const sectionThumb   = buildThumbnailSection(label, sessionId);
  const { row, buttonRow } = buildSessionButtons(sessionId);
  const textFooter = new TextDisplayBuilder().setContent(
    `⚠️ Salon supprimé après 5 min si vide\n${guildName} • /lfg • /stats • /history`
  );

  const container = new ContainerBuilder()
    .addSectionComponents(sectionThumb)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`👑 **Organisateur :** ${organizerMention}`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`🎮 **Jeu :** ${game}`))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`💻 **Plate-forme :** ${platform}`))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`🏆 **Activité :** ${activity}`))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`👥 **Joueurs :** ${joinedCount}/${maxPlayers}`))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`🎯 **Gametag :** ${gametag}`))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`📝 **Description :** ${description}`))
    .addSeparatorComponents(new SeparatorBuilder())
    .setAccentColor(hexColor);

  if (includeNavButtons) container.addActionRowComponents(buttonRow).addSeparatorComponents(new SeparatorBuilder());
  if (participantsMention !== undefined) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`👥 **Participants :** ${participantsMention}`));
  }
  container.addTextDisplayComponents(textFooter);
  if (includeJoinButton) container.addActionRowComponents(row);

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

    db.transaction(() => {
      for (const [id, data] of lfgSessions) {
        // eslint-disable-next-line no-unused-vars
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
    console.log(`✅ ${users.length} utilisateur(s) chargé(s).`);

    const stats = db.prepare('SELECT totalSessions, totalPlayers FROM lfgStats LIMIT 1').get() ?? { totalSessions: 0, totalPlayers: 0 };
    Object.assign(lfgStats, stats);
    console.log('✅ Stats chargées:', lfgStats);

    const webhooks = db.prepare('SELECT guildId, channelId FROM webhookChannels').all();
    for (const w of webhooks) setWithTTL(webhookChannels, w.guildId, w.channelId, WEBHOOK_TTL);
    console.log(`✅ ${webhooks.length} webhook(s) chargé(s).`);
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
        { name: 'description', description: 'Description',           type: 3, required: false },
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
    {
      name: 'history',
      description: "Afficher l'historique des sessions LFG",
      options: [
        { name: 'page', description: "Page de l'historique", type: 4, required: false, min_value: 1 },
      ],
    },
    {
      name: 'set_lfg_channel',
      description: 'Définir le salon pour les annonces LFG',
      options: [
        { name: 'channel', description: 'Salon pour les annonces', type: 7, required: true, channel_types: [ChannelType.GuildText] },
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
  const sessionId   = Math.floor(1000 + Math.random() * 9000).toString();

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  try {
    // ── Create Discord channels ──────────────────────────────────────────────
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
      content: `Bienvenue dans le salon de discussion pour la session LFG ${sessionId} !`,
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

    // ── Build containers ─────────────────────────────────────────────────────
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
    };

    const infoContainer = buildSessionContainer({
      ...commonOpts,
      label: 'Nouvelle session LFG',
      participantsMention: `<@${user.id}>`,
    });

    const commandContainer = buildSessionContainer({
      ...commonOpts,
      label: 'Nouvelle session LFG',
      includeJoinButton: false,
    });

    // ── Send messages ────────────────────────────────────────────────────────
    const infoMessage = await infoTextChannel.send({
      flags: MessageFlags.IsComponentsV2,
      components: [infoContainer],
      allowedMentions: { parse: [] },
    });
    await infoMessage.pin();

    await infoTextChannel.send({
      content: `Bienvenue dans le salon d'information pour la session LFG ${sessionId} !`,
      allowedMentions: { parse: [] },
    });

    const commandChannelMessage = await channel.send({
      flags: MessageFlags.IsComponentsV2,
      components: [commandContainer],
      allowedMentions: { parse: [] },
    });

    // ── Cross-server announcements ───────────────────────────────────────────
    // joinedUsers for this brand-new session = [user.id] (1 member)
    const initialJoinedUsers = [user.id];

    for (const [guildId, webhookData] of webhookChannels) {
      if (guildId === guild.id) continue;
      try {
        const targetGuild   = client.guilds.cache.get(guildId);
        const targetChannel = targetGuild?.channels.cache.get(webhookData.value);
        if (!targetChannel?.isTextBased()) continue;

        const announceContainer = buildSessionContainer({
          ...commonOpts,
          label: 'Nouvelle session LFG',
          organizerMention: `${user.tag}`,          // No ping on foreign servers
          joinedCount: initialJoinedUsers.length,
          includeJoinButton: false,
          includeNavButtons: false,
          participantsMention: undefined,
        });
        // Add server origin line
        const sectionThumb = buildThumbnailSection('Nouvelle session LFG', sessionId);
        const crossContainer = new ContainerBuilder()
          .addSectionComponents(sectionThumb)
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`👑 **Organisateur :** ${user.tag}`))
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`🎮 **Jeu :** ${game}`))
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`💻 **Plate-forme :** ${platform}`))
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`🏆 **Activité :** ${activity}`))
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`👥 **Joueurs :** ${initialJoinedUsers.length}/${players}`))
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`🎯 **Gametag :** ${gametag}`))
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`📝 **Description :** ${description}`))
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`🌐 **Serveur :** ${guild.name}`))
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `⚠️ Session hébergée sur un autre serveur\n${guild.name} • /lfg • /stats • /history`
          ))
          .setAccentColor(0x1E90FF);

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

    // ── Persist session ──────────────────────────────────────────────────────
    const sessionData = {
      userId: user.id,
      user: user.tag,
      game, platform, activity, gametag, description,
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
      content: `✅ Session **${sessionId}** créée ! Voir ${textChannel} et ${infoTextChannel}.`,
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
    };

    // Update info channel message
    const infoTextChannel = guild.channels.cache.get(session.infoTextChannelId);
    if (infoTextChannel && session.infoMessageId) {
      try {
        const infoMessage = await infoTextChannel.messages.fetch(session.infoMessageId);
        await infoMessage.edit({
          flags: MessageFlags.IsComponentsV2,
          components: [buildSessionContainer({ ...commonOpts, label: 'Session LFG modifiée', participantsMention })],
          allowedMentions: { parse: [] },
        });
      } catch (err) {
        console.warn(`⚠️ Impossible MAJ message info:`, err.message);
      }
    }

    // Update command channel message
    const commandChannel = guild.channels.cache.get(session.commandChannelId);
    if (commandChannel && session.commandChannelMessageId) {
      try {
        const commandMessage = await commandChannel.messages.fetch(session.commandChannelMessageId);
        await commandMessage.edit({
          flags: MessageFlags.IsComponentsV2,
          components: [buildSessionContainer({ ...commonOpts, label: 'Session LFG modifiée', includeJoinButton: false })],
          allowedMentions: { parse: [] },
        });
      } catch (err) {
        console.warn(`⚠️ Impossible MAJ message commande:`, err.message);
      }
    }

    await saveData();
    await interaction.followUp({ content: `✅ Session **${sessionId}** modifiée.`, flags: [MessageFlags.Ephemeral] });
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
    const voiceChannel = interaction.guild.channels.cache.get(sessionData.value.voiceChannelId);
    const members      = voiceChannel?.members.map(m => m.user.tag) ?? [];
    const start        = (page - 1) * ITEMS_PER_PAGE;
    const pageItems    = members.slice(start, start + ITEMS_PER_PAGE);
    const totalPages   = Math.max(1, Math.ceil(members.length / ITEMS_PER_PAGE));

    const sectionThumb = buildThumbnailSection('Liste des membres', sessionId);
    const container = new ContainerBuilder()
      .addSectionComponents(sectionThumb)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `👥 **Membres :**\n${pageItems.length ? pageItems.join('\n') : 'Aucun membre'}`
      ))
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `📊 **Total :** ${members.length} membre(s) | Page ${page}/${totalPages}`
      ))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `${interaction.guild.name} • /lfg • /stats • /history`
      ))
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
    await interaction.reply({ content: `✅ **${targetMember.user.tag}** retiré de la session ${sessionId}.`, flags: [MessageFlags.Ephemeral] });
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
    await interaction.reply({ content: `✅ **${targetMember.user.tag}** banni de la session ${sessionId}.`, flags: [MessageFlags.Ephemeral] });
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
    const sectionThumb = buildThumbnailSection('Statistiques', 'global');
    // Override thumbnail media with guild icon
    const sectionThumbGuild = new SectionBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent('Résumé des sessions'))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent('Statistiques LFG'))
      .setThumbnailAccessory(new ThumbnailBuilder({
        media: { url: interaction.guild.iconURL({ dynamic: true }) ?? 'https://i.imgur.com/4AvpcjD.png' },
      }));

    const container = new ContainerBuilder()
      .addSectionComponents(sectionThumbGuild)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`📊 **Sessions créées :** ${lfgStats.totalSessions}`))
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`👥 **Joueurs totaux :** ${lfgStats.totalPlayers}`))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`🎮 **Sessions actives :** ${lfgSessions.size}`))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${interaction.guild.name} • /lfg • /stats • /history`))
      .setAccentColor(0x1E90FF);

    await interaction.followUp({ components: [container], flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral] });
  } catch (err) {
    console.error('⚠️ Erreur stats:', err);
    await interaction.followUp({ content: '❌ Erreur affichage stats.', flags: [MessageFlags.Ephemeral] });
  }
}

// ──────────────────────────────────────────────────────────────────────────────

async function handleHistoryCommand(interaction) {
  const page = interaction.options.getInteger('page') ?? 1;
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  try {
    const sessions    = Array.from(lfgSessions.values()).map(d => d.value);
    const totalPages  = Math.max(1, Math.ceil(sessions.length / ITEMS_PER_PAGE));
    const start       = (page - 1) * ITEMS_PER_PAGE;
    const pageItems   = sessions.slice(start, start + ITEMS_PER_PAGE);

    const sectionThumb = new SectionBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent('Sessions récentes'))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent('Historique des sessions LFG'))
      .setThumbnailAccessory(new ThumbnailBuilder({
        media: { url: client.user.avatarURL({ dynamic: true }) ?? 'https://i.imgur.com/4AvpcjD.png' },
      }));

    const container = new ContainerBuilder()
      .addSectionComponents(sectionThumb)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        pageItems.length
          ? pageItems.map(s => `🎮 **${s.game}** — ${s.user} — <t:${Math.floor(new Date(s.date).getTime() / 1000)}:R>`).join('\n')
          : 'Aucune session.'
      ))
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `📊 **Total :** ${sessions.length} session(s) | Page ${page}/${totalPages}`
      ))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `${interaction.guild.name} • /lfg • /stats • /history`
      ))
      .setAccentColor(0x1E90FF);

    await interaction.followUp({ components: [container], flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral] });
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
    await interaction.followUp({ content: `✅ Salon ${channel} défini pour les annonces LFG.`, flags: [MessageFlags.Ephemeral] });
  } catch (err) {
    console.error('⚠️ Erreur définition salon LFG:', err);
    await interaction.followUp({ content: '❌ Erreur définition salon.', flags: [MessageFlags.Ephemeral] });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Button handlers
// ─────────────────────────────────────────────────────────────────────────────

async function handleJoinButton(interaction) {
  const sessionId   = interaction.customId.split('_')[1];
  const sessionData = lfgSessions.get(sessionId);

  if (!sessionData) {
    return interaction.reply({ content: `❌ Session ${sessionId} introuvable.`, flags: [MessageFlags.Ephemeral] });
  }

  const session     = sessionData.value;
  const jud         = lfgJoinedUsers.get(sessionId);
  const joinedUsers = jud ? [...jud.value] : [];

  if (joinedUsers.includes(interaction.user.id)) {
    return interaction.reply({ content: '❌ Vous avez déjà rejoint cette session.', flags: [MessageFlags.Ephemeral] });
  }
  if (joinedUsers.length >= session.players) {
    return interaction.reply({ content: '❌ Session pleine.', flags: [MessageFlags.Ephemeral] });
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

    // Refresh info message
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
            participantsMention: joinedUsers.map(id => `<@${id}>`).join(', '),
          })],
          allowedMentions: { parse: [] },
        });
      } catch (err) {
        console.warn('⚠️ MAJ message info impossible:', err.message);
      }
    }

    await interaction.reply({
      content: `✅ Session rejointe ! Rejoignez le salon vocal : ${voiceChannel}`,
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

  // ── Slash commands ──────────────────────────────────────────────────────────
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
      default:
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '❌ Commande inconnue.', flags: [MessageFlags.Ephemeral] });
        }
    }
    return;
  }

  // ── Button interactions ─────────────────────────────────────────────────────
  if (interaction.isButton()) {
    const [type, sessionId] = interaction.customId.split('_');

    const sessionData = lfgSessions.get(sessionId);
    if (!sessionData) {
      if (!interaction.replied && !interaction.deferred) {
        return interaction.reply({
          content: `❌ Session ${sessionId} introuvable. Elle a peut-être expiré.`,
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
            ? `🔊 **[${vc.name}](https://discord.com/channels/${session.guildId}/${vc.id})**`
            : '❌ Salon vocal introuvable.',
          flags: [MessageFlags.Ephemeral],
        });
      }

      case 'texte': {
        const tc = client.guilds.cache.get(session.guildId)?.channels.cache.get(session.textChannelId);
        return interaction.reply({
          content: tc
            ? `💬 **[${tc.name}](https://discord.com/channels/${session.guildId}/${tc.id})**`
            : '❌ Salon discussion introuvable.',
          flags: [MessageFlags.Ephemeral],
        });
      }

      case 'info': {
        const ic = client.guilds.cache.get(session.guildId)?.channels.cache.get(session.infoTextChannelId);
        return interaction.reply({
          content: ic
            ? `📢 **[${ic.name}](https://discord.com/channels/${session.guildId}/${ic.id})**`
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

  // Remove sessions whose channels no longer exist
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

  // Rate-limiter cleanup
  for (const userId of Object.keys(rateLimiter)) {
    rateLimiter[userId] = rateLimiter[userId].filter(ts => now - ts < 60_000);
    if (!rateLimiter[userId].length) delete rateLimiter[userId];
  }

  // Expired sessions
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

  // Expired joined users cache
  for (const [key, data] of lfgJoinedUsers) {
    if (data.expiresAt && now > data.expiresAt) {
      lfgJoinedUsers.delete(key);
      db.prepare('DELETE FROM lfgJoinedUsers WHERE sessionId = ?').run(key);
    }
  }

  // Expired webhook cache
  for (const [key, data] of webhookChannels) {
    if (data.expiresAt && now > data.expiresAt) webhookChannels.delete(key);
  }
}, 60_000);

// Memory monitor
setInterval(() => {
  const m = process.memoryUsage();
  console.log(`📊 Mémoire — RSS: ${(m.rss / 1024 / 1024).toFixed(1)}MB | Heap: ${(m.heapUsed / 1024 / 1024).toFixed(1)}/${(m.heapTotal / 1024 / 1024).toFixed(1)}MB`);
  console.log(`📈 Caches — sessions: ${lfgSessions.size} | users: ${lfgJoinedUsers.size} | webhooks: ${webhookChannels.size}`);
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
