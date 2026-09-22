require('dotenv').config();

const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Client, Events, GatewayIntentBits, PermissionFlagsBits } = require('discord.js');

const PROOF_CHANNEL_ID = process.env.SUB_PROOF_CHANNEL_ID || '1551744713688621126';
const FREE_ACCESS_ROLE_ID = process.env.FREE_ACCESS_ROLE_ID || '1551747469455654963';
const FREE_PRODUCTS_CHANNEL_ID = process.env.FREE_PRODUCTS_CHANNEL_ID || '1551745615761768569';
const REVIEW_COOLDOWN_MS = 30_000;
const MAX_PROOF_BYTES = 10 * 1024 * 1024;
const HASH_STORE_PATH = process.env.PROOF_HASH_STORE_PATH || path.join(process.cwd(), 'data', 'proof-hashes.json');
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const cooldowns = new Map();
let proofHashes = new Set();
const pendingProofHashes = new Set();

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || process.env.BOT_TOKEN;
if (!DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is missing. Add it as a private server variable.');
const OCR_SERVICE_URL = process.env.OCR_SERVICE_URL;
const OCR_SERVICE_SECRET = process.env.OCR_SERVICE_SECRET;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent],
  allowedMentions: { parse: [] },
});

function hasOnlyOneImage(message) {
  if (message.content.trim() !== '' || message.attachments.size !== 1) return false;
  const attachment = message.attachments.first();
  const extension = path.extname(attachment.name || '').toLowerCase();
  return Boolean(
    attachment &&
    attachment.size <= MAX_PROOF_BYTES &&
    ((attachment.contentType || '').toLowerCase().startsWith('image/') || IMAGE_EXTENSIONS.has(extension))
  );
}

async function remove(message) {
  try {
    await message.delete();
    return true;
  } catch (error) {
    console.error('Could not remove invalid proof post:', error);
    return false;
  }
}

async function reply(message, text) {
  await message.reply({
    content: text,
    allowedMentions: { parse: [] },
    failIfNotExists: false,
  }).catch((error) => console.error('Could not send proof response:', error));
}

async function imageHash(attachment) {
  if (attachment.size > MAX_PROOF_BYTES) throw new Error('Proof image is too large.');
  const response = await fetch(attachment.url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error('Could not read the proof image (' + response.status + ').');
  const bytes = Buffer.from(await response.arrayBuffer());
  return createHash('sha256').update(bytes).digest('hex');
}

async function rememberHash(hash) {
  const updated = new Set(proofHashes);
  updated.add(hash);
  await fs.mkdir(path.dirname(HASH_STORE_PATH), { recursive: true });
  await fs.writeFile(HASH_STORE_PATH, JSON.stringify([...updated]), 'utf8');
  proofHashes = updated;
}

async function reviewProof(imageUrl) {
  if (!OCR_SERVICE_URL || !OCR_SERVICE_SECRET) {
    throw new Error('OCR_SERVICE_URL or OCR_SERVICE_SECRET is missing.');
  }
  const response = await fetch(OCR_SERVICE_URL.replace(/\/$/, '') + '/review', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-nightcrow-secret': OCR_SERVICE_SECRET,
    },
    body: JSON.stringify({ image_url: imageUrl }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error('OCR service returned ' + response.status + (detail ? ': ' + detail.slice(0, 180) : '.'));
  }
  const result = await response.json();
  return {
    accepted: result.accepted === true,
    reason: String(result.reason || 'The screenshot could not be verified.'),
  };
}

client.once(Events.ClientReady, (ready) => {
  console.log('Nightcrow Bot is online as ' + ready.user.tag + '.');
  if (!OCR_SERVICE_URL || !OCR_SERVICE_SECRET) {
    console.error('Proof checks are offline: OCR_SERVICE_URL and OCR_SERVICE_SECRET must both be configured.');
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || message.channelId !== PROOF_CHANNEL_ID || !message.guild) return;

  if (!hasOnlyOneImage(message)) {
    const removed = await remove(message);
    if (removed) await reply(message, 'Please send one image only—no text or other files.');
    else await reply(message, 'Please send one image only. I could not remove that post; ask a moderator for help.');
    return;
  }

  const attachment = message.attachments.first();
  let hash;
  try {
    hash = await imageHash(attachment);
  } catch (error) {
    console.error('Proof image read failed:', error);
    await reply(message, 'I could not read that image. Please try a PNG, JPG, or WEBP under 10 MB.');
    return;
  }

  if (proofHashes.has(hash)) {
    await reply(message, 'That exact screenshot was already submitted. This copy was not deleted.');
    return;
  }
  if (pendingProofHashes.has(hash)) {
    await reply(message, 'That exact screenshot is already being checked. This copy was not deleted.');
    return;
  }

  const now = Date.now();
  if ((cooldowns.get(message.author.id) || 0) > now) {
    await reply(message, 'Please wait a moment before sending another screenshot. Your image is still here.');
    return;
  }

  pendingProofHashes.add(hash);
  cooldowns.set(message.author.id, now + REVIEW_COOLDOWN_MS);
  try {
    let review;
    try {
      review = await reviewProof(attachment.url);
    } catch (error) {
      console.error('Proof review unavailable:', error);
      await reply(message, 'Verification is temporarily unavailable. Your image is still here—please try again soon.');
      return;
    }

    if (!review.accepted) {
      await reply(message, 'Not verified: ' + review.reason + ' Please send a clear NIGHT CROW STUDIOS subscription screenshot.');
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

      // Save only after review and role grant succeed, so an OCR outage or role issue
      // never prevents the member from retrying the same legitimate screenshot.
      try {
        await rememberHash(hash);
      } catch (error) {
        console.error('Could not persist proof hash:', error);
        proofHashes.add(hash);
      }

      await reply(message, 'You have been successfully verified! You now have access to <#' + FREE_PRODUCTS_CHANNEL_ID + '>.');
    } catch (error) {
      console.error('Role grant failed:', error);
      await reply(message, 'Your screenshot passed, but I could not add the role. Please contact a moderator.');
    }
  } finally {
    pendingProofHashes.delete(hash);
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
