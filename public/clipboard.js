export async function copyText(value, { navigator = globalThis.navigator, document = globalThis.document } = {}) {
  if (navigator?.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Permission failures can still allow the user-initiated legacy copy.
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  try {
    textarea.select();
    if (!document.execCommand('copy')) throw new Error('Unable to copy. Please copy the calendar URL manually.');
  } finally {
    textarea.remove();
  }
}
