// Which process identity the permission answers reflect. Platforms may
// attribute grants to a responsible parent process rather than the helper
// executable itself.
export type PermissionAttribution = "helper-app" | "caller";

export interface PermissionSource {
	attribution: PermissionAttribution;
	pid?: number;
	parentPid?: number;
	executablePath?: string;
	parentPath?: string;
	parentBundleId?: string;
	os?: string;
}

export interface PermissionStatus {
	accessibility: boolean;
	screenRecording: boolean;
	screenRecordingPreflight?: boolean;
	source?: PermissionSource;
}
