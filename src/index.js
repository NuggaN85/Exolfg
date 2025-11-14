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

// Configuration des variables d'environnement
dotenv.config();

// Validation des variables d'environnement
if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID) {
  throw new Error("⚠️ Les variables d'environnement DISCORD_TOKEN et CLIENT_ID sont obligatoires.");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// Initialisation de la base de données SQLite
const db = new Database('lfgData.db');

// Création des tables si elles n'existent pas
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

// Initialisation des Maps pour la gestion en mémoire
const lfgSessions = new Map();
const lfgStats = { totalSessions: 0, totalPlayers: 0 };
const lfgJoinedUsers = new Map();
const webhookChannels = new Map();
const rateLimiter = {};
const SESSION_EXPIRY = 24 * 60 * 60 * 1000; // 24 heures
const CACHE_TTL = 60 * 60 * 1000; // 1 heure pour les sessions
const WEBHOOK_TTL = 30 * 60 * 1000; // 30 minutes pour les webhooks
const ITEMS_PER_PAGE = 10;

// Liste des jeux supportés
const gameChoices = [
  { name: 'League of Legends', value: 'League of Legends' },
  { name: 'Valorant', value: 'Valorant' },
  { name: 'Rainbow Six: Siège', value: 'Rainbow Six: Siège' },
  { name: 'Apex Legends', value: 'Apex Legends' },
  { name: 'Rocket League', value: 'Rocket League' },
  { name: 'Brawlhalla', value: 'Brawlhalla' },
  { name: 'COD: Warzone', value: 'COD: Warzone' },
  { name: 'Fortnite', value: 'Fortnite' },
  { name: 'Overwatch 2', value: 'Overwatch 2' },
  { name: 'Paladins', value: 'Paladins' },
  { name: 'Albion Online', value: 'Albion Online' },
];

// Fonction pour définir avec TTL
const setWithTTL = (map, key, value, ttl) => {
  map.set(key, { value, expiresAt: Date.now() + ttl });
};

// Nettoyage périodique des entrées expirées
setInterval(() => {
  const now = Date.now();
  
  // Nettoyage de lfgSessions
  for (const [key, data] of lfgSessions) {
    if (data.expiresAt && now > data.expiresAt) {
      const guild = client.guilds.cache.get(data.value.guildId);
      if (guild) deleteLFGSession(key, guild);
    }
  }

  // Nettoyage de lfgJoinedUsers
  for (const [key, data] of lfgJoinedUsers) {
    if (data.expiresAt && now > data.expiresAt) {
      lfgJoinedUsers.delete(key);
      db.prepare('DELETE FROM lfgJoinedUsers WHERE sessionId = ?').run(key);
    }
  }

  // Nettoyage de webhookChannels
  for (const [key, data] of webhookChannels) {
    if (data.expiresAt && now > data.expiresAt) {
      webhookChannels.delete(key);
      db.prepare('DELETE FROM webhookChannels WHERE guildId = ?').run(key);
    }
  }
}, 60000); // Vérification toutes les minutes

// Surveillance de la mémoire
setInterval(() => {
  const used = process.memoryUsage();
  console.log(`📊 Utilisation mémoire: RSS=${(used.rss / 1024 / 1024).toFixed(2)}MB, HeapTotal=${(used.heapTotal / 1024 / 1024).toFixed(2)}MB, HeapUsed=${(used.heapUsed / 1024 / 1024).toFixed(2)}MB`);
  console.log(`📈 Taille des caches: lfgSessions=${lfgSessions.size}, lfgJoinedUsers=${lfgJoinedUsers.size}, webhookChannels=${webhookChannels.size}`);
}, 300000); // Vérification toutes les 5 minutes

// Charger les données au démarrage
async function loadData() {
  try {
    // Charger lfgSessions
    const sessions = db.prepare('SELECT * FROM lfgSessions').all();
    for (const session of sessions) {
      setWithTTL(lfgSessions, session.id, { ...session, timeoutId: null }, CACHE_TTL);
    }
    console.log('✅ Sessions chargées:', Array.from(lfgSessions.entries()));

    // Charger lfgJoinedUsers
    const users = db.prepare('SELECT sessionId, userId FROM lfgJoinedUsers').all();
    for (const user of users) {
      const existing = lfgJoinedUsers.get(user.sessionId);
      if (!existing) {
        setWithTTL(lfgJoinedUsers, user.sessionId, [user.userId], CACHE_TTL);
      } else {
        existing.value.push(user.userId);
        lfgJoinedUsers.set(user.sessionId, existing);
      }
    }
    console.log('✅ Utilisateurs chargés:', Object.fromEntries(lfgJoinedUsers));

    // Charger lfgStats
    const stats = db.prepare('SELECT totalSessions, totalPlayers FROM lfgStats LIMIT 1').get() || {
      totalSessions: 0,
      totalPlayers: 0,
    };
    Object.assign(lfgStats, stats);
    console.log('✅ Stats chargées:', lfgStats);

    // Charger webhookChannels
    const webhooks = db.prepare('SELECT guildId, channelId FROM webhookChannels').all();
    for (const webhook of webhooks) {
      setWithTTL(webhookChannels, webhook.guildId, webhook.channelId, WEBHOOK_TTL);
    }
    console.log('✅ Webhooks chargés:', Object.fromEntries(webhookChannels));
  } catch (error) {
    console.error('⚠️ Erreur chargement données:', error);
  }
}

// Sauvegarder les données
async function saveData() {
  try {
    const insertSession = db.prepare(`
      INSERT OR REPLACE INTO lfgSessions (
        id, userId, user, game, platform, activity, gametag, description, date,
        players, categoryId, voiceChannelId, textChannelId, infoTextChannelId,
        infoMessageId, commandChannelId, commandChannelMessageId, guildId
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertUser = db.prepare('INSERT OR REPLACE INTO lfgJoinedUsers (sessionId, userId) VALUES (?, ?)');
    const deleteUsers = db.prepare('DELETE FROM lfgJoinedUsers WHERE sessionId = ?');
    const updateStats = db.prepare('INSERT OR REPLACE INTO lfgStats (id, totalSessions, totalPlayers) VALUES (1, ?, ?)');
    const insertWebhook = db.prepare('INSERT OR REPLACE INTO webhookChannels (guildId, channelId) VALUES (?, ?)');

    const transaction = db.transaction(() => {
      // Sauvegarder lfgSessions
      for (const [id, data] of lfgSessions) {
        const { timeoutId, ...serializableSession } = data.value;
        insertSession.run(
          id,
          serializableSession.userId,
          serializableSession.user,
          serializableSession.game,
          serializableSession.platform,
          serializableSession.activity,
          serializableSession.gametag,
          serializableSession.description,
          serializableSession.date,
          serializableSession.players,
          serializableSession.categoryId,
          serializableSession.voiceChannelId,
          serializableSession.textChannelId,
          serializableSession.infoTextChannelId,
          serializableSession.infoMessageId,
          serializableSession.commandChannelId,
          serializableSession.commandChannelMessageId,
          serializableSession.guildId
        );
      }

      // Sauvegarder lfgJoinedUsers
      for (const [sessionId, data] of lfgJoinedUsers) {
        const users = data.value;
        deleteUsers.run(sessionId);
        for (const userId of users) {
          insertUser.run(sessionId, userId);
        }
      }

      // Sauvegarder lfgStats
      updateStats.run(lfgStats.totalSessions, lfgStats.totalPlayers);

      // Sauvegarder webhookChannels
      for (const [guildId, data] of webhookChannels) {
        insertWebhook.run(guildId, data.value);
      }
    });

    transaction();
    console.log('✅ Données sauvegardées dans la base de données SQLite');
  } catch (error) {
    console.error('⚠️ Erreur sauvegarde données:', error);
  }
}

// Nettoyage périodique du rate limiter et des sessions obsolètes
setInterval(async () => {
  const now = Date.now();
  for (const userId in rateLimiter) {
    rateLimiter[userId] = rateLimiter[userId].filter((ts) => now - ts < 60000);
    if (!rateLimiter[userId].length) delete rateLimiter[userId];
  }
  for (const [sessionId, data] of lfgSessions) {
    const session = data.value;
    if (now - new Date(session.date).getTime() > SESSION_EXPIRY) {
      const guild = client.guilds.cache.get(session.guildId);
      if (guild) await deleteLFGSession(sessionId, guild);
    }
  }
}, 60000);

// Réinitialisation du timeout de suppression
function resetTimeout(sessionId, guild) {
  const sessionData = lfgSessions.get(sessionId);
  if (!sessionData) return;

  const session = sessionData.value;
  if (session.timeoutId) {
    clearTimeout(session.timeoutId);
    console.log(`❌ Timeout annulé pour ${sessionId}`);
  }

  session.timeoutId = setTimeout(async () => {
    const voiceChannel = guild.channels.cache.get(session.voiceChannelId);
    if (!voiceChannel || voiceChannel.members.size === 0) {
      console.log(`🔄 Salon vide pour ${sessionId}. Suppression...`);
      await deleteLFGSession(sessionId, guild);
    } else {
      console.log(`❌ Salon non vide pour ${sessionId}.`);
    }
  }, 5 * 60 * 1000);
  
  setWithTTL(lfgSessions, sessionId, session, CACHE_TTL);
}

// Suppression sécurisée d’un canal
async function safeDeleteChannel(channel) {
  if (!channel || !channel.deletable) return;
  try {
    await channel.delete();
    console.log(`✅ Canal ${channel.id} supprimé.`);
  } catch (error) {
    console.error(`⚠️ Erreur suppression canal ${channel.id}:`, error);
  }
}

// Suppression d’une session LFG
async function deleteLFGSession(sessionId, guild) {
  const sessionData = lfgSessions.get(sessionId);
  if (!sessionData) return;

  const session = sessionData.value;

  try {
    if (session.timeoutId) clearTimeout(session.timeoutId);

    const channels = [
      guild.channels.cache.get(session.voiceChannelId),
      guild.channels.cache.get(session.textChannelId),
      guild.channels.cache.get(session.infoTextChannelId),
      guild.channels.cache.get(session.categoryId),
    ];

    for (const channel of channels) await safeDeleteChannel(channel);

    const deleteSession = db.prepare('DELETE FROM lfgSessions WHERE id = ?');
    const deleteUsers = db.prepare('DELETE FROM lfgJoinedUsers WHERE sessionId = ?');
    const transaction = db.transaction(() => {
      deleteSession.run(sessionId);
      deleteUsers.run(sessionId);
    });
    transaction();

    lfgSessions.delete(sessionId);
    lfgJoinedUsers.delete(sessionId);
    await saveData();
    console.log(`✅ Session ${sessionId} supprimée du serveur et de la base de données.`);
  } catch (error) {
    console.error(`⚠️ Erreur suppression session ${sessionId}:`, error);
  }
}

// Mise à jour de la Rich Presence
async function updateRichPresence() {
  try {
    const totalSessions = lfgSessions.size;
    const totalPlayers = Array.from(lfgJoinedUsers.values()).reduce((acc, data) => acc + (data.value || []).length, 0);

    client.user?.setPresence({
      activities: [{ name: `Sessions: ${totalSessions} | Joueurs: ${totalPlayers}`, type: ActivityType.Playing }],
      status: 'online',
    });
  } catch (error) {
    console.error('⚠️ Erreur Rich Presence:', error);
  }
}

// Vérification de la limite de débit
function checkRateLimit(userId) {
  const now = Date.now();
  const limit = 5;
  const interval = 60000;

  rateLimiter[userId] = (rateLimiter[userId] || []).filter((ts) => now - ts < interval);
  if (rateLimiter[userId].length >= limit) return false;

  rateLimiter[userId].push(now);
  return true;
}

// Enregistrement des commandes slash
async function registerCommands() {
  const commands = [
    {
      name: 'lfg',
      description: 'Créer une session LFG',
      options: [
        { name: 'jeux', description: 'Jeu', type: 3, required: true, choices: gameChoices },
        {
          name: 'plateforme',
          description: 'Plate-forme',
          type: 3,
          required: true,
          choices: [
            { name: 'PC', value: 'PC' },
            { name: 'Console', value: 'Console' },
            { name: 'Mobile', value: 'Mobile' },
          ],
        },
        { name: 'joueurs', description: 'Nombre de joueurs', type: 4, required: true, min_value: 1, max_value: 10 },
        { name: 'gametag', description: 'Gametag', type: 3, required: true },
        {
          name: 'activite',
          description: 'Activité',
          type: 3,
          required: true,
          choices: [
            { name: 'Normale', value: 'Normale' },
            { name: 'Classé', value: 'Classé' },
          ],
        },
        { name: 'description', description: 'Description', type: 3, required: false },
      ],
    },
    {
      name: 'modify_lfg',
      description: 'Modifier une session LFG',
      options: [
        { name: 'session_id', description: 'ID de la session', type: 3, required: true },
        { name: 'joueurs', description: 'Nombre de joueurs', type: 4, required: true, min_value: 1, max_value: 10 },
        { name: 'description', description: 'Description', type: 3, required: true },
      ],
    },
    {
      name: 'list_members',
      description: 'Lister les membres d’une session LFG',
      options: [
        { name: 'session_id', description: 'ID de la session', type: 3, required: true },
        { name: 'page', description: 'Page des membres', type: 4, required: false, min_value: 1 },
      ],
    },
    {
      name: 'kick_member',
      description: 'Retirer un membre d’une session LFG',
      options: [
        { name: 'session_id', description: 'ID de la session', type: 3, required: true },
        { name: 'member', description: 'Membre à retirer', type: 6, required: true },
      ],
    },
    {
      name: 'ban_member',
      description: 'Bannir un membre d’une session LFG',
      options: [
        { name: 'session_id', description: 'ID de la session', type: 3, required: true },
        { name: 'member', description: 'Membre à bannir', type: 6, required: true },
      ],
    },
    {
      name: 'stats',
      description: 'Afficher les statistiques des sessions LFG',
    },
    {
      name: 'history',
      description: 'Afficher l’historique des sessions LFG',
      options: [
        { name: 'page', description: 'Page de l’historique', type: 4, required: false, min_value: 1 },
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
  } catch (error) {
    console.error('⚠️ Erreur enregistrement commandes:', error);
  }
}

// Gestionnaires de commandes
async function handleLFGCommand(interaction) {
  const { options, member, guild, channel, user } = interaction;
  const players = options.getInteger('joueurs');
  const description = options.getString('description') || 'Pas de description';
  const platform = options.getString('plateforme');
  const gametag = options.getString('gametag');
  const activity = options.getString('activite');
  const game = options.getString('jeux');
  const randomNumber = Math.floor(1000 + Math.random() * 9000).toString();

  if (!member.permissions.has(PermissionFlagsBits.ManageChannels)) {
    if (!interaction.replied && !interaction.deferred) {
      return interaction.reply({ content: '❌ Permission insuffisante.', flags: [MessageFlags.Ephemeral] });
    }
    return;
  }

  try {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    const category = await guild.channels.create({
      name: `🎮-${randomNumber}-LFG`,
      type: ChannelType.GuildCategory,
      permissionOverwrites: [
        { id: guild.id, allow: [PermissionFlagsBits.ViewChannel] },
        { id: client.user.id, allow: [PermissionFlagsBits.ManageChannels] },
      ],
    });

    const textChannel = await guild.channels.create({
      name: `📝-${randomNumber}-discussion`,
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: [
        { id: guild.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
        { id: client.user.id, allow: [PermissionFlagsBits.ManageChannels] },
      ],
    });

    // Envoyer un message de bienvenue dans le salon de discussion
    await textChannel.send({
      content: `Bienvenue dans le salon de discussion pour la session LFG ${randomNumber} !`,
      allowedMentions: { parse: [] },
    });

    const voiceChannel = await guild.channels.create({
      name: `🔊-${randomNumber}-LFG`,
      type: ChannelType.GuildVoice,
      parent: category.id,
      userLimit: players + 1,
      permissionOverwrites: [
        { id: guild.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
        { id: client.user.id, allow: [PermissionFlagsBits.ManageChannels] },
      ],
    });

    const infoTextChannel = await guild.channels.create({
      name: `📢-${randomNumber}-info`,
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: [
        { id: guild.id, allow: [PermissionFlagsBits.ViewChannel] },
        { id: client.user.id, allow: [PermissionFlagsBits.ManageChannels] },
      ],
    });

    const joinButton = new ButtonBuilder()
      .setCustomId(`join_${randomNumber}`)
      .setLabel('Rejoindre la Session')
      .setStyle(ButtonStyle.Primary);

    const vocalButton = new ButtonBuilder()
      .setCustomId(`vocal_${randomNumber}`)
      .setLabel('Rejoindre le Vocal')
      .setStyle(ButtonStyle.Primary);

    const texteButton = new ButtonBuilder()
      .setCustomId(`texte_${randomNumber}`)
      .setLabel('Salon Discution')
      .setStyle(ButtonStyle.Primary);

    const infoButton = new ButtonBuilder()
      .setCustomId(`info_${randomNumber}`)
      .setLabel('Salon d\'information')
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(joinButton);
    const buttonRow = new ActionRowBuilder().addComponents(vocalButton, texteButton, infoButton);

    const hexColor = 0x1E90FF;
    const textTitle = new TextDisplayBuilder().setContent(`Session LFG ID-${randomNumber}`);
    const textAuthor = new TextDisplayBuilder().setContent(`Nouvelle session LFG`);
    const textFooter = new TextDisplayBuilder().setContent(`⚠️ Salon supprimé après 5 min si vide\n${guild.name} • /lfg • /stats • /history`);
    const thumbnail = new ThumbnailBuilder({
      media: { url: client.user.avatarURL({ dynamic: true }) || 'https://i.imgur.com/4AvpcjD.png' },
    });

    const sectionThumbnail = new SectionBuilder()
      .addTextDisplayComponents(textAuthor)
      .addTextDisplayComponents(textTitle)
      .setThumbnailAccessory(thumbnail);

    const container = new ContainerBuilder()
      .addSectionComponents(sectionThumbnail)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`👑 **Organisateur :** ${user}`))
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`🎮 **Jeu :** ${game}`))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`💻 **Plate-forme :** ${platform}`))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`🏆 **Activité :** ${activity}`))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`👥 **Joueurs :** ${players}/${players}`))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`🎯 **Gametag :** ${gametag}`))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`📝 **Description :** ${description}`))
      .addSeparatorComponents(new SeparatorBuilder())
      .addActionRowComponents(buttonRow)
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`👥 **Participants :** <@${user.id}>`))
      .addTextDisplayComponents(textFooter)
      .setAccentColor(hexColor)
      .addActionRowComponents(row);

    const infoMessage = await infoTextChannel.send({
      flags: MessageFlags.IsComponentsV2,
      components: [container],
      allowedMentions: { parse: [] },
    });
    await infoMessage.pin();

    // Envoyer le message de bienvenue dans le salon d'information
    await infoTextChannel.send({
      content: `Bienvenue dans le salon d'information pour la session LFG ${randomNumber} !`,
      allowedMentions: { parse: [] },
    });

    const commandContainer = new ContainerBuilder()
      .addSectionComponents(sectionThumbnail)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`👑 **Organisateur :** ${user}`))
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`🎮 **Jeu :** ${game}`))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`💻 **Plate-forme :** ${platform}`))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`🏆 **Activité :** ${activity}`))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`👥 **Joueurs :** ${players}/${players}`))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`🎯 **Gametag :** ${gametag}`))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`📝 **Description :** ${description}`))
      .addSeparatorComponents(new SeparatorBuilder())
      .addActionRowComponents(buttonRow)
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`👥 **Participants :** <@${user.id}>`))
      .addTextDisplayComponents(textFooter)
      .setAccentColor(hexColor);

    const commandChannelMessage = await channel.send({
      flags: MessageFlags.IsComponentsV2,
      components: [commandContainer],
      allowedMentions: { parse: [] },
    });

    // Envoyer l'annonce à tous les serveurs sauf celui où la commande a été exécutée
    for (const [guildId, data] of webhookChannels) {
      const channelId = data.value;
      if (guildId === guild.id) continue;
      try {
        const targetGuild = client.guilds.cache.get(guildId);
        const targetChannel = targetGuild?.channels.cache.get(channelId);
        if (targetChannel && targetChannel.isTextBased()) {
          const webhook = await targetChannel.createWebhook({
            name: 'LFG Annonce',
            avatar: client.user.avatarURL(),
          });

          await webhook.send({
            components: [commandContainer],
            flags: MessageFlags.IsComponentsV2,
            username: client.user.username,
            avatarURL: client.user.avatarURL(),
            allowedMentions: { parse: [] },
          });

          await webhook.delete();
          console.log(`✅ Annonce envoyée à ${targetChannel.name} sur ${targetGuild.name}`);
        }
      } catch (error) {
        console.error(`⚠️ Erreur envoi annonce à ${guildId}:`, error);
      }
    }

    await interaction.followUp({ content: `✅ Session créée ! Voir ${textChannel} et ${infoTextChannel}.`, flags: [MessageFlags.Ephemeral] });

    const sessionData = {
      userId: user.id,
      user: user.tag,
      game,
      platform,
      activity,
      gametag,
      description,
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
    setWithTTL(lfgSessions, randomNumber, sessionData, CACHE_TTL);
    console.log(`✅ Session créée: ${randomNumber}`, sessionData);

    setWithTTL(lfgJoinedUsers, randomNumber, [user.id], CACHE_TTL);
    lfgStats.totalSessions++;
    lfgStats.totalPlayers += players;
    await saveData();

    if (!voiceChannel.members.size) resetTimeout(randomNumber, guild);
    updateRichPresence();
  } catch (error) {
    console.error('⚠️ Erreur création LFG:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ Erreur création session.', flags: [MessageFlags.Ephemeral] });
    } else {
      await interaction.followUp({ content: '❌ Erreur création session.', flags: [MessageFlags.Ephemeral] });
    }
  }
}

