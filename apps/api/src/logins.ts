import { encryptLogin, decryptLogin, unwrapClientKey } from '../../../packages/security/src/index';
import type { ClientRow, Repo } from './repo';

export interface StoredLogin { username?: string; password: string; site: string }

/** Seals a login with the client's own key and saves it. Called by the form filler just before it sends a form. */
export async function storeClientLogin(repo: Repo, masterKey: Buffer, client: ClientRow, siteId: string, login: StoredLogin, userId: string | null) {
  const dek = unwrapClientKey(masterKey, client.wrappedDek, client.id);
  await repo.addClientLogin(client.id, siteId, encryptLogin(dek, client.id, login), userId);
}

/** Opens every login saved for a client (newest first). */
export async function readClientLogins(repo: Repo, masterKey: Buffer, client: ClientRow) {
  const dek = unwrapClientKey(masterKey, client.wrappedDek, client.id);
  return (await repo.listClientLogins(client.id)).map(l => {
    const d = decryptLogin(dek, client.id, l.encrypted) as StoredLogin;
    return { id: l.id, siteId: l.siteId, siteName: l.siteName, domain: l.domain, username: d.username ?? '', password: d.password, createdAt: l.createdAt };
  });
}
