export class TemplateVariableRegistry {
	private resolvers = new Map<string, () => string>();

	register(name: string, resolver: () => string): void {
		this.resolvers.set(name, resolver);
	}

	resolve(input: string): string {
		let result = input;
		for (const [name, resolver] of this.resolvers) {
			result = result.split(`{${name}}`).join(resolver());
		}
		return result;
	}

	list(): string[] {
		return [...this.resolvers.keys()];
	}
}