async function handleModifyLFGCommand(interaction) {
  const { options, member, guild } = interaction;
  const sessionId = options.getString('session_id');
  const players = options.getInteger('joueurs');
  const description = options.getString('description');

  if (!member.permissions.has(PermissionFlagsBits.ManageChannels)) {
    if (!interaction.replied && !interaction.deferred) {
      return interaction.reply({ content: '❌ Permission insuffisante.', ephemeral: true });
    }
    return;
  }

  const sessionData = lfgSessions.get(sessionId);
  if (!sessionData) {
    if (!interaction.replied && !interaction.deferred) {
      return interaction.reply({ content: `❌ Session ${sessionId} introuvable.`, ephemeral: true });
    }
    return;
  }

  const session = { ...sessionData.value };

  try {
    await interaction.deferReply({ ephemeral: true });

    if (players) {
      const voiceChannel = guild.channels.cache.get(session.voiceChannelId);
      if (voiceChannel) await voiceChannel.edit({ userLimit: players + 1 });
      lfgStats.totalPlayers = lfgStats.totalPlayers - session.players + players;
      session.players = players;
    }
    if (description) {
      session.description = description;
    }
    setWithTTL(lfgSessions, sessionId, session, CACHE_TTL);

    const joinedUsersData = lfgJoinedUsers.get(sessionId);
    const joinedUsers = joinedUsersData ? joinedUsersData.value : [];

    const hexColor = 0x1E90FF;
    const textTitle = new TextDisplayBuilder().setContent(`Session LFG ID-${sessionId}`);
    const textAuthor = new TextDisplayBuilder().setContent(`Session LFG modifiée`);
    const textFooter = new TextDisplayBuilder().setContent(`⚠️ Salon supprimé après 5 min si vide\n${guild.name} • /lfg • /stats • /history`);
    const thumbnail = new ThumbnailBuilder({
      media: { url: client.user.avatarURL({ dynamic: true }) || 'https://i.imgur.com/4AvpcjD.png' },
    });

    const sectionThumbnail = new SectionBuilder()
      .addTextDisplayComponents(textAuthor)
      .addTextDisplayComponents(textTitle)
      .setThumbnailAccessory(thumbnail);

    const joinButton = new ButtonBuilder()
      .setCustomId(`join_${sessionId}`)
      .setLabel('Rejoindre la Session')
      .setStyle(ButtonStyle.Primary);

    const vocalButton = new ButtonBuilder()
      .setCustomId(`vocal_${sessionId}`)
      .setLabel('Rejoindre le Vocal')
      .setStyle(ButtonStyle.Primary);

    const texteButton = new ButtonBuilder()
      .setCustomId(`texte_${sessionId}`)
      .setLabel('Salon Discution')
      .setStyle(ButtonStyle.Primary);

    const infoButton = new ButtonBuilder()
      .setCustomId(`info_${sessionId}`)
      .setLabel('Salon d\'information')
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(joinButton);
    const buttonRow = new ActionRowBuilder().addComponents(vocalButton, texteButton, infoButton);

    // Mise à jour du message dans le salon d'information
    const infoTextChannel = guild.channels.cache.get(session.infoTextChannelId);
    if (infoTextChannel && session.infoMessageId) {
      try {
        const infoMessage = await infoTextChannel.messages.fetch(session.infoMessageId);
        const container = new ContainerBuilder()
          .addSectionComponents(sectionThumbnail)
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`👑 **Organisateur :** <@${session.userId}>`))
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`🎮 **Jeu :** ${session.game}`))
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`💻 **Plate-forme :** ${session.platform}`))
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`🏆 **Activité :** ${session.activity}`))
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`👥 **Joueurs :** ${players || session.players}/${players || session.players}`))
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`🎯 **Gametag :** ${session.gametag}`))
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`📝 **Description :** ${description || session.description}`))
          .addSeparatorComponents(new SeparatorBuilder())
          .addActionRowComponents(buttonRow)
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`👥 **Participants :** ${joinedUsers.length ? joinedUsers.map(id => `<@${id}>`).join(', ') : 'Aucun'}`))
          .addTextDisplayComponents(textFooter)
          .setAccentColor(hexColor)
          .addActionRowComponents(row);

        await infoMessage.edit({
          flags: MessageFlags.IsComponentsV2,
          components: [container],
          allowedMentions: { parse: [] },
        });
      } catch (error) {
        console.warn(`⚠️ Impossible de mettre à jour le message du salon d'information ${session.infoMessageId}:`, error.message);
      }
    }

    // Mise à jour du message dans le canal de commande
    const commandChannel = guild.channels.cache.get(session.commandChannelId);
    if (commandChannel && session.commandChannelMessageId) {
      try {
        const commandMessage = await commandChannel.messages.fetch(session.commandChannelMessageId);
        const commandContainer = new ContainerBuilder()
          .addSectionComponents(sectionThumbnail)
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`👑 **Organisateur :** <@${session.userId}>`))
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`🎮 **Jeu :** ${session.game}`))
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`💻 **Plate-forme :** ${session.platform}`))
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`🏆 **Activité :** ${session.activity}`))
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`👥 **Joueurs :** ${players || session.players}/${players || session.players}`))
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`🎯 **Gametag :** ${session.gametag}`))
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`📝 **Description :** ${description || session.description}`))
          .addSeparatorComponents(new SeparatorBuilder())
          .addActionRowComponents(buttonRow)
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(textFooter)
          .setAccentColor(hexColor);

        await commandMessage.edit({
          flags: MessageFlags.IsComponentsV2,
          components: [commandContainer],
        });
      } catch (error) {
        console.warn(`⚠️ Impossible de mettre à jour le message du canal de commande ${session.commandChannelMessageId}:`, error.message);
      }
    }

    await saveData();

    await interaction.followUp({ content: `✅ Session ${sessionId} modifiée.`, ephemeral: true });
    updateRichPresence();
  } catch (error) {
    console.error('⚠️ Erreur modification LFG:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ Erreur modification session.', ephemeral: true });
    } else {
      await interaction.followUp({ content: '❌ Erreur modification session.', ephemeral: true });
    }
  }
}

