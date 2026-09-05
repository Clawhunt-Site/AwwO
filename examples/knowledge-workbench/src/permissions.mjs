// UI affordances only. The HTTP service must authorize every request itself.
export const ROLES = Object.freeze(['Owner', 'Admin', 'Editor', 'Viewer']);
const everyone = ['workspace.read', 'document.read.published', 'search.query', 'dashboard.read.published'];
const editors = ['document.read.draft', 'document.read.versions', 'document.read.governance',
  'document.create', 'document.edit', 'document.metadata.update', 'document.tag.assign',
  'document.publish', 'document.archive', 'document.soft-delete', 'dashboard.read.governance',
  'collection.read', 'tag.read', 'tag.create', 'tag.update', 'tag.delete-unused'];
const admins = ['collection.create', 'collection.update', 'collection.delete-empty',
  'governance.rules.update', 'audit.read'];
const memberActions = ['membership.invite', 'membership.role.update', 'membership.disable',
  'membership.enable', 'membership.remove'];
const contextual = ['membership.read', 'membership.leave', ...memberActions, 'workspace.owner.transfer'];
export const ACTIONS = Object.freeze([...everyone, ...editors, ...admins,
  'workspace.settings.update', ...contextual]);

export function can(context, action, target = {}) {
  const { user, workspace, membership, sessionValid, capabilities } = context ?? {};
  if (sessionValid !== true || typeof user?.user_id !== 'string' || !user.user_id ||
      typeof workspace?.workspace_id !== 'string' || !workspace.workspace_id ||
      user?.status !== 'active' || workspace?.status !== 'active' ||
      membership?.status !== 'active' || membership.user_id !== user.user_id ||
      membership.workspace_id !== workspace.workspace_id || !ROLES.includes(membership.role) ||
      !ACTIONS.includes(action)) return false;
  if (target.workspace_id && target.workspace_id !== workspace.workspace_id) return false;
  if (capabilities !== undefined && (!Array.isArray(capabilities) || !capabilities.includes(action))) return false;
  const role = membership.role;
  if (action === 'membership.read') return ['Owner', 'Admin'].includes(role) || target.user_id === user.user_id;
  if (action === 'membership.leave') return role !== 'Owner' && target.user_id === user.user_id;
  if (action === 'workspace.owner.transfer') return role === 'Owner' && typeof target.user_id === 'string' &&
    !!target.user_id && target.reauthenticated === true &&
    target.accepted === true && target.status === 'active' && target.user_id !== user.user_id;
  if (memberActions.includes(action)) {
    if (!['Owner', 'Admin'].includes(role)) return false;
    const allowed = role === 'Owner' ? ['Admin', 'Editor', 'Viewer'] : ['Editor', 'Viewer'];
    if (action === 'membership.invite') return allowed.includes(target.next_role ?? 'Viewer');
    if (!target.user_id || !['active', 'disabled'].includes(target.status) || !allowed.includes(target.role)) return false;
    if (role === 'Admin' && target.user_id === user.user_id) return false;
    return !target.next_role || allowed.includes(target.next_role);
  }
  return everyone.includes(action) ||
    (role !== 'Viewer' && editors.includes(action)) ||
    (['Owner', 'Admin'].includes(role) && admins.includes(action)) ||
    (role === 'Owner' && action === 'workspace.settings.update');
}

export function capabilitiesFor(context) {
  return ACTIONS.filter(action => can(context, action, context?.membership));
}

export function uiAccess(context) {
  return Object.freeze({
    search: can(context, 'search.query'), manageDocuments: can(context, 'document.read.draft'),
    createDocument: can(context, 'document.create'), governance: can(context, 'dashboard.read.governance'),
    members: can(context, 'membership.read'), settings: can(context, 'workspace.settings.update'),
    collections: can(context, 'collection.create'), tags: can(context, 'tag.create'),
    audit: can(context, 'audit.read'),
  });
}
