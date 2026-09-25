'use strict';

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { normalizeCatalog, normalizeProductDraft, readCatalog, slugify, uploadPublicCover, writeCatalog } = require('./product-catalog');
const { createWhopCheckout, formatUsdPrice } = require('./whop-checkout');

const WEBSITE_URL = (process.env.STOREFRONT_URL || 'https://brighteststudios.com').replace(/\/$/, '');
const PRODUCT_DRAFT_TTL = 20 * 60 * 1000;
const productDrafts = new Map();

function productCommandDefinition() {
  return new SlashCommandBuilder()
    .setName('product')
    .setDescription('Create and manage Brightest Studios storefront listings')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((option) => option.setName('create').setDescription('Build a product listing and checkout page'))
    .addSubcommand((option) => option.setName('list').setDescription('List published products and their IDs'))
    .addSubcommand((option) => option
      .setName('cover')
      .setDescription('Upload a product cover directly from Discord')
      .addStringOption((field) => field.setName('product').setDescription('Product ID shown in its page URL').setRequired(true).setMaxLength(64))
      .addAttachmentOption((field) => field.setName('image').setDescription('PNG, JPEG, or WebP, up to 8 MB').setRequired(true)))
    .addSubcommand((option) => option
      .setName('update')
      .setDescription('Post a product update to the website')
      .addStringOption((field) => field.setName('product').setDescription('Product ID shown in its page URL').setRequired(true).setMaxLength(64))
      .addStringOption((field) => field.setName('title').setDescription('Update heading or version').setRequired(true).setMaxLength(100))
      .addStringOption((field) => field.setName('details').setDescription('What changed').setRequired(true).setMaxLength(1000)))
    .addSubcommand((option) => option
      .setName('remove')
      .setDescription('Unlist a product without deleting its record')
      .addStringOption((field) => field.setName('product').setDescription('Product ID shown in its page URL').setRequired(true).setMaxLength(64)));
}

function draftKey(interaction) {
  return interaction.guildId + ':' + interaction.user.id;
}

function canManageProducts(interaction) {
  return Boolean(interaction.guild && (
    interaction.user.id === interaction.guild.ownerId ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
  ));
}

function inputRow(id, label, style, maxLength, required, placeholder) {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(style)
    .setMaxLength(maxLength)
    .setRequired(required);
  if (placeholder) input.setPlaceholder(placeholder);
  return new ActionRowBuilder().addComponents(input);
}

function metadataModal() {
  return new ModalBuilder()
    .setCustomId('nightcrow:product:metadata')
    .setTitle('Create product · 1 of 2')
    .addComponents(
      inputRow('name', 'Product name', TextInputStyle.Short, 90, true, 'Example: Ocean Waves System'),
      inputRow('category', 'Category', TextInputStyle.Short, 50, true, 'Systems, VFX, UI, resources…'),
      inputRow('price', 'One-time price in USD', TextInputStyle.Short, 50, true, '9.99'),
      inputRow('summary', 'Short product summary', TextInputStyle.Paragraph, 180, true, 'One clear sentence for product cards'),
    );
}

function detailsModal() {
  return new ModalBuilder()
    .setCustomId('nightcrow:product:details')
    .setTitle('Create product · 2 of 2')
    .addComponents(
      inputRow('description', 'Product description', TextInputStyle.Paragraph, 1800, true, 'What the buyer receives and how it works'),
      inputRow('features', 'Features, one per line', TextInputStyle.Paragraph, 1000, true, 'Responsive controls\nConfigurable settings'),
      inputRow('includes', 'Files included, one per line', TextInputStyle.Paragraph, 1000, true, 'Roblox model\nSetup guide'),
      inputRow('image', 'Public HTTPS cover image URL (optional)', TextInputStyle.Short, 500, false, 'Use a stable URL, not a temporary Discord attachment'),
      inputRow('license', 'Product-specific license notes (optional)', TextInputStyle.Paragraph, 1800, false, 'Leave blank to use the standard site license'),
    );
}

function productPageUrl(productId) {
  return WEBSITE_URL + '/product.html?slug=' + encodeURIComponent(productId);
}

function parseLines(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-•*]\s*/, '').trim())
    .filter(Boolean);
}

function productEmbed(product, title = product.name) {
  const embed = new EmbedBuilder()
    .setColor(0x101215)
    .setAuthor({ name: 'BRIGHTEST STUDIOS' })
    .setTitle(title)
    .setURL(productPageUrl(product.id))
    .setDescription(product.summary)
    .addFields(
      { name: 'Price', value: product.price, inline: true },
      { name: 'Category', value: product.category, inline: true },
    )
    .setFooter({ text: 'Product details and license • Brightest Studios' });
  if (product.imageUrl) embed.setImage(product.imageUrl);
  return embed;
}