async function handleListMembersCommand(interaction) {
  const { options, guild } = interaction;
  const sessionId = options.getString('session_id');
  const page = options.getInteger('page') || 1;

  const sessionData = lfgSessions.get(sessionId);
  if (!sessionData) {
    if (!interaction.replied && !interaction.deferred) {
      return interaction.reply({ content: `❌ Session ${sessionId} introuvable.`, ephemeral: true });
    }
    return;
  }

  const session = sessionData.value;

  try {
    await interaction.deferReply({ ephemeral: true });

    const voiceChannel = guild.channels.cache.get(session.voiceChannelId);
    const members = voiceChannel?.members.map((member) => member.user.tag) || [];

    const totalPages = Math.ceil(members.length / ITEMS_PER_PAGE);
    const start = (page - 1) * ITEMS_PER_PAGE;
    const end = start + ITEMS_PER_PAGE;
    const paginatedMembers = members.slice(start, end).join('\n') || 'Aucun membre';

    const hexColor = 0x1E90FF;
    const textTitle = new TextDisplayBuilder().setContent(`Membres de la session ID-${sessionId}`);
    const textAuthor = new TextDisplayBuilder().setContent(`Liste des membres`);
    const textFooter = new TextDisplayBuilder().setContent(`${guild.name} • /lfg • /stats • /history`);

    const sectionThumbnail = new SectionBuilder()
      .addTextDisplayComponents(textAuthor)
      .addTextDisplayComponents(textTitle)
      .setThumbnailAccessory(new ThumbnailBuilder({
        media: { url: client.user.avatarURL({ dynamic: true }) || 'https://i.imgur.com/4AvpcjD.png' },
      }));

    const container = new ContainerBuilder()
      .addSectionComponents(sectionThumbnail)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`👥 **Liste des membres :** ${paginatedMembers}`))
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`📊 **Total :** ${members.length} membre(s)`))
      .addTextDisplayComponents(textFooter)
      .setAccentColor(hexColor);

    await interaction.followUp({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
      ephemeral: true,
    });
  } catch (error) {
    console.error('⚠️ Erreur liste membres:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ Erreur affichage membres.', ephemeral: true });
    } else {
      await interaction.followUp({ content: '❌ Erreur affichage membres.', ephemeral: true });
    }
  }
}

