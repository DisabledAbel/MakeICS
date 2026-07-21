export function decodeUnicodeEscapes(str) {
  if (!str) return str;
  return str.replace(/\\u([0-9a-fA-F]{4})/g, (match, grp) => {
    return String.fromCharCode(parseInt(grp, 16));
  }).replace(/&amp;/g, '&');
}
