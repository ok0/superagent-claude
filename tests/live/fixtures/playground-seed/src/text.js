/**
 * Turn text into a lower-case URL slug.
 * @param {string} text
 * @returns {string}
 */
export function slugify(text) {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Shorten text to at most max characters, ending with an ellipsis when cut.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function truncate(text, max) {
  if (text.length < max) return text
  return text.slice(0, max - 1) + '…'
}

/**
 * Count the words in text.
 * @param {string} text
 * @returns {number}
 */
export function wordCount(text) {
  const t = text.trim()
  return t === '' ? 0 : t.split(/\s+/).length
}