async function updatesChannel(guild) {
  const channelId = process.env.PRODUCT_UPDATES_CHANNEL_ID;
  const channel = channelId
    ? await guild.channels.fetch(channelId).catch(() => null)
    : guild.channels.cache.find((candidate) => candidate.name === 'product-updates');
  return channel?.isTextBased() ? channel : null;
}

async function announceProduct(guild, product) {
  const channel = await updatesChannel(guild);
  if (!channel) return;

  await channel.send({
    embeds: [productEmbed(product)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('View product').setStyle(ButtonStyle.Link).setURL(productPageUrl(product.id)),
    )],
    allowedMentions: { parse: [] },
  });
}

function productPreview(product) {
  const embed = new EmbedBuilder()
    .setColor(0x101215)
    .setAuthor({ name: 'BRIGHTEST STUDIOS' })
    .setTitle(product.name)
    .setDescription(product.summary)
    .addFields(
      { name: 'Price', value: product.price, inline: true },
      { name: 'Category', value: product.category, inline: true },
      { name: 'Checkout', value: 'Whop one-time checkout is created when you publish', inline: true },
    )
    .setFooter({ text: 'Review it, then choose Publish to make it public.' });
  if (product.imageUrl) embed.setImage(product.imageUrl);
  return embed;
}

async function createProduct(interaction) {
  await interaction.showModal(metadataModal());
}

async function handleCommand(interaction) {
  if (!canManageProducts(interaction)) {
    await interaction.reply({ content: 'Only the server owner or a member with Manage Server can publish products.', ephemeral: true });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'create') return createProduct(interaction);

  await interaction.deferReply({ ephemeral: true });
  try {
    const catalog = normalizeCatalog(await readCatalog());
    if (subcommand === 'list') {
      const listed = catalog.products.filter((item) => item.status !== 'archived');
      await interaction.editReply(listed.length ? listed.slice(0, 25).map((item) => '`' + item.id + '` · ' + item.name + ' · ' + item.price).join('\n') : 'No products are listed yet.');
      return;
    }
    const productId = slugify(interaction.options.getString('product', true));
    const product = catalog.products.find((item) => item.id === productId && item.status !== 'archived');
    if (!product) throw new Error('That product ID is not currently listed on the storefront.');

    if (subcommand === 'cover') {
      product.imageUrl = await uploadPublicCover(product.id, interaction.options.getAttachment('image', true));
      product.updatedAt = new Date().toISOString();
      await writeCatalog(catalog, 'Set product cover: ' + product.id);
      await interaction.editReply('Cover saved for **' + product.name + '**. It will appear after the Pages deployment finishes.');
      return;
    }

    if (subcommand === 'remove') {
      product.status = 'archived';
      product.updatedAt = new Date().toISOString();
      await writeCatalog(catalog, 'Unlist storefront product: ' + product.id);
      await interaction.editReply('Unlisted **' + product.name + '**. The product record and update history were kept. Cloudflare Pages will update after the GitHub deployment finishes.');
      return;
    }

    const title = interaction.options.getString('title', true).trim();
    const details = interaction.options.getString('details', true).trim();
    if (!title || !details) throw new Error('Both the update title and details are required.');

    const update = {
      id: 'update-' + Date.now().toString(36),
      productId: product.id,
      productName: product.name,
      title: title.slice(0, 100),
      details: details.slice(0, 1000),
      createdAt: new Date().toISOString(),
    };
    catalog.updates.unshift(update);
    catalog.updates = catalog.updates.slice(0, 100);
    product.updatedAt = update.createdAt;
    await writeCatalog(catalog, 'Post product update: ' + product.id);
    await interaction.editReply('Posted the update for **' + product.name + '** to the website. Cloudflare Pages will refresh after the GitHub deployment finishes.');

    const channel = await updatesChannel(interaction.guild);
    if (channel) {
      const embed = new EmbedBuilder()
        .setColor(0x101215)
        .setAuthor({ name: 'BRIGHTEST STUDIOS' })
        .setTitle(update.title)
        .setDescription(update.details)
        .addFields({ name: 'Product', value: product.name, inline: true })
        .setURL(WEBSITE_URL + '/product-updates.html#' + encodeURIComponent(update.id))
        .setFooter({ text: 'Brightest Studios • Product update' });
      await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch((error) => {
        console.error('Website update published, but Discord announcement failed:', error);
      });
    }
  } catch (error) {
    console.error('Product command failed:', error);
    await interaction.editReply(error.message || 'Product update failed. Check the Bright console.');
  }
}

