'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { lineList, normalizeCatalog, normalizeProductDraft, slugify } = require('./product-catalog');

test('slugify creates a stable path-safe product identifier', () => {
  assert.equal(slugify('Ocean Waves — PRO!'), 'ocean-waves-pro');
});

test('product validation requires HTTPS checkout and cover links', () => {
  assert.throws(() => normalizeProductDraft({
    name: 'Ocean System',
    category: 'Roblox systems',
    price: '$9.99 USD',
    summary: 'A configurable ocean system.',
    description: 'A complete ocean system.',
    checkoutUrl: 'http://checkout.example.test',
    features: ['Waves'],
    includes: ['Model'],
  }), /https/i);
});

test('product lists preserve both textarea lines and parsed arrays', () => {
  assert.deepEqual(lineList('Waves\n  - Foam', 'Feature'), ['Waves', 'Foam']);
  assert.deepEqual(lineList(['Waves', 'Foam'], 'Feature'), ['Waves', 'Foam']);
});

test('product draft normalizes listing and keeps its secure checkout URL', () => {
  const product = normalizeProductDraft({
    name: 'Ocean System',
    category: 'Roblox systems',
    price: '$9.99 USD',
    summary: 'A configurable ocean system.',
    description: 'A complete ocean system.',
    checkoutUrl: 'https://whop.com/checkout/example',
    imageUrl: '',
    features: ['Waves', 'Foam'],
    includes: ['Model', 'Guide'],
    license: '',
  });

  assert.equal(product.id, 'ocean-system');
  assert.equal(product.checkoutUrl, 'https://whop.com/checkout/example');
  assert.deepEqual(product.features, ['Waves', 'Foam']);
  assert.deepEqual(product.includes, ['Model', 'Guide']);
  assert.match(product.license, /Night Crow Studios Terms/);
});

test('private product form can be validated before Whop creates its checkout', () => {
  const product = normalizeProductDraft({
    name: 'Ocean System',
    category: 'Roblox systems',
    price: '$9.99 USD',
    summary: 'A configurable ocean system.',
    description: 'A complete ocean system.',
    features: ['Waves'],
    includes: ['Model'],
  }, { requireCheckoutUrl: false });

  assert.equal(product.checkoutUrl, '');
  assert.equal(product.status, 'draft');
});

test('catalog accepts only record arrays and caps update history', () => {
  const catalog = normalizeCatalog({
    products: [{ id: 'first' }, null, 'bad'],
    updates: Array.from({ length: 110 }, (_, index) => ({ id: String(index) })),
  });

  assert.equal(catalog.products.length, 1);
  assert.equal(catalog.updates.length, 100);
  assert.equal(normalizeCatalog(null).version, 1);
});

