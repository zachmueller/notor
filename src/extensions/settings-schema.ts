/**
 * Settings schema parsing and resolution for user-defined extensions.
 *
 * Parses the `settings` block from YAML code fences into typed schemas,
 * and resolves runtime values by merging defaults, persisted values, and
 * SecretStorage entries.
 */
