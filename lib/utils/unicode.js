export function decodeUnicodeEscapes(str) {
  if (!str) return str;
  return str.replace(/\\u([0-9a-fA-F]{4})/g, (match, grp) => {
    return String.fromCharCode(parseInt(grp, 16));
  }).replace(/&amp;/g, '&');
}

// Inline focused tests for decodeUnicodeEscapes
if (typeof process !== 'undefined' && process.env.NODE_ENV === 'test') {
  try {
    const testModule = await import('node:test');
    const assertModule = await import('node:assert/strict');

    testModule.default('decodeUnicodeEscapes - focused tests', () => {
      // 1. Four-digit Unicode escapes
      assertModule.default.equal(decodeUnicodeEscapes('Hello \\u0026 World'), 'Hello & World');
      assertModule.default.equal(decodeUnicodeEscapes('\\u0041\\u0042\\u0043'), 'ABC');

      // 2. Surrogate-pair decoding
      assertModule.default.equal(decodeUnicodeEscapes('\\uD83D\\uDE00'), '😀');

      // 3. HTML entity conversion from &amp;
      assertModule.default.equal(decodeUnicodeEscapes('A &amp; B'), 'A & B');
      assertModule.default.equal(decodeUnicodeEscapes('A &amp; B \\u0026 C'), 'A & B & C');

      // 4. Null or empty inputs & falsy values (existing passthrough behavior)
      assertModule.default.equal(decodeUnicodeEscapes(null), null);
      assertModule.default.equal(decodeUnicodeEscapes(''), '');
      assertModule.default.equal(decodeUnicodeEscapes(undefined), undefined);
    });
  } catch (e) {
    // Ignore any import/execution issues outside test runner environment
  }
}