async function handleKickMemberCommand(interaction) {
  const { options, member, guild, user } = interaction;
  const sessionId = options.getString('session_id');
  const targetMember = options.getMember('member');

  const sessionData = lfgSessions.get(sessionId);
  if (!sessionData) {
    if (!interaction.replied && !interaction.deferred) {
      return interaction.reply({ content: `❌ Session ${sessionId} introuvable.`, flags: [MessageFlags.Ephemeral] });
    }
    return;
  }

  const session = sessionData.value;

  if (user.id !== session.userId) {
    if (!interaction.replied && !interaction.deferred) {
      return interaction.reply({ content: '❌ Seuls les organisateurs peuvent retirer des membres.', flags: [MessageFlags.Ephemeral] });
    }
    return;
  }

  try {
    const voiceChannel = guild.channels.cache.get(session.voiceChannelId);
    if (voiceChannel && targetMember.voice.channelId === voiceChannel.id) {
      await targetMember.voice.disconnect();
      const deleteUser = db.prepare('DELETE FROM lfgJoinedUsers WHERE sessionId = ? AND userId = ?');
      deleteUser.run(sessionId, targetMember.id);
      const joinedUsersData = lfgJoinedUsers.get(sessionId);
      if (joinedUsersData) {
        const joinedUsers = joinedUsersData.value.filter(id => id !== targetMember.id);
        setWithTTL(lfgJoinedUsers, sessionId, joinedUsers, CACHE_TTL);
      }
      await saveData();
      await interaction.reply({ content: `✅ ${targetMember.user.tag} retiré de ${sessionId}.`, flags: [MessageFlags.Ephemeral] });
      updateRichPresence();
    } else {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: `❌ ${targetMember.user.tag} n’est pas dans le salon vocal.`, flags: [MessageFlags.Ephemeral] });
      }
    }
  } catch (error) {
    console.error('⚠️ Erreur kick membre:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ Erreur retrait membre.', flags: [MessageFlags.Ephemeral] });
    } else {
      await interaction.followUp({ content: '❌ Erreur retrait membre.', flags: [MessageFlags.Ephemeral] });
    }
  }
}

