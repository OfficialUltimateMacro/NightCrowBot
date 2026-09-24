'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWhopCheckout, formatUsdPrice, parseUsdPrice } = require('./whop-checkout');

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

const product = {
  id: 'ocean-system',
  name: 'Ocean System',
  summary: 'A configurable ocean system.',
  description: 'Waves, foam, and water settings for Roblox.',
  price: '$9.99 USD',
};

test('USD price input is parsed, formatted, and bounded', () => {
  assert.equal(parseUsdPrice('9'), 9);
  assert.equal(parseUsdPrice('$9.99 USD'), 9.99);
  assert.equal(formatUsdPrice('9.9'), '$9.90 USD');
  assert.throws(() => parseUsdPrice('0'), /greater than 0/i);
  assert.throws(() => parseUsdPrice('9.999'), /numbers only/i);
  assert.throws(() => parseUsdPrice('ten'), /numbers only/i);
});

test('publish creates a Whop product, one-time plan, and account promo with idempotency keys', async () => {
  const calls = [];
  const replies = [
    response({ id: 'prod_ocean' }),
    response({ id: 'plan_ocean', purchase_url: 'https://whop.com/checkout/plan_ocean' }),
    response({ id: 'promo_easy', code: 'easymoney' }),
  ];
  const result = await createWhopCheckout(product, {
    env: { WHOP_API_KEY: 'test-key', WHOP_ACCOUNT_ID: 'biz_test' },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return replies.shift();
    },
  });

  assert.deepEqual(result, {
    productId: 'prod_ocean',
    planId: 'plan_ocean',
    checkoutUrl: 'https://whop.com/checkout/plan_ocean',
    promo: { status: 'created', id: 'promo_easy' },
  });
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /\/products$/);
  assert.match(calls[1].url, /\/plans$/);
  assert.match(calls[2].url, /\/promo_codes$/);
  assert.equal(calls[0].options.headers['Idempotency-Key'], 'nightcrow-product-ocean-system');
  assert.equal(calls[1].options.headers['Idempotency-Key'], 'nightcrow-plan-ocean-system');
  assert.equal(calls[2].options.headers['Idempotency-Key'], 'nightcrow-promo-easymoney');
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    account_id: 'biz_test',
    product_id: 'prod_ocean',
    title: 'Ocean System',
    description: 'A configurable ocean system.',
    plan_type: 'one_time',
    initial_price: 9.99,
    currency: 'usd',
    release_method: 'buy_now',
    unlimited_stock: true,
    visibility: 'visible',
  });
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    account_id: 'biz_test',
    amount_off: 5,
    base_currency: 'usd',
    code: 'EASYMONEY',
    promo_type: 'percentage',
    one_per_customer: true,
    unlimited_stock: true,
  });
});

test('a pre-existing promo code does not prevent checkout publishing', async () => {
  const replies = [
    response({ id: 'prod_ocean' }),
    response({ id: 'plan_ocean', purchase_url: 'https://whop.com/checkout/plan_ocean' }),
    response({ error: { message: 'Code already exists' } }, 409),
  ];
  const result = await createWhopCheckout(product, {
    token: 'test-key',
    fetch: async () => replies.shift(),
  });

  assert.equal(result.promo.status, 'already-exists');
});

test('checkout API requires a private token and only accepts Whop HTTPS checkout URLs', async () => {
  await assert.rejects(() => createWhopCheckout(product, { env: {} }), /WHOP_API_KEY/);

  const replies = [
    response({ id: 'prod_ocean' }),
    response({ id: 'plan_ocean', purchase_url: 'https://attacker.example/checkout' }),
  ];
  await assert.rejects(() => createWhopCheckout(product, {
    token: 'test-key',
    fetch: async () => replies.shift(),
  }), /outside whop\.com/i);
});

