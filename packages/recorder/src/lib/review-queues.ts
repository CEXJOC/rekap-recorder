export const REVIEW_QUEUES = [
  { id: 420, key: "solo", label: "Solo/Duo" },
  { id: 440, key: "flex", label: "Flex" },
  { id: 400, key: "draft", label: "Draft" },
] as const;
export type ReviewQueue = (typeof REVIEW_QUEUES)[number];
export function reviewQueue(key: string | string[] | undefined): ReviewQueue {
  return REVIEW_QUEUES.find((queue) => queue.key === key) ?? REVIEW_QUEUES[0];
}
