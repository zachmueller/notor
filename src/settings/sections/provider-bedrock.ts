/**
 * AWS Bedrock provider section renderer.
 *
 * @see specs/03a-settings-refactor/tasks.md — S-003
 */

import { SecretComponent, Setting } from "obsidian";
import { SECRET_IDS } from "../../utils/secrets";
import { AWS_REGIONS } from "../constants";
import { getProvider, updateProvider } from "../helpers";
import { renderConnectionTestButton } from "./connection-test";
import type { SettingsContext } from "./context";

/** Render the "AWS Bedrock" provider settings. */
export function renderBedrockProviderSection(
	containerEl: HTMLElement,
	ctx: SettingsContext
): void {
	containerEl.createEl("h2", { text: "AWS Bedrock" });

	// IAM policy note
	containerEl.createEl("p", {
		text:
			"Required IAM permissions: bedrock:InvokeModelWithResponseStream " +
			"(for sending messages) and bedrock:ListInferenceProfiles " +
			"(for listing available models). " +
			"bedrock:ListFoundationModels is no longer needed.",
		cls: "setting-item-description",
	});

	const getBedrockProvider = () => getProvider(ctx.settings, "bedrock");

	// Region dropdown
	new Setting(containerEl)
		.setName("AWS region")
		.setDesc("The AWS region where your Bedrock models are available.")
		.addDropdown((dropdown) => {
			for (const { value, label } of AWS_REGIONS) {
				dropdown.addOption(value, label);
			}
			const current = getBedrockProvider().region ?? "us-east-1";
			dropdown.setValue(current);
			dropdown.onChange(async (value) => {
				const updated = { ...getBedrockProvider() };
				updated.region = value;
				updateProvider(ctx.settings, updated);
				await ctx.saveSettings();
			});
		});

	// Auth method toggle
	new Setting(containerEl)
		.setName("Authentication method")
		.setDesc(
			"Choose how to authenticate with AWS. " +
				"'AWS profile' delegates to the AWS credential chain (~/.aws/credentials, env vars, SSO). " +
				"'Access keys' stores credentials directly in Obsidian's secret storage."
		)
		.addDropdown((dropdown) => {
			dropdown.addOption("profile", "AWS profile");
			dropdown.addOption("keys", "Access keys");
			const method = getBedrockProvider().aws_auth_method ?? "profile";
			dropdown.setValue(method);
			dropdown.onChange(async (value: string) => {
				const updated = { ...getBedrockProvider() };
				updated.aws_auth_method = value as "profile" | "keys";
				updateProvider(ctx.settings, updated);
				await ctx.saveSettings();
				// Re-render to show/hide the relevant credential fields
				ctx.redisplay();
			});
		});

	const authMethod = getBedrockProvider().aws_auth_method ?? "profile";

	if (authMethod === "profile") {
		// Profile name text field
		new Setting(containerEl)
			.setName("AWS profile name")
			.setDesc(
				"The AWS named profile to use from ~/.aws/credentials or ~/.aws/config. " +
					"Uses the 'default' profile if left blank."
			)
			.addText((text) =>
				text
					.setPlaceholder("default")
					.setValue(getBedrockProvider().aws_profile ?? "default")
					.onChange(async (value) => {
						const updated = { ...getBedrockProvider() };
						updated.aws_profile = value.trim() || "default";
						updateProvider(ctx.settings, updated);
						await ctx.saveSettings();
					})
			);
	} else {
		// Access key ID
		new Setting(containerEl)
			.setName("Access key ID")
			.setDesc("Your AWS access key ID.")
			.addComponent(
				(el) =>
					new SecretComponent(ctx.app, el)
						.setValue(SECRET_IDS.BEDROCK_ACCESS_KEY_ID)
						.onChange((_value) => {
							// SecretComponent writes directly to SecretStorage.
						})
			);

		// Secret access key
		new Setting(containerEl)
			.setName("Secret access key")
			.setDesc("Your AWS secret access key.")
			.addComponent(
				(el) =>
					new SecretComponent(ctx.app, el)
						.setValue(SECRET_IDS.BEDROCK_SECRET_ACCESS_KEY)
						.onChange((_value) => {
							// SecretComponent writes directly to SecretStorage.
						})
			);
	}

	renderConnectionTestButton(containerEl, "bedrock", ctx);
}
