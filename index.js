require('dotenv').config();

const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
} = require('discord.js');
const { createWorker } = require('tesseract.js');

const PROOF_CHANNEL_ID = process.env.SUB_PROOF_CHANNEL_ID || '1551744713688621126';
const FREE_ACCESS_ROLE_ID = process.env.FREE_ACCESS_ROLE_ID || '1551747469455654963';
const FREE_PRODUCTS_CHANNEL_ID = process.env.FREE_PRODUCTS_CHANNEL_ID || '1551745615761768569';
const SUPPORT_CHANNEL_ID = process.env.SUPPORT_CHANNEL_ID || '1551744887739654245';
const RULES_CHANNEL_ID = process.env.RULES_CHANNEL_ID || '1551745881819054090';
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID || '1552112181343031326';
const TICKET_STATE_PATH = process.env.TICKET_STATE_PATH || path.join(process.cwd(), 'data', 'ticket-state.json');
const OCR_LANGUAGES = (process.env.OCR_LANGUAGES || 'eng,hin')
  .split(/[,+\s]+/)
  .map((language) => language.trim())
  .filter(Boolean);
const OCR_CACHE_PATH = process.env.OCR_CACHE_PATH || path.join(process.cwd(), 'data', 'ocr-cache');
const REVIEW_COOLDOWN_MS = 30_000;
const MAX_PROOF_BYTES = 10 * 1024 * 1024;
const HASH_STORE_PATH = process.env.PROOF_HASH_STORE_PATH || path.join(process.cwd(), 'data', 'proof-hashes.json');
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff']);
const SUBSCRIBED_LABELS = [
  /\bsubscribed\b/i,
  /\bsuscrit[oa]s?\b/i,
  /\babonn[ée]s?\b/i,
  /\binscrit[oa]s?\b/i,
  /\babonniert\b/i,
  /\biscritt[oa]\b/i,
  /\bberlangganan\b/i,
  /\bgeabonneerd\b/i,
  /\bprenumeruje\b/i,
  /\bđã\s*đăng\s*ký\b/i,
  /\babone\s*olundu\b/i,
  /\bподписан[аоы]?\b/i,
  /已订阅|已訂閱|登録済み|구독중|구독함|सदस्यता\s*ली\s*गई|تم\s*الاشتراك/,
];

const cooldowns = new Map();
const pendingProofHashes = new Set();
let proofHashes = new Set();
let ocrWorkerPromise;
let ocrQueue = Promise.resolve();
let ticketNumberQueue = Promise.resolve();

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || process.env.BOT_TOKEN;
if (!DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is missing. Add it as a private server variable.');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent],
  allowedMentions: { parse: [] },
});

function channelEmbed(title, description, footer, fields = []) {
  return new EmbedBuilder()
    .setColor(0x0b0b0d)
    .setAuthor({ name: 'NIGHTCROW STUDIOS' })
    .setTitle(title)
    .setDescription(description)
    .addFields(fields)
    .setFooter({ text: footer });
}

function supportPanel() {
  return {
    embeds: [channelEmbed(
      'Support',
      'Choose a topic below to open a private ticket. Only you and the server owner can see it.',
      'Nightcrow Studios • Support',
      [
        { name: 'Product Support', value: 'Help with a purchase, product, or bug.', inline: true },
        { name: 'General Support', value: 'Questions about the store or server.', inline: true },
      ],
    )],
    components: [new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('nightcrow:support-topic')
        .setPlaceholder('Select a support topic')
        .addOptions(
          { label: 'Product Support', description: 'A purchase, product, or bug', value: 'product', emoji: '🛒' },
          { label: 'General Support', description: 'A question about the store or server', value: 'general', emoji: '📝' },
        ),
    )],
  };
}

const managedMessages = [
  {
    channelId: RULES_CHANNEL_ID,
    marker: 'Nightcrow Studios • Rules v1',
    payload: { embeds: [channelEmbed(
      'Server rules',
      'Keep Nightcrow Studios welcoming, safe, and useful for everyone.',
      'Nightcrow Studios • Rules v1',
      [
        { name: 'Community', value: 'Be respectful. No harassment, hate speech, threats, NSFW content, spam, flooding, or unsolicited advertising.' },
        { name: 'Safety', value: 'Keep posts in the right channels. Do not promote illegal activity, cheating, exploits, or harmful files. Follow Discord’s Terms and Community Guidelines.' },
        { name: 'Privacy', value: 'Never post passwords, bot tokens, payment details, addresses, or anyone else’s private information.' },
        { name: 'Product use', value: 'Follow the license included with each product. Do not leak, reupload, resell, or redistribute product files unless that license explicitly allows it. Keep included Nightcrow Studios credits and do not claim our work as your own.' },
        { name: 'Need help?', value: 'Open a support ticket for purchase or product questions. Never send staff your password or payment credentials.' },
      ],
    )] },
  },
];

