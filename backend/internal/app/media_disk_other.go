//go:build !unix

package app

// diskFree is unknown off Unix; the deployed API runs on Linux.
func diskFree(string) (uint64, bool) { return 0, false }
