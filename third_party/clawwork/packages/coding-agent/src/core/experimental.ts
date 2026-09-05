export function areExperimentalFeaturesEnabled(): boolean {
	return (process.env.CLAWWORK_EXPERIMENTAL ?? process.env.PI_EXPERIMENTAL) === "1";
}