async function handleBanMemberCommand(interaction) {
  const { options, member, guild, user } = interaction;
  const sessionId = options.getString('session_id');
  const targetMember = options.getMember('member');

  const sessionData = lfgSessions.get(sessionId);
  if (!sessionData) {
    if (!interaction.replied && !interaction.deferred) {
      return interaction.reply({ content: `❌ Session ${sessionId} introuvable.`, flags: [MessageFlags.Ephemeral] });
    }
    return;
  }

  const session = sessionData.value;

  if (user.id !== session.userId) {
    if (!interaction.replied && !interaction.deferred) {
      return interaction.reply({ content: '❌ Seuls les organisateurs peuvent bannir des membres.', flags: [MessageFlags.Ephemeral] });
    }
    return;
  }

  try {
    const voiceChannel = guild.channels.cache.get(session.voiceChannelId);
    if (voiceChannel && targetMember.voice.channelId === voiceChannel.id) {
      await targetMember.voice.disconnect();
      await guild.members.ban(targetMember, { reason: `Banni de la session LFG ${sessionId}` });
      const deleteUser = db.prepare('DELETE FROM lfgJoinedUsers WHERE sessionId = ? AND userId = ?');
      deleteUser.run(sessionId, targetMember.id);
      const joinedUsersData = lfgJoinedUsers.get(sessionId);
      if (joinedUsersData) {
        const joinedUsers = joinedUsersData.value.filter(id => id !== targetMember.id);
        setWithTTL(lfgJoinedUsers, sessionId, joinedUsers, CACHE_TTL);
      }
      await saveData();
      await interaction.reply({ content: `✅ ${targetMember.user.tag} banni de ${sessionId}.`, flags: [MessageFlags.Ephemeral] });
      updateRichPresence();
    } else {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: `❌ ${targetMember.user.tag} n’est pas dans le salon vocal.`, flags: [MessageFlags.Ephemeral] });
      }
    }
  } catch (error) {
    console.error('⚠️ Erreur ban membre:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ Erreur bannissement membre.', flags: [MessageFlags.Ephemeral] });
    } else {
      await interaction.followUp({ content: '❌ Erreur bannissement membre.', flags: [MessageFlags.Ephemeral] });
    }
  }
}