async function handleMetadataSubmit(interaction) {
  if (!canManageProducts(interaction)) {
    await interaction.reply({ content: 'Only the server owner or a member with Manage Server can publish products.', ephemeral: true });
    return;
  }

  const key = draftKey(interaction);
  let price;
  try {
    price = formatUsdPrice(interaction.fields.getTextInputValue('price'));
  } catch (error) {
    await interaction.reply({ content: error.message, ephemeral: true });
    return;
  }

  const draft = {
    name: interaction.fields.getTextInputValue('name').trim(),
    category: interaction.fields.getTextInputValue('category').trim(),
    price,
    summary: interaction.fields.getTextInputValue('summary').trim(),
    createdAt: Date.now(),
  };

  try {
    normalizeProductDraft({ ...draft, description: 'Draft description', features: [], includes: [] }, { requireCheckoutUrl: false });
    productDrafts.set(key, draft);
    await interaction.reply({
      content: 'Product basics saved. Continue with the page description, features, files, and license.',
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('nightcrow:product:details:' + interaction.user.id).setLabel('Continue setup').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('nightcrow:product:cancel:' + interaction.user.id).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
      )],
      ephemeral: true,
    });
  } catch (error) {
    await interaction.reply({ content: error.message, ephemeral: true });
  }
}

async function handleDetailsButton(interaction) {
  if (!canManageProducts(interaction) || interaction.customId.split(':').at(-1) !== interaction.user.id) {
    await interaction.reply({ content: 'This product draft belongs to another staff member.', ephemeral: true });
    return;
  }

  const draft = productDrafts.get(draftKey(interaction));
  if (!draft || Date.now() - draft.createdAt > PRODUCT_DRAFT_TTL) {
    productDrafts.delete(draftKey(interaction));
    await interaction.reply({ content: 'That draft expired. Run `/product create` to start again.', ephemeral: true });
    return;
  }

  await interaction.showModal(detailsModal());
}

async function handleDetailsSubmit(interaction) {
  if (!canManageProducts(interaction)) {
    await interaction.reply({ content: 'Only the server owner or a member with Manage Server can publish products.', ephemeral: true });
    return;
  }

  const key = draftKey(interaction);
  const draft = productDrafts.get(key);
  if (!draft || Date.now() - draft.createdAt > PRODUCT_DRAFT_TTL) {
    productDrafts.delete(key);
    await interaction.reply({ content: 'That draft expired. Run `/product create` to start again.', ephemeral: true });
    return;
  }

  let product;
  try {
    product = normalizeProductDraft({
      ...draft,
      description: interaction.fields.getTextInputValue('description'),
      features: parseLines(interaction.fields.getTextInputValue('features')),
      includes: parseLines(interaction.fields.getTextInputValue('includes')),
      imageUrl: interaction.fields.getTextInputValue('image'),
      license: interaction.fields.getTextInputValue('license'),
    }, { requireCheckoutUrl: false });
  } catch (error) {
    await interaction.reply({ content: error.message, ephemeral: true });
    return;
  }

  productDrafts.set(key, { product, createdAt: draft.createdAt, publishing: false });
  await interaction.reply({
    content: 'Check the listing below. Nothing is public until you press **Publish product**.',
    embeds: [productPreview(product)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('nightcrow:product:publish:' + interaction.user.id).setLabel('Publish product').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('nightcrow:product:cancel:' + interaction.user.id).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    )],
    ephemeral: true,
  });
}

