export function displayNameFrom(contact) {
  return contact?.name || contact?.pushname || null;
}
