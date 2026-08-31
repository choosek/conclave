/**
 * Unit tests for the quorum-meter geometry.
 *
 * These pin the three rules the renderer depends on: the filled-segment count is
 * clamped into the committee size, the meter reads reconstructable exactly at the
 * k-th share, and the threshold tick is placed at `k / m` of the width and
 * omitted when it would be meaningless.
 */

import { describe, expect, test } from "vitest";
import { quorumModel } from "#/core/quorum";

describe("quorumModel", () => {
  test("fills the first `sharesPosted` of `m` segments", () => {
    const model = quorumModel(2, 3, 5);
    expect(model.segments).toEqual([true, true, false, false, false]);
    expect(model.ready).toBe(false);
    expect(model.tickPercent).toBeCloseTo(60);
  });

  test("reads reconstructable at exactly the k-th share", () => {
    expect(quorumModel(2, 3, 5).ready).toBe(false);
    expect(quorumModel(3, 3, 5).ready).toBe(true);
    expect(quorumModel(4, 3, 5).ready).toBe(true);
  });

  test("clamps an over-count to the committee size", () => {
    const model = quorumModel(9, 2, 3);
    expect(model.segments).toEqual([true, true, true]);
  });

  test("clamps a negative count to zero", () => {
    const model = quorumModel(-1, 2, 3);
    expect(model.segments).toEqual([false, false, false]);
    expect(model.ready).toBe(false);
  });

  test("omits the tick when k is at or beyond m", () => {
    expect(quorumModel(0, 3, 3).tickPercent).toBeNull();
    expect(quorumModel(0, 5, 3).tickPercent).toBeNull();
  });

  test("omits the tick and is never ready when k is zero", () => {
    const model = quorumModel(0, 0, 3);
    expect(model.tickPercent).toBeNull();
    expect(model.ready).toBe(false);
  });

  test("produces no segments for an empty committee", () => {
    const model = quorumModel(0, 0, 0);
    expect(model.segments).toEqual([]);
    expect(model.tickPercent).toBeNull();
  });
});
