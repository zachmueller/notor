/**
 * Format a Date as a relative time string.
 *
 * Returns "Just now", "Xm ago", "Xh ago", "Xd ago", or a locale date string.
 */
export function formatRelativeTime(date: Date): string {
	const now = Date.now();
	const diff = now - date.getTime();
	const minutes = Math.floor(diff / 60000);
	const hours = Math.floor(diff / 3600000);
	const days = Math.floor(diff / 86400000);

	if (minutes < 1) return "Just now";
	if (minutes < 60) return `${minutes}m ago`;
	if (hours < 24) return `${hours}h ago`;
	if (days < 7) return `${days}d ago`;
	return date.toLocaleDateString();
}
