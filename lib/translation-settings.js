'use strict';

const DEFAULTS = Object.freeze({
  ai_translation_enabled: false,
  ai_base_url: 'https://api.openai.com/v1',
  ai_model: '',
});

function validBaseUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 2048
      || /[\s\\?#]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password
      && !url.search && !url.hash;
  } catch { return false; }
}

function validModel(value) {
  return typeof value === 'string' && value.length <= 160
    && (value === '' || /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value));
}

module.exports = { DEFAULTS, validBaseUrl, validModel };
