export type Role = 'admin' | 'operator' | 'viewer';
export type Permission =
  | 'client:read' | 'client:write' | 'client:delete'
  | 'site:read' | 'site:write'
  | 'batch:run' | 'approval:grant'
  | 'user:manage' | 'audit:read' | 'login:read';

const ALL: Permission[] = [
  'client:read', 'client:write', 'client:delete', 'site:read', 'site:write',
  'batch:run', 'approval:grant', 'user:manage', 'audit:read', 'login:read',
];
const MATRIX: Record<Role, Permission[]> = {
  admin: ALL,
  operator: ['client:read', 'client:write', 'client:delete', 'site:read', 'batch:run', 'approval:grant'],
  viewer: ['client:read', 'site:read'],
};

export interface Actor { id: string; role: Role; assignedClientIds: string[] }

export function can(actor: Actor, permission: Permission): boolean {
  return MATRIX[actor.role]?.includes(permission) ?? false;
}

/** Client data needs both the right permission AND an assignment to that client (admins are assigned to all). */
export function canAccessClient(actor: Actor, clientId: string, permission: Permission): boolean {
  if (!permission.startsWith('client:') && permission !== 'login:read' && permission !== 'batch:run' && permission !== 'approval:grant') return false;
  if (!can(actor, permission)) return false;
  return actor.role === 'admin' || actor.assignedClientIds.includes(clientId);
}
