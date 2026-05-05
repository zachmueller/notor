/**
 * AWS Bedrock provider section renderer.
 *
 * @see specs/03a-settings-refactor/tasks.md — S-003
 */

import { SecretComponent, Setting } from "obsidian";
import { secretIdForAccessKeyId, secretIdForSecretAccessKey } from "../../utils/secrets";
import type { LLMProviderConfig } from "../../types";
import { AWS_REGIONS } from "../constants";
import { updateProvider } from "../helpers";
import { renderConnectionTestButton } from "./connection-test";
import { renderDeleteProviderButton } from "./provider-add";
import type { SettingsContext } from "./context";

/** Render the "AWS Bedrock" provider settings for a given instance. */
export function renderBedrockProviderSection(
	containerEl: HTMLElement,
	ctx: SettingsContext,
	config?: LLMProviderConfig
): void {
	const provider = config ?? ctx.settings.providers.find((p) => p.type === "bedrock")!;

	new Setting(containerEl).setHeading().setName(provider.display_name);

	const groupEl = containerEl.createDiv({ cls: "notor-provider-group" });

	// IAM policy note
	groupEl.createEl("p", {
		text:
			"Required IAM permissions: bedrock:InvokeModelWithResponseStream " +
			"(for sending messages) and bedrock:ListInferenceProfiles " +
			"(for listing available models). " +
			"bedrock:ListFoundationModels is optional — if granted, Notor also " +
			"lists marketplace models (Qwen, Mistral, AI21, etc.) that have no " +
			"cross-region inference profile.",
		cls: "setting-item-description",
	});

	// Region dropdown
	new Setting(groupEl)
		.setName("AWS region")
		.setDesc("The AWS region where your Bedrock models are available.")
		.addDropdown((dropdown) => {
			for (const { value, label } of AWS_REGIONS) {
				dropdown.addOption(value, label);
			}
			const current = provider.region ?? "us-east-1";
			dropdown.setValue(current);
			dropdown.onChange(async (value) => {
				provider.region = value;
				updateProvider(ctx.settings, provider);
				await ctx.saveSettings();
			});
		});

	// Auth method toggle
	new Setting(groupEl)
		.setName("Authentication method")
		.setDesc(
			"How to authenticate with AWS: 'AWS profile' uses the standard credential chain; " +
				"'access keys' stores them in Obsidian's secret storage."
		)
		.addDropdown((dropdown) => {
			dropdown.addOption("profile", "AWS profile");
			dropdown.addOption("keys", "Access keys");
			const method = provider.aws_auth_method ?? "profile";
			dropdown.setValue(method);
			dropdown.onChange(async (value: string) => {
				provider.aws_auth_method = value as "profile" | "keys";
				updateProvider(ctx.settings, provider);
				await ctx.saveSettings();
				ctx.redisplay();
			});
		});

	const authMethod = provider.aws_auth_method ?? "profile";

	if (authMethod === "profile") {
		// Profile name text field
		new Setting(groupEl)
			.setName("AWS profile name")
			.setDesc(
				"The AWS named profile to use. Leave blank to use the 'default' profile."
			)
			.addText((text) =>
				text
					.setPlaceholder("Default")
					.setValue(provider.aws_profile ?? "default")
					.onChange(async (value) => {
						provider.aws_profile = value.trim() || "default";
						updateProvider(ctx.settings, provider);
						await ctx.saveSettings();
					})
			);
	} else {
		// Access key ID
		new Setting(groupEl)
			.setName("Access key ID")
			.setDesc("Your AWS access key ID.")
			.addComponent(
				(el) =>
					new SecretComponent(ctx.app, el)
						.setValue(secretIdForAccessKeyId(provider.id))
						.onChange((_value) => {
							// SecretComponent writes directly to SecretStorage.
						})
			);

		// Secret access key
		new Setting(groupEl)
			.setName("Secret access key")
			.setDesc("Your AWS secret access key.")
			.addComponent(
				(el) =>
					new SecretComponent(ctx.app, el)
						.setValue(secretIdForSecretAccessKey(provider.id))
						.onChange((_value) => {
							// SecretComponent writes directly to SecretStorage.
						})
			);
	}

	renderConnectionTestButton(groupEl, provider.id, ctx);

	new Setting(groupEl)
		.setName("Display name")
		.addText((text) => {
			text
				.setValue(provider.display_name)
				.onChange(async (value) => {
					provider.display_name = value.trim() || provider.display_name;
					updateProvider(ctx.settings, provider);
					await ctx.saveSettings();
				});
			text.inputEl.addEventListener("blur", () => ctx.redisplay());
		});
	renderDeleteProviderButton(groupEl, provider, ctx);
}
