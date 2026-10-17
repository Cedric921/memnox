/**
 * What gets signed. The subject is a proposal or pending id, so an old signature confirms nothing new.
 * Words the person rewrote on a draft card go last and whole, so the signature covers exactly what is sent.
 * It lives apart from the key store so a screen that only signs can import it without Node.
 */
export function confirmationMessage(
  subject: string,
  answer: string,
  edited?: string,
): string {
  if (edited === undefined) return `memnox-confirm:v1:${subject}:${answer}`;
  return `memnox-confirm:v2:${subject}:${answer}:${edited}`;
}
