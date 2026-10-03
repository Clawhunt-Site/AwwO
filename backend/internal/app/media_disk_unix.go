//go:build unix && !linux

package app

import "syscall"

// diskFree is the space available to the API user on path's filesystem.
func diskFree(path string) (uint64, bool) {
	var st syscall.Statfs_t
	if syscall.Statfs(path, &st) != nil {
		return 0, false
	}
	return st.Bavail * uint64(st.Bsize), true
}
