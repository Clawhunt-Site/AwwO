package operator

// SetLearningExportCheck runs check once an export's file is written, before its consents are read again; the func it
// answers puts things back.
func SetLearningExportCheck(check func()) func() {
	learningExportCheck = check
	return func() { learningExportCheck = nil }
}

// SetLearningExportMaxRuns sets the most runs one export carries; the func it answers puts it back.
func SetLearningExportMaxRuns(n int) func() {
	old := learningExportMaxRuns
	learningExportMaxRuns = n
	return func() { learningExportMaxRuns = old }
}
