package app

import "context"

// The owner, 2026-10-12: 「我是管理员，不要对我有任何模型层面的限制，默认我是最高等级用户」. A workspace a platform
// administrator owns is the operator's own, and no model-level limit applies to it:
//   - its run limits are the highest the tenants row allows, with every model and no route limit; one an administrator
//     creates starts that way (createTenant), and the admin PATCH stays the way to change one;
//   - the free allowances the service counts outside that row do not hold it back: free image, video and 3D
//     generations (admitMediaGeneration) and TypeSafe evaluations (the typesafe daily limit).
//
// Deployment-wide totals still count its free generations, as before; it only no longer stops at them.

// The highest run limits the tenants row's CHECK constraints (and the admin PATCH) accept.
const (
	operatorMaxConcurrentRuns = 100
	operatorMaxRunsPerDay     = 100000
)

// operatorWorkspace reports whether a platform administrator owns the workspace.
func operatorWorkspace(ctx context.Context, q querier, tid string) (bool, error) {
	var owned bool
	err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id
		WHERE m.tenant_id=$1 AND m.role='owner' AND u.platform_role='admin')`, tid).Scan(&owned)
	return owned, err
}
