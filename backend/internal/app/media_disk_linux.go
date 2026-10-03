//go:build linux

package app

import "syscall"

// diskFree is the space available to the API user on path's filesystem. Free blocks are counted in
// fragments, which some filesystems (NFS among them) make smaller than the preferred block size.
func diskFree(path string) (uint64, bool) {
	var st syscall.Statfs_t
	if syscall.Statfs(path, &st) != nil {
		return 0, false
	}
	size := uint64(st.Frsize)
	if size == 0 {
		size = uint64(st.Bsize)
	}
	return st.Bavail * size, true
}
