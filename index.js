require('dotenv').config();

const OpenAI = require('openai');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Client, Events, GatewayIntentBits, EmbedBuilder, PermissionFlagsBits } = require('discord.js');

const PROOF_CHANNEL_ID = process.env.SUB_PROOF_CHANNEL_ID || '1551744713688621126';
const FREE_ACCESS_ROLE_ID = process.env.FREE_ACCESS_ROLE_ID || '1551747469455654963';
const FREE_PRODUCTS_CHANNEL_ID = process.env.FREE_PRODUCTS_CHANNEL_ID || '1551745615761768569';
const REVIEW_COOLDOWN_MS = 30_000;
const MAX_PROOF_BYTES = 10 * 1024 * 1024;
const HASH_STORE_PATH = path.join(__dirname, 'data', 'proof-hashes.json');
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const cooldowns = new Map();
let proofHashes = new Set();

if (!process.env.DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is missing. Add it as a private server variable.');
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent],
  allowedMentions: { parse: [] },
});

function embed(title, description, fields = []) {
  return new EmbedBuilder().setColor(0x090909).setAuthor({ name: 'NIGHTCROW STUDIOS' })
    .setTitle(title).setDescription(description).addFields(fields)
    .setFooter({ text: 'Nightcrow verification' }).setTimestamp();
}

function hasOnlyOneImage(message) {
  if (message.content.trim() || message.attachments.size !== 1) return false;
  const file = message.attachments.first();
  const name = file.name?.toLowerCase() || '';
  return Boolean(file.contentType?.startsWith('image/') || [...IMAGE_EXTENSIONS].some((ext) => name.endsWith(ext)));
}

async function remove(message) {
  if (message.deletable) await message.delete().catch(() => null);
}

async function say(channel, title, description, fields) {
  await channel.send({ embeds: [embed(title, description, fields)], allowedMentions: { parse: [] } }).catch(() => null);
}

async function verificationSuccess(channel, roleId) {
  const cleanEmbed = new EmbedBuilder()
    .setColor(0xf2f3f0)
    .setDescription(`Your subscription proof has been verified. You now have access to <#${FREE_PRODUCTS_CHANNEL_ID}>.`);
  await channel.send({ embeds: [cleanEmbed], allowedMentions: { roles: [roleId] } }).catch(() => null);
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
  if (!openai) return { accepted: false, reason: 'Automatic review is not configured yet.' };
  const instructions = [
    'Review this Discord YouTube subscription-proof screenshot. Be extremely strict.',
    'Accept ONLY if it clearly shows a real YouTube channel page or subscription confirmation for NIGHT CROW STUDIOS / NIGHTCROW STUDIOS or @RBLXNIGHTCROWSTUDIOS, AND a visible currently subscribed state.',
    'The subscribed label may be in any language. Light/dark themes, mobile/desktop layouts, and color themes are acceptable.',
    'Reject NSFW/sexual content, unrelated images or GIFs, artwork, thumbnails, text-only images, non-YouTube UI, another channel, a visible Subscribe button rather than a subscribed state, unclear/possibly edited images, or anything you cannot confidently verify. Never guess.',
    'Return only JSON: {"accepted":boolean,"reason":"short explanation"}.',
  ].join(' ');
  const response = await openai.responses.create({
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    input: [{ role: 'user', content: [{ type: 'input_text', text: instructions }, { type: 'input_image', image_url: imageUrl, detail: 'high' }] }],
    text: { format: { type: 'json_schema', name: 'subscription_proof_review', strict: true, schema: {
      type: 'object', properties: { accepted: { type: 'boolean' }, reason: { type: 'string' } },
      required: ['accepted', 'reason'], additionalProperties: false,
    } } },
  });
  const result = JSON.parse(response.output_text);
  return { accepted: result.accepted === true, reason: String(result.reason || 'The screenshot could not be verified.') };
}

client.once(Events.ClientReady, (ready) => {
  console.log(`Nightcrow Bot is online as ${ready.user.tag}.`);
  if (!openai) console.warn('OPENAI_API_KEY is not set: proof posts will be rejected safely.');
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || message.channelId !== PROOF_CHANNEL_ID) return;
  const now = Date.now();
  if ((cooldowns.get(message.author.id) || 0) > now) {
    await remove(message); await say(message.channel, 'Please wait', 'One proof submission can be reviewed every 30 seconds.'); return;
  }
  cooldowns.set(message.author.id, now + REVIEW_COOLDOWN_MS);
  if (!hasOnlyOneImage(message)) {
    await remove(message);
    await say(message.channel, 'Proof not accepted', 'Upload **one image only**—no text, captions, links, extra files, or non-image attachments.');
    return;
  }
  const attachment = message.attachments.first();
  let hash;
  try {
    hash = await imageHash(attachment);
    if (proofHashes.has(hash)) {
      await remove(message);
      await say(message.channel, 'Proof already used', 'That exact screenshot has already been submitted. Upload your own current subscription proof.');
      return;
    }
    await rememberHash(hash);
  } catch (error) {
    console.error('Proof hash failed:', error); await remove(message);
    await say(message.channel, 'Proof not accepted', 'I could not safely read that image. Upload a normal screenshot under 10 MB.');
    return;
  }
  await message.channel.sendTyping().catch(() => null);
  let review;
  try { review = await reviewProof(attachment.url); }
  catch (error) {
    console.error('Proof review failed:', error); await remove(message);
    await say(message.channel, 'Proof review unavailable', 'Your image was removed to keep this channel clean. Try again later or contact staff.'); return;
  }
  if (!review.accepted) {
    await remove(message);
    await say(message.channel, 'Proof not accepted', `No role was added. ${review.reason}`, [{ name: 'Required proof', value: 'A clear YouTube screenshot showing **Night Crow Studios** and a visible **subscribed** state.' }]);
    return;
  }
  try {
    const member = message.member || await message.guild.members.fetch(message.author.id);
    const role = message.guild.roles.cache.get(FREE_ACCESS_ROLE_ID) || await message.guild.roles.fetch(FREE_ACCESS_ROLE_ID);
    if (!role) throw new Error('Free Access role was not found.');
    if (!message.guild.members.me.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error('Manage Roles permission is missing.');
    if (role.position >= message.guild.members.me.roles.highest.position) throw new Error('Move Nightcrow Bot above Free Access in the role list.');
    if (!member.roles.cache.has(role.id)) await member.roles.add(role, 'Verified Nightcrow YouTube subscription proof');
    await remove(message);
    await verificationSuccess(message.channel, role.id);
  } catch (error) {
    console.error('Role grant failed:', error); await remove(message);
    await say(message.channel, 'Verified, but setup needs attention', 'Your proof passed, but I could not add the role. Staff: give the bot **Manage Roles** and place its role above Free Access.');
  }
});

loadProofHashes().then(() => client.login(process.env.DISCORD_TOKEN));
