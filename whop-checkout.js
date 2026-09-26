'use strict';

const DEFAULT_ACCOUNT_ID = 'biz_0bsVpFW750nDlH';
const DEFAULT_API_VERSION_DATE = '2026-08-21-1';
const API_BASE_URL = 'https://api.whop.com/api/v1';

function readConfig(options = {}) {
  const env = options.env || process.env;
  const token = options.token || env.WHOP_API_KEY;
  if (!token) {
    throw new Error('Whop is not configured. Add WHOP_API_KEY to the Bright bot host variables.');
  }

  return {
    token,
    accountId: options.accountId || env.WHOP_ACCOUNT_ID || DEFAULT_ACCOUNT_ID,
    apiVersionDate: options.apiVersionDate || env.WHOP_API_VERSION_DATE || DEFAULT_API_VERSION_DATE,
  };
}

function parseUsdPrice(value) {
  const raw = String(value ?? '').trim().replace(/^\$/, '').replace(/\s*USD$/i, '').replace(/,/g, '');
  if (!/^(?:\d+)(?:\.\d{1,2})?$/.test(raw)) {
    throw new Error('Enter a USD price using numbers only, such as 9.99.');
  }

  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) {
    throw new Error('USD price must be greater than 0 and no more than 1,000,000.');
  }
  return Math.round(amount * 100) / 100;
}

function formatUsdPrice(value) {
  return '$' + parseUsdPrice(value).toFixed(2) + ' USD';
}

function idempotencyKey(kind, productId) {
  return 'nightcrow-' + kind + '-' + productId;
}

function responseData(value) {
  return value && value.data && !Array.isArray(value.data) ? value.data : value;
}

async function requestWhop(config, method, path, body, key, fetchImpl) {
  const response = await fetchImpl(API_BASE_URL + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + config.token,
      'Content-Type': 'application/json',
      'Api-Version-Date': config.apiVersionDate,
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const rawBody = await response.text();
  let result = {};
  try {
    result = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    result = { message: rawBody };
  }

  if (!response.ok) {
    const message = result.error?.message || result.message || 'Request rejected';
    const error = new Error('Whop API returned HTTP ' + response.status + ': ' + message);
    error.status = response.status;
    throw error;
  }
  return responseData(result);
}

async function ensureEasyMoneyPromo(config, fetchImpl) {
  try {
    const promo = await requestWhop(config, 'POST', '/promo_codes', {
      account_id: config.accountId,
      amount_off: 5,
      base_currency: 'usd',
      code: 'EASYMONEY',
      promo_type: 'percentage',
      new_users_only: false,
      churned_users_only: false,
      existing_memberships_only: false,
      one_per_customer: true,
      unlimited_stock: true,
    }, idempotencyKey('promo', 'easymoney'), fetchImpl);
    return { status: 'created', id: promo.id || '' };
  } catch (error) {
    if (error.status === 409) return { status: 'already-exists' };
    return { status: 'needs-review', message: error.message };
  }
}

async function createWhopCheckout(product, options = {}) {
  const config = readConfig(options);
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('This Node.js runtime does not provide fetch. Use Node 20 or newer.');

  const price = parseUsdPrice(product.price);
  const whopProduct = await requestWhop(config, 'POST', '/products', {
    account_id: config.accountId,
    title: product.name,
    headline: product.summary,
    description: product.description,
    route: product.id,
    visibility: 'visible',
    metadata: { nightcrow_catalog_id: product.id },
  }, idempotencyKey('product', product.id), fetchImpl);

  if (!whopProduct?.id) throw new Error('Whop created the product but returned no product ID. Contact staff before retrying.');

  const whopPlan = await requestWhop(config, 'POST', '/plans', {
    account_id: config.accountId,
    product_id: whopProduct.id,
    title: product.name.slice(0, 30),
    description: product.summary,
    plan_type: 'one_time',
    initial_price: price,
    currency: 'usd',
    release_method: 'buy_now',
    unlimited_stock: true,
    visibility: 'visible',
  }, idempotencyKey('plan', product.id), fetchImpl);

  if (!whopPlan?.id || !whopPlan.purchase_url) {
    throw new Error('Whop created the product but did not return a usable checkout URL. Contact staff before retrying.');
  }

  let checkoutUrl;
  try {
    checkoutUrl = new URL(whopPlan.purchase_url);
  } catch {
    throw new Error('Whop returned an invalid checkout URL. Contact staff before publishing.');
  }
  if (checkoutUrl.protocol !== 'https:' || !/(^|\.)whop\.com$/i.test(checkoutUrl.hostname)) {
    throw new Error('Whop returned a checkout URL outside whop.com. Contact staff before publishing.');
  }

  const promo = await ensureEasyMoneyPromo(config, fetchImpl);
  return {
    productId: whopProduct.id,
    planId: whopPlan.id,
    checkoutUrl: checkoutUrl.toString(),
    promo,
  };
}

async function uploadWhopFile(attachment, options = {}) {
  const config = readConfig(options);
  const fetchImpl = options.fetch || globalThis.fetch;
  const source = new URL(attachment.url);
  if (source.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(source.hostname) || !attachment.size || attachment.size > 20 * 1024 * 1024) {
    throw new Error('Attach a file directly in Discord, up to 20 MB.');
  }
  const filename = String(attachment.name || 'product-file').replace(/[\\/\r\n]/g, '_').slice(0, 180);
  const file = await requestWhop(config, 'POST', '/files', { filename }, undefined, fetchImpl);
  if (!file?.id || !file?.upload_url) throw new Error('Whop did not return a file upload destination.');
  const destination = new URL(file.upload_url);
  if (destination.protocol !== 'https:') throw new Error('Whop returned an unsafe upload destination.');
  const download = await fetchImpl(source);
  if (!download.ok) throw new Error('Discord attachment expired. Upload it again.');
  const bytes = Buffer.from(await download.arrayBuffer());
  if (bytes.length !== attachment.size) throw new Error('Attachment size changed during transfer.');
  const uploaded = await fetchImpl(destination, { method: 'PUT', headers: file.upload_headers || {}, body: bytes });
  if (!uploaded.ok) throw new Error('Whop rejected the file bytes (HTTP ' + uploaded.status + ').');
  return { id: file.id, filename };
}

module.exports = { createWhopCheckout, formatUsdPrice, parseUsdPrice, uploadWhopFile };

