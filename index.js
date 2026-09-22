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
const HASH_STORE_PATH = path.join(__dirname, 'data', 'proof-hashes.json');
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

async function say(channel, text) {
  await channel.send({ content: text, allowedMentions: { parse: [] } }).catch(() => null);
}

async function verificationSuccess(channel) {
  // Keep this as a simple confirmation, like the reference flow. Discord renders
  // the channel mention as a clickable link to the free-products channel.
  await channel.send({
    content: `You have been successfully verified! You now have access to <#${FREE_PRODUCTS_CHANNEL_ID}>.`,
    allowedMentions: { parse: [] },
  }).catch(() => null);
}

async function loadProofHashes() {
  try {
    const saved = JSON.parse(await fs.readFile(HASH_STORE_PATH, 'utf8'));
    proofHashes = new Set(Array.isArray(saved) ? saved : []);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not load proof hashes:', error);
  }
}

async function imageHash(attachment) {
  if (attachment.size > MAX_PROOF_BYTES) throw new Error('Proof image is too large.');
  const response = await fetch(attachment.url);
  if (!response.ok) throw new Error(`Could not read the proof image (${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return createHash('sha256').update(bytes).digest('hex');
}

async function rememberHash(hash) {
  proofHashes.add(hash);
  await fs.mkdir(path.dirname(HASH_STORE_PATH), { recursive: true });
  await fs.writeFile(HASH_STORE_PATH, JSON.stringify([...proofHashes]), 'utf8');
}

async function reviewProof(imageUrl) {
  if (!OCR_SERVICE_URL || !OCR_SERVICE_SECRET) return { accepted: false, reason: 'Local OCR verification is not configured yet.' };
  const response = await fetch(`${OCR_SERVICE_URL.replace(/\/$/, '')}/review`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-nightcrow-secret': OCR_SERVICE_SECRET },
    body: JSON.stringify({ image_url: imageUrl }), signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`OCR service returned ${response.status}.`);
  const result = await response.json();
  return { accepted: result.accepted === true, reason: String(result.reason || 'The screenshot could not be verified.') };
}

client.once(Events.ClientReady, (ready) => {
  console.log(`Nightcrow Bot is online as ${ready.user.tag}.`);
  if (!OCR_SERVICE_URL || !OCR_SERVICE_SECRET) console.warn('OCR service is not configured: proof posts will be rejected safely.');
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || message.channelId !== PROOF_CHANNEL_ID) return;

  if (!hasOnlyOneImage(message)) {
    await remove(message);
    await say(message.channel, 'Please send one image only, with no caption or extra files.');
    return;
  }

  const attachment = message.attachments.first();
  let hash;
  try {
    hash = await imageHash(attachment);
  } catch (error) {
    console.error('Proof hash failed:', error);
    await say(message.channel, 'I could not read that image. Please try a PNG, JPG, or WEBP screenshot under 10 MB.');
    return;
  }

  if (proofHashes.has(hash)) {
    await say(message.channel, 'That exact screenshot has already been submitted. Your image has not been deleted.');
    return;
  }
  if (pendingProofHashes.has(hash)) {
    await say(message.channel, 'That exact screenshot is already being checked. Your image has not been deleted.');
    return;
  }

  const now = Date.now();
  if ((cooldowns.get(message.author.id) || 0) > now) {
    await say(message.channel, 'Please wait a little before submitting another screenshot. Your image has been kept.');
    return;
  }

  pendingProofHashes.add(hash);
  cooldowns.set(message.author.id, now + REVIEW_COOLDOWN_MS);
  await message.channel.sendTyping().catch(() => null);
  try {
    let review;
    try {
      review = await reviewProof(attachment.url);
    } catch (error) {
      console.error('Proof review failed:', error);
      await say(message.channel, 'I could not verify this screenshot right now. Your image is still here—please try again shortly or contact staff.');
      return;
    }

    if (!review.accepted) {
      await say(message.channel, `I could not verify that subscription screenshot, so no role was added. ${review.reason} Please upload a clear screenshot showing NIGHT CROW STUDIOS and the subscribed state.`);
      return;
    }

    // Record only verified screenshots. Temporary OCR outages or rejected proofs
    // do not burn the user's exact image and prevent a legitimate retry.
    try {
      await rememberHash(hash);
    } catch (error) {
      console.error('Could not persist proof hash:', error);
      proofHashes.add(hash);
    }

    try {
      const member = message.member || await message.guild.members.fetch(message.author.id);
      const role = message.guild.roles.cache.get(FREE_ACCESS_ROLE_ID) || await message.guild.roles.fetch(FREE_ACCESS_ROLE_ID);
      if (!role) throw new Error('Free Access role was not found.');
      if (!message.guild.members.me.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error('Manage Roles permission is missing.');
      if (role.position >= message.guild.members.me.roles.highest.position) throw new Error('Move Nightcrow Bot above Free Access in the role list.');
      if (!member.roles.cache.has(role.id)) await member.roles.add(role, 'Verified Nightcrow YouTube subscription proof');
      await verificationSuccess(message.channel);
    } catch (error) {
      console.error('Role grant failed:', error);
      await say(message.channel, 'Your subscription proof was verified, but I could not add the role. Please contact staff.');
    }
  } finally {
    pendingProofHashes.delete(hash);
  }
});

loadProofHashes().then(() => client.login(DISCORD_TOKEN));

