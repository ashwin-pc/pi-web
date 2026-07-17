export type RuntimePromptMode = "followUp" | "steer";

export function runtimePromptOptions(isStreaming: boolean, mode: unknown, images: Array<{ type: "image"; data: string; mimeType: string }>) {
  const streamingBehavior: RuntimePromptMode = mode === "followUp" ? "followUp" : "steer";
  return {
    ...(isStreaming ? { streamingBehavior } : {}),
    ...(images.length ? { images } : {}),
  };
}