async function upsertManagedMessage(channelId, marker, payload) {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased() || !channel.messages) {
    throw new Error('Managed message channel is unavailable: ' + channelId);
  }

  const messages = await channel.messages.fetch({ limit: 100 });
  const current = messages.find((message) =>
    message.author.id === client.user.id && message.embeds.some((embed) => embed.footer?.text === marker),
  );

  if (current) {
    await current.edit(payload);
  } else {
    await channel.send(payload);
  }
}

async function ensureServerMessages() {
  for (const item of managedMessages) {
    try {
      await upsertManagedMessage(item.channelId, item.marker, item.payload);
    } catch (error) {
      console.error('Could not update channel message in ' + item.channelId + ':', error);
    }
  }

  try {
    await upsertManagedMessage(SUPPORT_CHANNEL_ID, 'Nightcrow Studios • Support', supportPanel());
  } catch (error) {
    console.error('Could not update the support panel:', error);
  }
}

async function nextTicketNumber(guild) {
  const task = ticketNumberQueue.then(async () => {
    let savedNumber = 0;
    try {
      const state = JSON.parse(await fs.readFile(TICKET_STATE_PATH, 'utf8'));
      savedNumber = Number.isInteger(state?.lastNumber) ? state.lastNumber : 0;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const highestOpenNumber = guild.channels.cache.reduce((highest, channel) => {
      const match = channel.name.match(/^ticket-(\d+)$/);
      return match ? Math.max(highest, Number(match[1])) : highest;
    }, 0);
    const number = Math.max(savedNumber, highestOpenNumber) + 1;
    await fs.mkdir(path.dirname(TICKET_STATE_PATH), { recursive: true });
    const temporaryPath = TICKET_STATE_PATH + '.tmp';
    await fs.writeFile(temporaryPath, JSON.stringify({ lastNumber: number }), 'utf8');
    await fs.rename(temporaryPath, TICKET_STATE_PATH);
    return number;
  });

  ticketNumberQueue = task.then(() => undefined, () => undefined);
  return task;
}

function ticketPermissions(guild, openerId, ownerId) {
  const viewPermissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
  const overwrites = new Map();
  overwrites.set(guild.id, {
    id: guild.id,
    deny: [...viewPermissions, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles],
  });

  for (const role of guild.roles.cache.values()) {
    if (role.id !== guild.id) overwrites.set(role.id, { id: role.id, deny: [PermissionFlagsBits.ViewChannel] });
  }

  const memberPermissions = [
    ...viewPermissions,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.EmbedLinks,
  ];
  for (const userId of new Set([openerId, ownerId, client.user.id])) {
    overwrites.set(userId, { id: userId, allow: memberPermissions });
  }

  return [...overwrites.values()];
}

async function openTicket(interaction, topic) {
  await interaction.deferReply({ ephemeral: true });
  const { guild, user } = interaction;
  if (!guild) {
    await interaction.editReply('Tickets can only be opened inside the Nightcrow Studios server.');
    return;
  }

  const category = guild.channels.cache.get(TICKET_CATEGORY_ID) || await guild.channels.fetch(TICKET_CATEGORY_ID).catch(() => null);
  if (!category || category.type !== ChannelType.GuildCategory || category.guildId !== guild.id) {
    await interaction.editReply('The configured ticket category could not be found. Please contact staff.');
    return;
  }

  const botMember = guild.members.me || await guild.members.fetch(client.user.id);
  if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
    await interaction.editReply('Ticket channels are not enabled yet. Crow needs the Manage Channels permission to create private tickets.');
    return;
  }

  const existing = guild.channels.cache.find((channel) =>
    channel.parentId === category.id && channel.name.startsWith('ticket-') &&
    channel.topic?.includes('member=' + user.id) && !channel.topic.includes('state=closed'),
  );
  if (existing) {
    await interaction.editReply('You already have an open ticket: <#' + existing.id + '>');
    return;
  }

  const ownerId = guild.ownerId;
  const number = await nextTicketNumber(guild);
  const typeName = topic === 'product' ? 'Product Support' : 'General Support';
  const channel = await guild.channels.create({
    name: 'ticket-' + number,
    type: ChannelType.GuildText,
    parent: category.id,
    topic: 'Nightcrow ticket | member=' + user.id + ' | kind=' + topic + ' | number=' + number + ' | state=open',
    permissionOverwrites: ticketPermissions(guild, user.id, ownerId),
  });

  await channel.send({
    content: '@here <@' + ownerId + '> <@' + user.id + '>',
    embeds: [channelEmbed(typeName, 'Describe what you need help with and attach any relevant images. Staff will reply here.', 'Nightcrow Studios • Ticket #' + number)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('nightcrow:ticket-close').setLabel('Close ticket').setStyle(ButtonStyle.Secondary),
    )],
    allowedMentions: { parse: ['everyone'], users: [ownerId, user.id] },
  });

  await interaction.editReply('Your private ticket is open: <#' + channel.id + '>');
}

