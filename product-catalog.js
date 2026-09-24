'use strict';

const DEFAULT_REPOSITORY = 'OfficialUltimateMacro/NIGHTCROW_STUDIOS';
const DEFAULT_BRANCH = 'main';
const DEFAULT_PATH = 'catalog.json';

function slugify(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function cleanText(value, label, maxLength, required = false) {
  const text = String(value || '').trim();
  if (required && !text) throw new Error(label + ' is required.');
  if (text.length > maxLength) throw new Error(label + ' must be ' + maxLength + ' characters or fewer.');
  return text;
}

function httpsUrl(value, label, required = false) {
  const text = cleanText(value, label, 500, required);
  if (!text) return '';
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(label + ' must be a valid HTTPS URL.');
  }
  if (parsed.protocol !== 'https:') throw new Error(label + ' must start with https://.');
  return parsed.toString();
}

function lineList(value, label) {
  const lines = Array.isArray(value) ? value : String(value || '').split(/\r?\n/);
  return lines
    .map((line) => String(line).replace(/^\s*[-•*]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 12)
    .map((line) => cleanText(line, label, 180, true));
}

function normalizeProductDraft(input, options = {}) {
  const name = cleanText(input.name, 'Product name', 90, true);
  const id = slugify(input.id || name);
  if (!id) throw new Error('Product name needs at least one English letter or number.');

  return {
    id,
    name,
    category: cleanText(input.category, 'Category', 50, true),
    price: cleanText(input.price, 'Price', 50, true),
    summary: cleanText(input.summary, 'Short description', 180, true),
    description: cleanText(input.description, 'Product description', 1800, true),
    checkoutUrl: httpsUrl(input.checkoutUrl, 'Checkout URL', options.requireCheckoutUrl !== false),
    whopProductId: cleanText(input.whopProductId, 'Whop product ID', 100),
    whopPlanId: cleanText(input.whopPlanId, 'Whop plan ID', 100),
    imageUrl: httpsUrl(input.imageUrl, 'Cover image URL'),
    features: lineList(input.features, 'Feature'),
    includes: lineList(input.includes, 'Included item'),
    license: cleanText(input.license, 'Product license', 1800) || 'Use is governed by the Brightest Studios Terms and the license shown at checkout.',
    status: input.checkoutUrl ? 'published' : 'draft',
  };
}

function normalizeCatalog(value) {
  const catalog = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    version: 1,
    products: Array.isArray(catalog.products) ? catalog.products.filter((item) => item && typeof item === 'object') : [],
    updates: Array.isArray(catalog.updates) ? catalog.updates.filter((item) => item && typeof item === 'object').slice(0, 100) : [],
  };
}

function githubConfig(options = {}) {
  const token = options.token || process.env.GITHUB_TOKEN;
  if (!token) throw new Error('The product publisher is not configured yet. Add GITHUB_TOKEN to the Bright host variables.');

  const repository = options.repository || process.env.STOREFRONT_REPOSITORY || DEFAULT_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('STOREFRONT_REPOSITORY must use owner/repository format.');

  return {
    token,
    repository,
    branch: options.branch || process.env.STOREFRONT_BRANCH || DEFAULT_BRANCH,
    filePath: options.filePath || process.env.STOREFRONT_CATALOG_PATH || DEFAULT_PATH,
  };
}

function apiUrl(config, query = '') {
  const path = config.filePath.split('/').map(encodeURIComponent).join('/');
  return 'https://api.github.com/repos/' + config.repository + '/contents/' + path + query;
}

async function githubRequest(config, method, body) {
  const response = await fetch(apiUrl(config, method === 'GET' ? '?ref=' + encodeURIComponent(config.branch) : ''), {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + config.token,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'Brightest-Studios-Storefront',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (response.status === 404 && method === 'GET') return null;
  if (!response.ok) throw new Error('GitHub catalog request failed with HTTP ' + response.status + '. Check the bot token, repository, branch, and Contents permission.');
  return response.json();
}

async function readCatalog(options = {}) {
  const config = githubConfig(options);
  const file = await githubRequest(config, 'GET');
  if (!file) return normalizeCatalog({});

  try {
    return normalizeCatalog(JSON.parse(Buffer.from(file.content.replace(/\s/g, ''), 'base64').toString('utf8')));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('catalog.json is not valid JSON. Fix the file before publishing another product.');
    throw error;
  }
}

async function writeCatalog(catalogValue, message, options = {}) {
  const config = githubConfig(options);
  const current = await githubRequest(config, 'GET');
  const catalog = normalizeCatalog(catalogValue);
  const body = {
    message: cleanText(message, 'Commit message', 120, true),
    content: Buffer.from(JSON.stringify(catalog, null, 2) + '\n', 'utf8').toString('base64'),
    branch: config.branch,
    ...(current?.sha ? { sha: current.sha } : {}),
  };

  try {
    return await githubRequest(config, 'PUT', body);
  } catch (error) {
    if (error.message.includes('HTTP 409') || error.message.includes('HTTP 422')) {
      throw new Error('GitHub rejected the catalog update because the file changed or the branch is protected. Retry after the current Pages deployment finishes.');
    }
    throw error;
  }
}

module.exports = {
  githubConfig,
  lineList,
  normalizeCatalog,
  normalizeProductDraft,
  readCatalog,
  slugify,
  writeCatalog,
};