async function handleStatsCommand(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });

    const hexColor = 0x1E90FF;
    const textTitle = new TextDisplayBuilder().setContent(`Statistiques des sessions LFG`);
    const textAuthor = new TextDisplayBuilder().setContent(`Résumé des sessions`);
    const textFooter = new TextDisplayBuilder().setContent(`${interaction.guild.name} • /lfg • /stats • /history`);

    const sectionThumbnail = new SectionBuilder()
      .addTextDisplayComponents(textAuthor)
      .addTextDisplayComponents(textTitle)
      .setThumbnailAccessory(new ThumbnailBuilder({
        media: { url: interaction.guild.iconURL({ dynamic: true }) || 'https://i.imgur.com/4AvpcjD.png' },
      }));

    const container = new ContainerBuilder()
      .addSectionComponents(sectionThumbnail)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`📊 **Sessions créées :** ${lfgStats.totalSessions}`))
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`👥 **Joueurs totaux :** ${lfgStats.totalPlayers}`))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`🎮 **Sessions actives :** ${lfgSessions.size}`))
      .addTextDisplayComponents(textFooter)
      .setAccentColor(hexColor);

    await interaction.followUp({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
      ephemeral: true,
    });
  } catch (error) {
    console.error('⚠️ Erreur stats:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ Erreur affichage stats.', ephemeral: true });
    } else {
      await interaction.followUp({ content: '❌ Erreur affichage stats.', ephemeral: true });
    }
  }
}

async function handleHistoryCommand(interaction) {
  const { options, guild } = interaction;
  const page = options.getInteger('page') || 1;

  try {
    await interaction.deferReply({ ephemeral: true });

    const sessions = Array.from(lfgSessions.values()).map(data => data.value);
    const totalPages = Math.ceil(sessions.length / ITEMS_PER_PAGE);
    const start = (page - 1) * ITEMS_PER_PAGE;
    const end = start + ITEMS_PER_PAGE;
    const paginatedSessions = sessions.slice(start, end);

    const hexColor = 0x1E90FF;
    const textTitle = new TextDisplayBuilder().setContent(`Historique des sessions LFG`);
    const textAuthor = new TextDisplayBuilder().setContent(`Sessions récentes`);
    const textFooter = new TextDisplayBuilder().setContent(`${guild.name} • /lfg • /stats • /history`);

    const sectionThumbnail = new SectionBuilder()
      .addTextDisplayComponents(textAuthor)
      .addTextDisplayComponents(textTitle)
      .setThumbnailAccessory(new ThumbnailBuilder({
        media: { url: client.user.avatarURL({ dynamic: true }) || 'https://i.imgur.com/4AvpcjD.png' },
      }));

    const container = new ContainerBuilder()
      .addSectionComponents(sectionThumbnail)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        paginatedSessions.length
          ? paginatedSessions
              .map((session) => `🎮 **${session.game}** - ${session.user} - <t:${Math.floor(new Date(session.date).getTime() / 1000)}:R>`)
              .join('\n')
          : 'Aucune session.'
      ))
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`📊 **Total :** ${sessions.length} session(s)`))
      .addTextDisplayComponents(textFooter)
      .setAccentColor(hexColor);

    await interaction.followUp({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
      ephemeral: true,
    });
  } catch (error) {
    console.error('⚠️ Erreur historique:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ Erreur affichage historique.', ephemeral: true });
    } else {
      await interaction.followUp({ content: '❌ Erreur affichage historique.', ephemeral: true });
    }
  }
}