async function closeTicket(interaction) {
  const channel = interaction.channel;
  const guild = interaction.guild;
  const match = channel?.topic?.match(/member=(\d+).*?number=(\d+).*?state=(open|closed)/);
  if (!guild || !channel || channel.parentId !== TICKET_CATEGORY_ID || !match) {
    await interaction.reply({ content: 'This ticket could not be identified.', ephemeral: true });
    return;
  }

  const [, openerId, number, state] = match;
  if (state === 'closed') {
    await interaction.reply({ content: 'This ticket is already closed.', ephemeral: true });
    return;
  }
  if (interaction.user.id !== guild.ownerId && interaction.user.id !== openerId) {
    await interaction.reply({ content: 'Only the ticket owner or Nightcrow Studios owner can close this ticket.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  await channel.permissionOverwrites.edit(openerId, {
    SendMessages: false,
    AttachFiles: false,
  });
  await channel.setTopic(channel.topic.replace('state=open', 'state=closed'));
  const closedButton = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('nightcrow:ticket-close').setLabel('Ticket closed').setStyle(ButtonStyle.Secondary).setDisabled(true),
  );
  await interaction.message.edit({ components: [closedButton] });
  await channel.send({ embeds: [channelEmbed('Ticket closed', 'This conversation is closed. Its messages remain available in this private channel.', 'Nightcrow Studios • Ticket #' + number)] });
  await interaction.editReply('Ticket closed.');
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isStringSelectMenu() && interaction.customId === 'nightcrow:support-topic') {
      await openTicket(interaction, interaction.values[0]);
      return;
    }
    if (interaction.isButton() && interaction.customId === 'nightcrow:ticket-close') {
      await closeTicket(interaction);
    }
  } catch (error) {
    console.error('Ticket interaction failed:', error);
    const response = { content: 'Something went wrong while handling this ticket. Please try again or contact staff.', ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(response).catch(() => null);
    else await interaction.reply(response).catch(() => null);
  }
});

async function reply(message, content) {
  await message.reply({
    content,
    allowedMentions: { parse: [] },
    failIfNotExists: false,
  }).catch((error) => console.error('Could not send proof response:', error));
}

function isImageAttachment(attachment) {
  const contentType = (attachment.contentType || '').toLowerCase();
  const extension = path.extname(attachment.name || '').toLowerCase();
  return contentType.startsWith('image/') || IMAGE_EXTENSIONS.has(extension);
}

async function downloadProof(attachment) {
  if (attachment.size > MAX_PROOF_BYTES) throw new Error('Proof image exceeds the 10 MB limit.');

  const response = await fetch(attachment.url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error('Image download failed with status ' + response.status + '.');

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_PROOF_BYTES) throw new Error('Proof image is empty or exceeds the 10 MB limit.');

  return {
    bytes,
    hash: createHash('sha256').update(bytes).digest('hex'),
  };
}

async function rememberHash(hash) {
  const updated = new Set(proofHashes);
  updated.add(hash);
  await fs.mkdir(path.dirname(HASH_STORE_PATH), { recursive: true });
  const temporaryPath = HASH_STORE_PATH + '.tmp';
  await fs.writeFile(temporaryPath, JSON.stringify([...updated]), 'utf8');
  await fs.rename(temporaryPath, HASH_STORE_PATH);
  proofHashes = updated;
}

async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      await fs.mkdir(OCR_CACHE_PATH, { recursive: true });
      return createWorker(OCR_LANGUAGES, undefined, { cachePath: OCR_CACHE_PATH });
    })().catch((error) => {
      ocrWorkerPromise = undefined;
      throw error;
    });
  }
  return ocrWorkerPromise;
}

function recognizeImage(bytes) {
  const task = ocrQueue.then(async () => {
    const worker = await getOcrWorker();
    const result = await worker.recognize(bytes);
    return result.data.text || '';
  });
  ocrQueue = task.then(() => undefined, () => undefined);
  return task;
}

function hasNightcrowName(text) {
  const normalized = text.normalize('NFKC').toLowerCase();
  const compact = normalized.replace(/[\s._-]+/g, '');
  return compact.includes('nightcrowstudios') ||
    compact.includes('rblxnightcrowstudios') ||
    /night[\W_]*crow[\W_]*studios?/i.test(normalized);
}

