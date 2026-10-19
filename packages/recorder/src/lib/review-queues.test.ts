import { expect, it } from "vitest";
import { reviewQueue, REVIEW_QUEUES } from "./review-queues";
it("maps only the three supported menus and defaults malformed selectors to Solo", () => {
  expect(REVIEW_QUEUES.map((queue) => queue.id)).toEqual([420, 440, 400]);
  expect(reviewQueue("draft").id).toBe(400);
  expect(reviewQueue("flex").id).toBe(440);
  for (const key of [undefined, "aram", ["draft", "flex"]]) expect(reviewQueue(key).id).toBe(420);
});