async function handlePublishButton(interaction) {
  if (!canManageProducts(interaction) || interaction.customId.split(':').at(-1) !== interaction.user.id) {
    await interaction.reply({ content: 'This product draft belongs to another staff member.', ephemeral: true });
    return;
  }

  const key = draftKey(interaction);
  const draft = productDrafts.get(key);
  if (!draft?.product || Date.now() - draft.createdAt > PRODUCT_DRAFT_TTL) {
    await interaction.deferUpdate();
    productDrafts.delete(key);
    await interaction.editReply({ content: 'That draft expired. Run `/product create` to start again.', embeds: [], components: [] });
    return;
  }
  if (draft.publishing) {
    await interaction.reply({ content: 'This product is already being published. Give it a moment.', ephemeral: true });
    return;
  }
  draft.publishing = true;
  await interaction.deferUpdate();

  const productDraft = draft.product;
  try {
    const catalog = normalizeCatalog(await readCatalog());
    if (catalog.products.some((item) => item.id === productDraft.id && item.status !== 'archived')) {
      throw new Error('A product with that URL ID is already listed. Change its name or use `/product update` for changes.');
    }

    const whop = draft.whop || await createWhopCheckout(productDraft);
    draft.whop = whop;
    productDrafts.set(key, draft);
    const publishedAt = new Date().toISOString();
    const product = {
      ...normalizeProductDraft({
        ...productDraft,
        checkoutUrl: whop.checkoutUrl,
        whopProductId: whop.productId,
        whopPlanId: whop.planId,
      }),
      createdAt: publishedAt,
      updatedAt: publishedAt,
    };

    catalog.products.unshift(product);
    catalog.updates.unshift({
      id: 'launch-' + product.id,
      productId: product.id,
      productName: product.name,
      title: 'New product',
      details: product.summary,
      createdAt: product.createdAt,
    });
    await writeCatalog(catalog, 'Publish storefront product: ' + product.id);
    productDrafts.delete(key);
    const pageUrl = productPageUrl(product.id);
    const promoNote = whop.promo.status === 'created'
      ? ' The 5% EASYMONEY code was created for the Whop account.'
      : whop.promo.status === 'already-exists'
        ? ' EASYMONEY already exists in Whop; verify it is 5% off and applies to all products.'
        : ' The product checkout works, but EASYMONEY could not be verified: ' + (whop.promo.message || 'check the Whop promo-code settings.') + '.';
    await interaction.editReply({
      content: 'Published **' + product.name + '**. Product page: ' + pageUrl + '. Whop checkout: ' + product.checkoutUrl + '. Cloudflare Pages will update after its GitHub deployment completes.' + promoNote,
      embeds: [],
      components: [],
    });
    await announceProduct(interaction.guild, product).catch((error) => {
      console.error('Product page published, but its Discord embed could not be sent:', error);
    });
  } catch (error) {
    console.error('Product publish failed:', error);
    await interaction.editReply({
      content: (error.message || 'Product publish failed. Check the Bright console.') + (draft.whop ? ' The Whop checkout was already created; use Publish product again to retry the website update.' : ''),
      embeds: [productPreview(productDraft)],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('nightcrow:product:publish:' + interaction.user.id).setLabel('Publish product').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('nightcrow:product:cancel:' + interaction.user.id).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
      )],
    });
  } finally {
    if (productDrafts.has(key)) draft.publishing = false;
  }
}

async function handleCancelButton(interaction) {
  if (interaction.customId.split(':').at(-1) !== interaction.user.id) {
    await interaction.reply({ content: 'This product draft belongs to another staff member.', ephemeral: true });
    return;
  }

  productDrafts.delete(draftKey(interaction));
  await interaction.update({ content: 'Product draft cancelled.', embeds: [], components: [] });
}

async function registerProductCommand(client) {
  const configuredGuildId = process.env.GUILD_ID;
  const guild = configuredGuildId
    ? client.guilds.cache.get(configuredGuildId) || await client.guilds.fetch(configuredGuildId).catch(() => null)
    : client.guilds.cache.first();

  if (!guild) {
    console.warn('Skipping /product registration: set GUILD_ID or add Crow to a guild.');
    return;
  }

  const existing = await guild.commands.fetch();
  const current = existing.find((command) => command.name === 'product');
  const definition = productCommandDefinition().toJSON();
  if (current) await guild.commands.edit(current.id, definition);
  else await guild.commands.create(definition);
  console.log('Registered /product in guild ' + guild.id + '.');
}

async function handleProductInteraction(interaction) {
  if (interaction.isChatInputCommand() && interaction.commandName === 'product') {
    await handleCommand(interaction);
    return true;
  }

  if (interaction.isModalSubmit() && interaction.customId === 'nightcrow:product:metadata') {
    await handleMetadataSubmit(interaction);
    return true;
  }

  if (interaction.isModalSubmit() && interaction.customId === 'nightcrow:product:details') {
    await handleDetailsSubmit(interaction);
    return true;
  }

  if (!interaction.isButton()) return false;
  if (interaction.customId.startsWith('nightcrow:product:details:')) await handleDetailsButton(interaction);
  else if (interaction.customId.startsWith('nightcrow:product:publish:')) await handlePublishButton(interaction);
  else if (interaction.customId.startsWith('nightcrow:product:cancel:')) await handleCancelButton(interaction);
  else return false;
  return true;
}

module.exports = { handleProductInteraction, registerProductCommand };

