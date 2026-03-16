declare module "mammoth" {
    export function convertToHtml(
        input: { buffer: Buffer },
        options?: Record<string, unknown>
    ): Promise<{ value: string; messages: unknown[] }>;
}
