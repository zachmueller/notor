/** Exhaustiveness helper — call in a switch default or if-else else branch. */
export function assertUnreachable(x: never): never {
	throw new Error("Unreachable: " + String(x));
}
