/**
 * Connection test button renderer, shared across provider sections.
 *
 * Uses a dynamic `import()` for the provider registry to avoid
 * circular dependencies at module load time (same pattern as the
 * original code).
 *
 * @see specs/03a-settings-refactor/tasks.md — S-003
 */

import { Notice, Setting } from "obsidian";
import type { SettingsContext } from "./context";
import { getProvider } from "../helpers";

/**
 * Render a "Test connection" button for a provider section.
 *
 * For AWS Bedrock, performs an STS GetCallerIdentity call (equivalent
 * to `aws sts get-caller-identity`) to verify that the configured
 * credentials are valid, then shows the account and ARN in a Notice.
 */
export function renderConnectionTestButton(
	containerEl: HTMLElement,
	providerType: string,
	ctx: SettingsContext
): void {
	const setting = new Setting(containerEl)
		.setName("Test connection")
		.setDesc("Verify that the provider is reachable and credentials are valid.");

	if (providerType === "bedrock") {
		renderBedrockConnectionTestButton(containerEl, setting, ctx);
		return;
	}

	let statusEl: HTMLElement | null = null;

	setting.addButton((button) => {
		button.setButtonText("Test connection").onClick(async () => {
			button.setDisabled(true);
			button.setButtonText("Testing…");
			if (statusEl) statusEl.remove();

			// Inline status element rendered below the setting row
			statusEl = containerEl.createEl("p", {
				cls: "notor-connection-status notor-connection-status--pending",
				text: "Connecting…",
			});
			setting.settingEl.after(statusEl);

			try {
				// Dynamically import the provider registry to avoid
				// circular dependency at module load time.
				const { buildProviderRegistry } = await import(
					"../../providers/registry-factory"
				);
				const registry = buildProviderRegistry(
					ctx.app,
					ctx.settings
				);
				const provider = registry.getProvider(
					providerType as import("../../types").LLMProviderType
				);
				await provider.validateConnection();

				statusEl.textContent = "✓ Connection successful";
				statusEl.className =
					"notor-connection-status notor-connection-status--success";
			} catch (e) {
				const message =
					e instanceof Error ? e.message : String(e);
				statusEl.textContent = `✗ ${message}`;
				statusEl.className =
					"notor-connection-status notor-connection-status--error";
			} finally {
				button.setDisabled(false);
				button.setButtonText("Test connection");
			}
		});
	});
}

/**
 * Render the Bedrock-specific "Test connection" button.
 *
 * Calls STS GetCallerIdentity (equivalent to `aws sts get-caller-identity`)
 * using the same credential resolution logic as BedrockProvider. On success,
 * displays the AWS Account ID and caller ARN in an Obsidian Notice and inline
 * status element so the user can confirm they are authenticated correctly.
 */
async function renderBedrockConnectionTestButton(
	containerEl: HTMLElement,
	setting: import("obsidian").Setting,
	ctx: SettingsContext
): Promise<void> {
	let statusEl: HTMLElement | null = null;

	setting
		.setDesc(
			"Calls AWS STS GetCallerIdentity to verify your AWS credentials " +
				"are valid (equivalent to `aws sts get-caller-identity`)."
		)
		.addButton((button) => {
			button.setButtonText("Test connection").onClick(async () => {
				button.setDisabled(true);
				button.setButtonText("Testing…");
				if (statusEl) statusEl.remove();

				statusEl = containerEl.createEl("p", {
					cls: "notor-connection-status notor-connection-status--pending",
					text: "Connecting…",
				});
				setting.settingEl.after(statusEl);

				try {
					const { STSClient, GetCallerIdentityCommand } =
						await import("@aws-sdk/client-sts");
					const { fromIni } = await import(
						"@aws-sdk/credential-providers"
					);
					const { getSecret } = await import("../../utils/secrets");
					const { SECRET_IDS } = await import("../../utils/secrets");

					const bedrockConfig = getProvider(ctx.settings, "bedrock");
					const authMethod =
						bedrockConfig.aws_auth_method ?? "profile";
					const region = bedrockConfig.region ?? "us-east-1";

					let credentials:
						| ReturnType<typeof fromIni>
						| { accessKeyId: string; secretAccessKey: string };

					if (authMethod === "keys") {
						const accessKeyId = getSecret(
							ctx.app,
							SECRET_IDS.BEDROCK_ACCESS_KEY_ID
						);
						const secretAccessKey = getSecret(
							ctx.app,
							SECRET_IDS.BEDROCK_SECRET_ACCESS_KEY
						);
						if (!accessKeyId || !secretAccessKey) {
							throw new Error(
								"AWS access keys not configured. Add your access key ID and secret access key in the fields above."
							);
						}
						credentials = { accessKeyId, secretAccessKey };
					} else {
						const profile =
							bedrockConfig.aws_profile ?? "default";
						credentials = fromIni({ profile });
					}

					const stsClient = new STSClient({ region, credentials });
					const response = await stsClient.send(
						new GetCallerIdentityCommand({})
					);

					const account = response.Account ?? "unknown";
					const arn = response.Arn ?? "unknown";
					const userId = response.UserId ?? "unknown";

					const successMsg =
						`✓ Authenticated — Account: ${account} | ARN: ${arn}`;
					statusEl.textContent = successMsg;
					statusEl.className =
						"notor-connection-status notor-connection-status--success";

					new Notice(
						`AWS credentials valid\nAccount: ${account}\nARN: ${arn}\nUser ID: ${userId}`,
						8000
					);
				} catch (e) {
					const message =
						e instanceof Error ? e.message : String(e);
					statusEl.textContent = `✗ ${message}`;
					statusEl.className =
						"notor-connection-status notor-connection-status--error";
				} finally {
					button.setDisabled(false);
					button.setButtonText("Test connection");
				}
			});
		});
}
