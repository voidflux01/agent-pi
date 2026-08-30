// ABOUTME: Session-scoped receipt accessors. Replaces the removed execution-runs directory kernel.

export {
	getExecutionContract as loadGoal,
	getVerifierReceipt as loadVerifierReceipt,
	setVerifierReceipt as saveVerifierReceipt,
	setExecutionContract,
	resetExecutionVerification,
} from "./coordination-state.ts";
