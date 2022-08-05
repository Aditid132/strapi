'use strict';

const crypto = require('crypto');
const { map, omit, differenceBy } = require('lodash/fp');

/**
 * @typedef {'read-only'|'full-access'|'custom'} TokenType
 */

/**
 * @typedef ApiToken
 *
 * @property {number|string} id
 * @property {string} name
 * @property {string} [description]
 * @property {string} accessKey
 * @property {TokenType} type
 * @property {(number|ApiTokenPermission)[]} [permissions]
 */

/**
 * @typedef ApiTokenPermission
 *
 * @property {number|string} id
 * @property {string} action
 * @property {ApiToken|number} [token]
 */

/** @constant {Array<string>} */
const SELECT_FIELDS = ['id', 'name', 'description', 'type', 'createdAt'];

/** @constant {Array<string>} */
const POPULATE_FIELDS = ['permissions'];

const assertCustomTokenPermissionsValidity = attributes => {
  // Ensure non-custom tokens doesn't have permissions
  if (attributes.type !== 'custom' && attributes.permissions) {
    throw new Error('Non-custom tokens should not references permissions');
  }

  // Custom type tokens should always have permissions attached to them
  if (attributes.type === 'custom' && !attributes.permissions) {
    throw new Error('Missing permissions attributes for custom token');
  }
};

/**
 * @param {Object} whereParams
 * @param {string|number} [whereParams.id]
 * @param {string} [whereParams.name]
 * @param {string} [whereParams.description]
 * @param {string} [whereParams.accessKey]
 *
 * @returns {Promise<boolean>}
 */
const exists = async (whereParams = {}) => {
  const apiToken = await getBy(whereParams);

  return !!apiToken;
};

/**
 * @param {string} accessKey
 *
 * @returns {string}
 */
const hash = accessKey => {
  return crypto
    .createHmac('sha512', strapi.config.get('admin.apiToken.salt'))
    .update(accessKey)
    .digest('hex');
};

/**
 * @param {Object} attributes
 * @param {TokenType} attributes.type
 * @param {string} attributes.name
 * @param {string[]} [attributes.permissions]
 * @param {string} [attributes.description]
 *
 * @returns {Promise<ApiToken>}
 */
const create = async attributes => {
  const accessKey = crypto.randomBytes(128).toString('hex');

  assertCustomTokenPermissionsValidity(attributes);

  // Create the token
  const apiToken = await strapi.query('admin::api-token').create({
    select: SELECT_FIELDS,
    populate: POPULATE_FIELDS,
    data: {
      ...omit('permissions', attributes),
      accessKey: hash(accessKey),
    },
  });

  const result = { ...apiToken, accessKey };

  // If this is a custom type token, create and link the associated permissions
  if (attributes.type === 'custom') {
    const permissions = await strapi
      .query('admin::token-permission')
      .createMany({ data: attributes.permissions.map(action => ({ action, token: apiToken.id })) });

    Object.assign(result, { permissions });
  }

  return result;
};

/**
 * @returns {void}
 */
const checkSaltIsDefined = () => {
  if (!strapi.config.get('admin.apiToken.salt')) {
    // TODO V5: stop reading API_TOKEN_SALT
    if (process.env.API_TOKEN_SALT) {
      process.emitWarning(`[deprecated] In future versions, Strapi will stop reading directly from the environment variable API_TOKEN_SALT. Please set apiToken.salt in config/admin.js instead.
For security reasons, keep storing the secret in an environment variable and use env() to read it in config/admin.js (ex: \`apiToken: { salt: env('API_TOKEN_SALT') }\`). See https://docs.strapi.io/developer-docs/latest/setup-deployment-guides/configurations/optional/environment.html#configuration-using-environment-variables.`);

      strapi.config.set('admin.apiToken.salt', process.env.API_TOKEN_SALT);
    } else {
      throw new Error(
        `Missing apiToken.salt. Please set apiToken.salt in config/admin.js (ex: you can generate one using Node with \`crypto.randomBytes(16).toString('base64')\`).
For security reasons, prefer storing the secret in an environment variable and read it in config/admin.js. See https://docs.strapi.io/developer-docs/latest/setup-deployment-guides/configurations/optional/environment.html#configuration-using-environment-variables.`
      );
    }
  }
};

/**
 * @returns {Promise<Omit<ApiToken, 'accessKey'>>}
 */
const list = async () => {
  return strapi.query('admin::api-token').findMany({
    select: SELECT_FIELDS,
    populate: POPULATE_FIELDS,
    orderBy: { name: 'ASC' },
  });
};

/**
 * @param {string|number} id
 *
 * @returns {Promise<Omit<ApiToken, 'accessKey'>>}
 */
const revoke = async id => {
  return strapi
    .query('admin::api-token')
    .delete({ select: SELECT_FIELDS, populate: POPULATE_FIELDS, where: { id } });
};

/**
 * @param {string|number} id
 *
 * @returns {Promise<Omit<ApiToken, 'accessKey'>>}
 */
const getById = async id => {
  return getBy({ id });
};

/**
 * @param {string} name
 *
 * @returns {Promise<Omit<ApiToken, 'accessKey'>>}
 */
const getByName = async name => {
  return getBy({ name });
};

/**
 * @param {string|number} id
 * @param {Object} attributes
 * @param {TokenType} attributes.type
 * @param {string} attributes.name
 * @param {string} [attributes.description]
 *
 * @returns {Promise<Omit<ApiToken, 'accessKey'>>}
 */
const update = async (id, attributes) => {
  const oldToken = await strapi.query('admin::api-token').findOne({ where: { id } });

  if (!oldToken) {
    throw new Error('Token not found');
  }

  assertCustomTokenPermissionsValidity({ ...attributes, type: attributes.type || oldToken.type });

  const token = await strapi.query('admin::api-token').update({
    select: SELECT_FIELDS,
    populate: POPULATE_FIELDS,
    where: { id },
    data: omit('permissions', attributes),
  });

  if (token.type === 'custom') {
    const permissionsToDelete = differenceBy('action', token.permissions, attributes.permissions);
    const permissionsToCreate = differenceBy('action', attributes.permissions, token.permissions);

    await strapi
      .query('admin::token-permission')
      .deleteMany({ where: { action: map('action', permissionsToDelete) } });

    await strapi
      .query('admin::token-permission')
      .createMany({ data: permissionsToCreate.map(({ action }) => ({ action, token: id })) });
  }

  const permissions = await strapi.entityService.load('admin::api-token', token, 'permissions');

  return { ...token, permissions };
};

/**
 * @param {Object} whereParams
 * @param {string|number} [whereParams.id]
 * @param {string} [whereParams.name]
 * @param {string} [whereParams.description]
 * @param {string} [whereParams.accessKey]
 *
 * @returns {Promise<Omit<ApiToken, 'accessKey'> | null>}
 */
const getBy = async (whereParams = {}) => {
  if (Object.keys(whereParams).length === 0) {
    return null;
  }

  return strapi
    .query('admin::api-token')
    .findOne({ select: SELECT_FIELDS, populate: POPULATE_FIELDS, where: whereParams });
};

module.exports = {
  create,
  exists,
  checkSaltIsDefined,
  hash,
  list,
  revoke,
  getById,
  update,
  getByName,
  getBy,
};