async function handleSetLFGChannelCommand(interaction) {
  const { options, guild, member } = interaction;
  const channel = options.getChannel('channel');

  if (!member.permissions.has(PermissionFlagsBits.ManageChannels)) {
    if (!interaction.replied && !interaction.deferred) {
      return interaction.reply({ content: '❌ Permission insuffisante.', ephemeral: true });
    }
    return;
  }

  try {
    await interaction.deferReply({ ephemeral: true });
    setWithTTL(webhookChannels, guild.id, channel.id, WEBHOOK_TTL);
    await saveData();
    await interaction.followUp({ content: `✅ Salon ${channel} défini pour les annonces LFG.`, ephemeral: true });
  } catch (error) {
    console.error('⚠️ Erreur définition salon LFG:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ Erreur définition salon.', ephemeral: true });
    } else {
      await interaction.followUp({ content: '❌ Erreur définition salon.', ephemeral: true });
    }
  }
}

// Gestion des boutons
async function handleJoinButton(interaction) {
  const customId = interaction.customId;
  const sessionId = customId.split('_')[1];
  console.log(`Tentative de rejoindre - customId: ${customId}, sessionId: ${sessionId}, lfgSessions:`, Array.from(lfgSessions.entries()));

  const sessionData = lfgSessions.get(sessionId);
  if (!sessionData) {
    if (!interaction.replied && !interaction.deferred) {
      console.error(`Session ${sessionId} non trouvée dans lfgSessions`);
      return interaction.reply({ content: `❌ Session ${sessionId} introuvable. Vérifiez avec l'organisateur ou recréez la session.`, flags: [MessageFlags.Ephemeral] });
    }
    return;
  }

  const session = sessionData.value;

  const joinedUsersData = lfgJoinedUsers.get(sessionId);
  const joinedUsers = joinedUsersData ? joinedUsersData.value : [];

  if (joinedUsers.length >= session.players) {
    if (!interaction.replied && !interaction.deferred) {
      return interaction.reply({ content: '❌ Session pleine.', flags: [MessageFlags.Ephemeral] });
    }
    return;
  }

  if (joinedUsers.includes(interaction.user.id)) {
    if (!interaction.replied && !interaction.deferred) {
      return interaction.reply({ content: '❌ Déjà rejoint.', flags: [MessageFlags.Ephemeral] });
    }
    return;
  }

  try {
    const voiceChannel = interaction.guild.channels.cache.get(session.voiceChannelId);
    if (voiceChannel) {
      joinedUsers.push(interaction.user.id);
      setWithTTL(lfgJoinedUsers, sessionId, joinedUsers, CACHE_TTL);
      const insertUser = db.prepare('INSERT OR REPLACE INTO lfgJoinedUsers (sessionId, userId) VALUES (?, ?)');
      insertUser.run(sessionId, interaction.user.id);
      await saveData();

      const infoTextChannel = interaction.guild.channels.cache.get(session.infoTextChannelId);
      if (infoTextChannel && session.infoMessageId) {
        try {
          const infoMessage = await infoTextChannel.messages.fetch(session.infoMessageId);
          const hexColor = 0x1E90FF;
          const textTitle = new TextDisplayBuilder().setContent(`Session LFG ID-${sessionId}`);
          const textAuthor = new TextDisplayBuilder().setContent(`Nouvelle session LFG`);
          const textFooter = new TextDisplayBuilder().setContent(`⚠️ Salon supprimé après 5 min si vide\n${interaction.guild.name} • /lfg • /stats • /history`);

          const sectionThumbnail = new SectionBuilder()
            .addTextDisplayComponents(textAuthor)
            .addTextDisplayComponents(textTitle)
            .setThumbnailAccessory(new ThumbnailBuilder({
              media: { url: client.user.avatarURL({ dynamic: true }) || 'https://i.imgur.com/4AvpcjD.png' },
            }));

          const joinButton = new ButtonBuilder()
            .setCustomId(`join_${sessionId}`)
            .setLabel('Rejoindre la Session')
            .setStyle(ButtonStyle.Primary);

          const vocalButton = new ButtonBuilder()
            .setCustomId(`vocal_${sessionId}`)
            .setLabel('Rejoindre le Vocal')
            .setStyle(ButtonStyle.Primary);

          const texteButton = new ButtonBuilder()
            .setCustomId(`texte_${sessionId}`)
            .setLabel('Salon Discution')
            .setStyle(ButtonStyle.Primary);

          const infoButton = new ButtonBuilder()
            .setCustomId(`info_${sessionId}`)
            .setLabel('Salon d\'information')
            .setStyle(ButtonStyle.Primary);

          const row = new ActionRowBuilder().addComponents(joinButton);
          const buttonRow = new ActionRowBuilder().addComponents(vocalButton, texteButton, infoButton);

          const container = new ContainerBuilder()
            .addSectionComponents(sectionThumbnail)
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(`👑 **Organisateur :** <@${session.userId}>`))
            .addSeparatorComponents(new SeparatorBuilder())
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(`🎮 **Jeu :** ${session.game}`))
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(`💻 **Plate-forme :** ${session.platform}`))
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(`🏆 **Activité :** ${session.activity}`))
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(`👥 **Joueurs :** ${session.players}/${session.players}`))
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(`🎯 **Gametag :** ${session.gametag}`))
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(`📝 **Description :** ${session.description}`))
            .addSeparatorComponents(new SeparatorBuilder())
            .addActionRowComponents(buttonRow)
            .addSeparatorComponents(new SeparatorBuilder())
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(`👥 **Participants :** ${joinedUsers.map(id => `<@${id}>`).join(', ')}`))
            .addTextDisplayComponents(textFooter)
            .setAccentColor(hexColor)
            .addActionRowComponents(row);

          await infoMessage.edit({
            flags: MessageFlags.IsComponentsV2,
            components: [container],
            allowedMentions: { parse: [] },
          });
        } catch (error) {
          console.warn(`⚠️ Impossible de mettre à jour le message info:`, error.message);
        }
      }

      await interaction.reply({ content: `✅ Session rejointe ! Cliquez pour rejoindre le salon vocal : ${voiceChannel}`, flags: [MessageFlags.Ephemeral] });
      updateRichPresence();
    } else {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ Salon vocal introuvable.', flags: [MessageFlags.Ephemeral] });
      }
    }
  } catch (error) {
    console.error('⚠️ Erreur rejoindre LFG:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ Erreur rejoindre session.', flags: [MessageFlags.Ephemeral] });
    } else {
      await interaction.followUp({ content: '❌ Erreur rejoindre session.', flags: [MessageFlags.Ephemeral] });
    }
  }
}