function hasSubscribedLabel(text) {
  const normalized = text.normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '');
  const latinMatch = /\b(subscribed|suscrit[oa]s?|abonne[e]?s?|inscrit[oa]s?|abonniert|iscritt[oa]|berlangganan|geabonneerd|prenumeruje|da\s*dang\s*ky|abone\s*olundu)\b/i.test(normalized);
  const hindiMatch = /\u0938\u0926\u0938\u094d\u092f\u0924\u093e\s*\u0932\u0940/i.test(text);
  const chineseMatch = /\u5df2\u8ba2\u9605/.test(text);
  const japaneseMatch = /\u767b\u9332\u6e08\u307f/.test(text);
  const koreanMatch = /\uad6c\ub3c5\s*\uc911/.test(text);
  return latinMatch || hindiMatch || chineseMatch || japaneseMatch || koreanMatch;
}

async function reviewProof(bytes) {
  const text = await recognizeImage(bytes);
  if (!hasNightcrowName(text)) {
    return { accepted: false, reason: 'Nightcrow Studios was not readable.' };
  }
  if (!hasSubscribedLabel(text)) {
    return { accepted: false, reason: 'A subscribed status was not readable.' };
  }
  return { accepted: true };
}

client.once(Events.ClientReady, (ready) => {
  console.log('Nightcrow Bot is online as ' + ready.user.tag + '.');
  console.log('Local OCR languages: ' + OCR_LANGUAGES.join(', ') + '.');
  ensureServerMessages();
  getOcrWorker()
    .then(() => console.log('Local OCR worker ready.'))
    .catch((error) => console.error('Local OCR worker failed to initialize:', error));
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || message.channelId !== PROOF_CHANNEL_ID || !message.guild) return;
  if (message.attachments.size === 0) return;

  if (message.attachments.size !== 1) {
    await reply(message, 'Please send one screenshot image at a time. Nothing was deleted.');
    return;
  }

  const attachment = message.attachments.first();
  if (!isImageAttachment(attachment)) {
    await reply(message, 'Please upload a screenshot image. Nothing was deleted.');
    return;
  }

  let proof;
  try {
    proof = await downloadProof(attachment);
  } catch (error) {
    console.error('Proof image read failed:', error);
    await reply(message, 'I could not read that image. Please try a PNG, JPG, or WEBP under 10 MB.');
    return;
  }

  if (proofHashes.has(proof.hash)) {
    await reply(message, 'That exact screenshot was already submitted. Your image is still here.');
    return;
  }
  if (pendingProofHashes.has(proof.hash)) {
    await reply(message, 'That exact screenshot is already being checked. Your image is still here.');
    return;
  }

  const now = Date.now();
  for (const [userId, expiresAt] of cooldowns) {
    if (expiresAt <= now) cooldowns.delete(userId);
  }
  if ((cooldowns.get(message.author.id) || 0) > now) {
    await reply(message, 'Please wait a little before trying another screenshot. Your image is still here.');
    return;
  }

  pendingProofHashes.add(proof.hash);
  cooldowns.set(message.author.id, now + REVIEW_COOLDOWN_MS);
  await message.channel.sendTyping().catch(() => null);

  try {
    let review;
    try {
      review = await reviewProof(proof.bytes);
    } catch (error) {
      console.error('Local OCR failed:', error);
      await reply(message, 'Verification is temporarily unavailable. Your image is still here—please try again soon.');
      return;
    }

    if (!review.accepted) {
      await reply(message, 'I could not verify this screenshot: ' + review.reason + ' Your image is still here.');
      return;
    }

    try {
      const member = message.member || await message.guild.members.fetch(message.author.id);
      const role = message.guild.roles.cache.get(FREE_ACCESS_ROLE_ID) || await message.guild.roles.fetch(FREE_ACCESS_ROLE_ID);
      const botMember = message.guild.members.me || await message.guild.members.fetch(client.user.id);

      if (!role) throw new Error('Free Access role was not found.');
      if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error('Manage Roles permission is missing.');
      if (role.position >= botMember.roles.highest.position) throw new Error('Move Nightcrow Bot above Free Access in the role list.');
      if (!member.roles.cache.has(role.id)) await member.roles.add(role, 'Verified Nightcrow YouTube subscription proof');

      try {
        await rememberHash(proof.hash);
      } catch (error) {
        console.error('Could not persist proof hash:', error);
        proofHashes.add(proof.hash);
      }

      await reply(message, 'You have been successfully verified! You now have access to <#' + FREE_PRODUCTS_CHANNEL_ID + '>.');
    } catch (error) {
      console.error('Role grant failed:', error);
      await reply(message, 'Your screenshot looked valid, but I could not add the role. Please contact staff.');
    }
  } finally {
    pendingProofHashes.delete(proof.hash);
  }
});

async function loadProofHashes() {
  try {
    const saved = JSON.parse(await fs.readFile(HASH_STORE_PATH, 'utf8'));
    proofHashes = new Set(Array.isArray(saved) ? saved : []);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not load proof hashes:', error);
  }
}

loadProofHashes().then(() => client.login(DISCORD_TOKEN));

