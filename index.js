require('dotenv').config();

const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Client, Events, GatewayIntentBits, PermissionFlagsBits } = require('discord.js');
const { createWorker } = require('tesseract.js');

const PROOF_CHANNEL_ID = process.env.SUB_PROOF_CHANNEL_ID || '1551744713688621126';
const FREE_ACCESS_ROLE_ID = process.env.FREE_ACCESS_ROLE_ID || '1551747469455654963';
const FREE_PRODUCTS_CHANNEL_ID = process.env.FREE_PRODUCTS_CHANNEL_ID || '1551745615761768569';
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

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || process.env.BOT_TOKEN;
if (!DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is missing. Add it as a private server variable.');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent],
  allowedMentions: { parse: [] },
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
  return SUBSCRIBED_LABELS.some((label) => label.test(text.normalize('NFKC')));
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