// Événements
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isCommand() && !interaction.isButton()) return;
  if (!checkRateLimit(interaction.user.id)) {
    if (!interaction.replied && !interaction.deferred) {
      return interaction.reply({ content: '❌ Limite de débit atteinte.', flags: [MessageFlags.Ephemeral] });
    }
    return;
  }

  if (interaction.isCommand()) {
    switch (interaction.commandName) {
      case 'lfg': return handleLFGCommand(interaction);
      case 'modify_lfg': return handleModifyLFGCommand(interaction);
      case 'list_members': return handleListMembersCommand(interaction);
      case 'kick_member': return handleKickMemberCommand(interaction);
      case 'ban_member': return handleBanMemberCommand(interaction);
      case 'stats': return handleStatsCommand(interaction);
      case 'history': return handleHistoryCommand(interaction);
      case 'set_lfg_channel': return handleSetLFGChannelCommand(interaction);
      default:
        if (!interaction.replied && !interaction.deferred) {
          return interaction.followUp({ content: '❌ Commande inconnue.', flags: [MessageFlags.Ephemeral] });
        }
        return;
    }
  } else if (interaction.isButton()) {
    const [type, sessionId] = interaction.customId.split('_');
    console.log(`Bouton cliqué - type: ${type}, sessionId: ${sessionId}, lfgSessions:`, Array.from(lfgSessions.entries()));

    const sessionData = lfgSessions.get(sessionId);
    if (!sessionData) {
      console.error(`Session ${sessionId} non trouvée dans lfgSessions`);
      if (!interaction.replied && !interaction.deferred) {
        return interaction.reply({ content: `❌ Session ${sessionId} introuvable. Vérifiez avec l'organisateur ou recréez la session.`, flags: [MessageFlags.Ephemeral] });
      }
      return;
    }

    const session = sessionData.value;

    if (type === 'join') {
      return handleJoinButton(interaction);
    } else if (type === 'vocal') {
      const voiceChannel = client.guilds.cache.get(session.guildId)?.channels.cache.get(session.voiceChannelId);
      if (voiceChannel) {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: `**[${voiceChannel.name}](https://discord.com/channels/${session.guildId}/${voiceChannel.id})**`,
            flags: [MessageFlags.Ephemeral],
          });
        }
      } else {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '❌ Salon vocal introuvable.', flags: [MessageFlags.Ephemeral] });
        }
      }
    } else if (type === 'texte') {
      const textChannel = client.guilds.cache.get(session.guildId)?.channels.cache.get(session.textChannelId);
      if (textChannel) {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: `**[${textChannel.name}](https://discord.com/channels/${session.guildId}/${textChannel.id})**`,
            flags: [MessageFlags.Ephemeral],
          });
        }
      } else {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '❌ Salon Discution introuvable.', flags: [MessageFlags.Ephemeral] });
        }
      }
    } else if (type === 'info') {
      const infoTextChannel = client.guilds.cache.get(session.guildId)?.channels.cache.get(session.infoTextChannelId);
      if (infoTextChannel) {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: `**[${infoTextChannel.name}](https://discord.com/channels/${session.guildId}/${infoTextChannel.id})**`,
            flags: [MessageFlags.Ephemeral],
          });
        }
      } else {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '❌ Salon d\'information introuvable.', flags: [MessageFlags.Ephemeral] });
        }
      }
    }
  }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const sessionData = Array.from(lfgSessions.entries()).find(
    ([id, data]) => data.value.voiceChannelId === oldState.channelId || data.value.voiceChannelId === newState.channelId
  );

  if (sessionData) {
    const sessionId = sessionData[0];
    const session = sessionData[1].value;
    const voiceChannel = newState.guild.channels.cache.get(session.voiceChannelId);
    if (voiceChannel) resetTimeout(sessionId, newState.guild);
  }
});

client.once(Events.ClientReady, async () => {
  console.log(`✅ Connecté: ${client.user.tag}`);
  await loadData();
  console.log('Sessions après chargement:', Array.from(lfgSessions.entries()));
  for (const [sessionId, data] of lfgSessions) {
    const session = data.value;
    const guild = client.guilds.cache.get(session.guildId);
    if (guild) {
      const voiceChannel = guild.channels.cache.get(session.voiceChannelId);
      if (voiceChannel && !voiceChannel.members.size) resetTimeout(sessionId, guild);
    }
  }
  await registerCommands();
  updateRichPresence();
});

// Handler SIGINT/SIGTERM/uncaughtException/unhandledRejection
process.on('SIGINT', async () => { await saveData(); db.close(); process.exit(0); });
process.on('SIGTERM', async () => { await saveData(); db.close(); process.exit(0); });
process.on('uncaughtException', async (err) => { console.error(err); await saveData(); db.close(); client.destroy(); process.exit(1); });
process.on('unhandledRejection', async (err) => { console.error(err); await saveData(); db.close(); client.destroy(); process.exit(1); });

// Connexion du bot
client.login(process.env.DISCORD_TOKEN)
  .then(() => console.log("✅ Le bot s'est connecté avec succès à Discord et est prêt à fonctionner."))
  .catch((error) => {
    console.error("⚠️ Une erreur s'est produite lors de la tentative de connexion du bot à Discord.");
    process.exit(1);
  });
